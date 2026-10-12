import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { workspaceBotBindings, workspaceInstances, workspaceTemplateVersions, workspaceTemplates } from "@/db/schema";
import { getUsableBot, HttpError } from "@/lib/authz";
import type { Principal } from "@/lib/auth/groups";
import { getSetting } from "@/lib/settings";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { SandboxError, sandboxd } from "@/lib/sandbox/client";
import { ensureLegacyInstance, findSandbox, getOrCreateRef, touchWorkspaceInstance } from "@/lib/sandbox/store";
import { newId } from "@/lib/ids";
import type { ResolvedWorkspace, WorkspaceInstanceView } from "./contracts";
import { admitWorkspaceRecipe, WorkspaceRecipePolicyError } from "./instance-policy";

async function assertWorkspaceAccess(principal: Principal) {
  const settings = await getSetting("sandbox");
  if (!userMayUseWorkspace(principal, settings)) throw new HttpError(403, "Workspace access is unavailable");
  return settings;
}

function view(row: { id: string; templateVersionId: string | null; templateName: string | null; origin: "legacy_personal" | "template"; provisionState: WorkspaceInstanceView["state"] }): WorkspaceInstanceView {
  return {
    id: row.id,
    templateVersionId: row.templateVersionId,
    templateName: row.templateName,
    origin: row.origin,
    state: row.provisionState,
  };
}

function resolved(row: { id: string; ownerUserId: string; templateVersionId: string | null; sandboxRef: string; runtimeProfileKey: string }, botId: string): ResolvedWorkspace {
  return {
    instanceId: row.id,
    ownerUserId: row.ownerUserId,
    botId,
    templateVersionId: row.templateVersionId,
    sandboxRef: row.sandboxRef,
    runtimeProfileKey: row.runtimeProfileKey,
    workspaceRoot: "/home/agent/workspace",
  };
}

/** Read-only resolution never creates an instance or starts a daemon container. */
export async function resolveWorkspace(input: {
  principal: Principal;
  botId: string;
  createIfMissing: boolean;
}): Promise<ResolvedWorkspace | null> {
  await assertWorkspaceAccess(input.principal);
  await getUsableBot(input.principal, input.botId);
  const userId = input.principal.user.id;
  const [binding] = await db.select({ instanceId: workspaceBotBindings.instanceId })
    .from(workspaceBotBindings)
    .where(and(eq(workspaceBotBindings.userId, userId), eq(workspaceBotBindings.botId, input.botId)));
  if (binding) {
    const [instance] = await db.select().from(workspaceInstances).where(and(
      eq(workspaceInstances.id, binding.instanceId),
      eq(workspaceInstances.ownerUserId, userId),
    ));
    if (!instance) throw new HttpError(409, "This bot's private workspace is unavailable. Reassign a template to continue.");
    return resolved(instance, input.botId);
  }

  let legacy = await ensureLegacyInstance(userId);
  if (!legacy && input.createIfMissing) {
    const ref = await getOrCreateRef(userId);
    legacy = await ensureLegacyInstance(userId, ref);
  }
  if (!legacy) {
    const sandbox = await findSandbox(userId);
    if (!sandbox) return null;
    legacy = await ensureLegacyInstance(userId, sandbox.ref);
  }
  return legacy ? resolved(legacy, input.botId) : null;
}

/** Only this user's safe DTOs leave the server. The ref and runtime profile never enter the response. */
export async function listOwnInstances(principal: Principal): Promise<WorkspaceInstanceView[]> {
  await assertWorkspaceAccess(principal);
  const rows = await db.select({
    id: workspaceInstances.id,
    templateVersionId: workspaceInstances.templateVersionId,
    templateName: workspaceTemplates.name,
    origin: workspaceInstances.origin,
    provisionState: workspaceInstances.provisionState,
  }).from(workspaceInstances)
    .leftJoin(workspaceTemplateVersions, eq(workspaceTemplateVersions.id, workspaceInstances.templateVersionId))
    .leftJoin(workspaceTemplates, eq(workspaceTemplates.id, workspaceTemplateVersions.templateId))
    .where(eq(workspaceInstances.ownerUserId, principal.user.id))
    .orderBy(desc(workspaceInstances.createdAt));
  return rows.map(view);
}

/**
 * Creates/reuses a private instance for an explicit bot/version selection. The bot binding changes only after
 * sandboxd confirms the allowlisted image is available and the instance starts; a failed replacement leaves the
 * previous binding untouched.
 */
export async function assignTemplate(input: {
  principal: Principal;
  botId: string;
  templateVersionId: string;
}): Promise<WorkspaceInstanceView> {
  const settings = await assertWorkspaceAccess(input.principal);
  const client = sandboxd();
  if (!client) throw new HttpError(503, "Workspace service is unavailable");
  const userId = input.principal.user.id;
  const result = await db.transaction(async (tx): Promise<
    | { ok: true; instance: WorkspaceInstanceView; instanceId: string }
    | { ok: false; error: unknown }
  > => {
    // Hold the per-actor/bot lock through provisioning. A concurrent same-version request then sees and reuses the
    // committed binding; a different bot always gets a separate ref, even for the same template version.
    const lockKey = JSON.stringify([userId, input.botId]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await getUsableBot(input.principal, input.botId, tx);

    const [binding] = await tx.select({ instanceId: workspaceBotBindings.instanceId })
      .from(workspaceBotBindings)
      .where(and(eq(workspaceBotBindings.userId, userId), eq(workspaceBotBindings.botId, input.botId)));
    const [current] = binding
      ? await tx.select().from(workspaceInstances).where(and(
          eq(workspaceInstances.id, binding.instanceId),
          eq(workspaceInstances.ownerUserId, userId),
        ))
      : [];
    const currentIsSame = current?.templateVersionId === input.templateVersionId;
    const [version] = await tx.select({
      id: workspaceTemplateVersions.id,
      recipe: workspaceTemplateVersions.recipe,
      publishedAt: workspaceTemplateVersions.publishedAt,
      retiredAt: workspaceTemplateVersions.retiredAt,
      templateName: workspaceTemplates.name,
    }).from(workspaceTemplateVersions)
      .innerJoin(workspaceTemplates, eq(workspaceTemplates.id, workspaceTemplateVersions.templateId))
      .where(eq(workspaceTemplateVersions.id, input.templateVersionId));
    if (!version || !version.publishedAt || (version.retiredAt && !currentIsSame)) {
      throw new HttpError(404, "That published workspace template is unavailable.");
    }
    let admitted: ReturnType<typeof admitWorkspaceRecipe>;
    try { admitted = admitWorkspaceRecipe(version.recipe); }
    catch (err) {
      if (err instanceof WorkspaceRecipePolicyError && err.code === "image_missing") throw new SandboxError("image_missing", err.message);
      if (err instanceof WorkspaceRecipePolicyError) throw new HttpError(409, err.message);
      throw err;
    }
    if (currentIsSame && current && current.runtimeProfileKey !== admitted.profile.key) {
      throw new HttpError(409, "This private workspace no longer matches its pinned template recipe.");
    }

    // Only the currently bound same-version instance is reused. Unbound historical instances remain intact and
    // cannot accidentally be claimed by a different bot owned by the same person.
    const row = currentIsSame && current ? current : (await tx.insert(workspaceInstances).values({
      id: newId(),
      ownerUserId: userId,
      templateVersionId: version.id,
      origin: "template",
      sandboxRef: newRef(),
      runtimeProfileKey: admitted.profile.key,
      provisionState: "provisioning",
      deleteAfter: null,
    }).returning())[0];
    await tx.update(workspaceInstances).set({ provisionState: "provisioning", deleteAfter: null })
      .where(and(eq(workspaceInstances.ownerUserId, userId), eq(workspaceInstances.id, row.id)));

    let failure: unknown = null;
    try {
      await client.start(row.sandboxRef, requiredIsolation(settings), row.runtimeProfileKey);
      // Access may have been revoked while the container was starting; don't commit a stale bot binding.
      await getUsableBot(input.principal, input.botId, tx);
    } catch (err) {
      failure = err;
      if (!(err instanceof SandboxError)) await client.stop(row.sandboxRef).catch(() => {});
    }
    if (failure) {
      await tx.update(workspaceInstances).set({ provisionState: "unavailable" }).where(and(
        eq(workspaceInstances.ownerUserId, userId),
        eq(workspaceInstances.id, row.id),
      ));
      return { ok: false, error: failure };
    }

    await tx.update(workspaceInstances).set({ provisionState: "ready", lastUsedAt: new Date(), deleteAfter: null })
      .where(and(eq(workspaceInstances.ownerUserId, userId), eq(workspaceInstances.id, row.id)));
    await tx.insert(workspaceBotBindings).values({ userId, botId: input.botId, instanceId: row.id })
      .onConflictDoUpdate({
        target: [workspaceBotBindings.userId, workspaceBotBindings.botId],
        set: { instanceId: row.id, updatedAt: new Date() },
      });
    return {
      ok: true,
      instanceId: row.id,
      instance: view({ ...row, templateVersionId: version.id, templateName: version.templateName, provisionState: "ready" }),
    };
  });
  if (!result.ok) throw result.error;
  await touchWorkspaceInstance(result.instanceId, userId);
  return result.instance;
}

function newRef(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
