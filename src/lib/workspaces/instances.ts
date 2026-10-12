import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, type DB, type Tx } from "@/db";
import { sandboxes, users, workspaceBotBindings, workspaceInstances, workspaceTemplateVersions, workspaceTemplates } from "@/db/schema";
import { getUsableBot, HttpError } from "@/lib/authz";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { getSetting } from "@/lib/settings";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { SandboxError, sandboxd } from "@/lib/sandbox/client";
import { ensureLegacyInstance, findSandbox, getOrCreateRef, touchWorkspaceInstance } from "@/lib/sandbox/store";
import { newId } from "@/lib/ids";
import { withWorkspaceUserLock } from "./locks";
import type { ResolvedWorkspace, WorkspaceInstanceView } from "./contracts";
import { admitWorkspaceRecipe, WorkspaceRecipePolicyError } from "./instance-policy";

async function assertWorkspaceAccess(principal: Principal) {
  const settings = await getSetting("sandbox");
  if (!userMayUseWorkspace(principal, settings)) throw new HttpError(403, "Workspace access is unavailable");
  return settings;
}

async function freshPrincipalForAssignment(tx: Tx, original: Principal): Promise<Principal> {
  const [current] = await tx.select({ disabled: users.disabled, sessionVersion: users.sessionVersion })
    .from(users).where(eq(users.id, original.user.id)).for("update");
  if (!current || current.disabled || current.sessionVersion !== original.user.sessionVersion) {
    throw new HttpError(401, "Your account or session changed. Sign in again before assigning a workspace.");
  }
  const principal = await loadPrincipal(original.user.id, tx);
  if (!principal || principal.user.sessionVersion !== original.user.sessionVersion) {
    throw new HttpError(401, "Your account or session changed. Sign in again before assigning a workspace.");
  }
  return principal;
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
    if (instance.provisionState === "provisioning") throw new HttpError(409, "This bot's private workspace is still starting. Try again shortly.");
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
 * Creates/reuses a private instance for an explicit bot/version selection. A reservation and provisional binding
 * commit before sandboxd creates the volume; failure restores a previous binding and keeps the volume registered.
 */
export async function assignTemplate(input: {
  principal: Principal;
  botId: string;
  templateVersionId: string;
}): Promise<WorkspaceInstanceView> {
  const settings = await getSetting("sandbox");
  const client = sandboxd();
  if (!client) throw new HttpError(503, "Workspace service is unavailable");
  const userId = input.principal.user.id;
  return withWorkspaceUserLock(userId, async (lockedDb: DB) => {
    const reservation = await lockedDb.transaction(async (tx) => {
      const principal = await freshPrincipalForAssignment(tx, input.principal);
      if (!userMayUseWorkspace(principal, settings)) throw new HttpError(403, "Workspace access is unavailable");
      await getUsableBot(principal, input.botId, tx);

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
      if (current && current.provisionState === "provisioning" && !currentIsSame) {
        throw new HttpError(409, "Another workspace version is still starting for this bot.");
      }
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

      // Only the currently bound same-version instance is reused. A new reservation and its binding commit before
      // sandboxd creates a volume, so concurrent cleanup always sees authoritative owner/ref registration.
      const isExistingBinding = !!(currentIsSame && current);
      const row = isExistingBinding ? current! : (await tx.insert(workspaceInstances).values({
        id: newId(),
        ownerUserId: userId,
        templateVersionId: version.id,
        origin: "template",
        sandboxRef: newRef(),
        runtimeProfileKey: admitted.profile.key,
        provisionState: "provisioning",
        deleteAfter: null,
      }).returning())[0];
      if (isExistingBinding) {
        await tx.update(workspaceInstances).set({ provisionState: "provisioning", deleteAfter: null })
          .where(and(eq(workspaceInstances.ownerUserId, userId), eq(workspaceInstances.id, row.id)));
      }
      if (!binding || binding.instanceId !== row.id) {
        await tx.insert(workspaceBotBindings).values({ userId, botId: input.botId, instanceId: row.id })
          .onConflictDoUpdate({
            target: [workspaceBotBindings.userId, workspaceBotBindings.botId],
            set: { instanceId: row.id, updatedAt: new Date() },
          });
      }
      return {
        row,
        previousInstanceId: binding?.instanceId ?? null,
        isExistingBinding,
        templateName: version.templateName,
      };
    });

    let startError: unknown = null;
    try {
      await client.start(reservation.row.sandboxRef, requiredIsolation(settings), reservation.row.runtimeProfileKey);
    } catch (err) {
      startError = err;
    }

    const latestSettings = await getSetting("sandbox");
    const finalized = await lockedDb.transaction(async (tx) => {
      let failure = startError;
      try {
        const principal = await freshPrincipalForAssignment(tx, input.principal);
        if (!userMayUseWorkspace(principal, latestSettings)) throw new HttpError(403, "Workspace access is unavailable");
        await getUsableBot(principal, input.botId, tx);
      } catch (err) {
        failure ??= err;
      }

      const [binding] = await tx.select({ instanceId: workspaceBotBindings.instanceId })
        .from(workspaceBotBindings)
        .where(and(eq(workspaceBotBindings.userId, userId), eq(workspaceBotBindings.botId, input.botId)));
      if (!binding || binding.instanceId !== reservation.row.id) {
        failure ??= new HttpError(409, "The workspace assignment changed while it was starting.");
      }

      if (failure) {
        await tx.update(workspaceInstances).set({ provisionState: "unavailable" }).where(and(
          eq(workspaceInstances.ownerUserId, userId),
          eq(workspaceInstances.id, reservation.row.id),
        ));
        if (!reservation.isExistingBinding && binding?.instanceId === reservation.row.id) {
          if (reservation.previousInstanceId) {
            await tx.update(workspaceBotBindings).set({ instanceId: reservation.previousInstanceId, updatedAt: new Date() })
              .where(and(eq(workspaceBotBindings.userId, userId), eq(workspaceBotBindings.botId, input.botId)));
          } else {
            await tx.delete(workspaceBotBindings).where(and(eq(workspaceBotBindings.userId, userId), eq(workspaceBotBindings.botId, input.botId)));
          }
        }
        const [account] = await tx.select({ disabled: users.disabled }).from(users).where(eq(users.id, userId));
        if (account?.disabled) {
          const deadline = new Date(Date.now() + latestSettings.deleteAfterDays * 86_400_000);
          await tx.update(workspaceInstances).set({ deleteAfter: deadline }).where(eq(workspaceInstances.ownerUserId, userId));
          await tx.update(sandboxes).set({ deleteAfter: deadline }).where(eq(sandboxes.userId, userId));
        }
        return { ok: false as const, error: failure };
      }

      const [ready] = await tx.update(workspaceInstances).set({ provisionState: "ready", lastUsedAt: new Date() }).where(and(
        eq(workspaceInstances.ownerUserId, userId),
        eq(workspaceInstances.id, reservation.row.id),
      )).returning();
      if (!ready) return { ok: false as const, error: new HttpError(409, "The reserved workspace is no longer available.") };
      return {
        ok: true as const,
        instance: view({ ...ready, templateName: reservation.templateName }),
        instanceId: ready.id,
      };
    });

    if (!finalized.ok) {
      await client.stop(reservation.row.sandboxRef).catch(() => {});
      throw finalized.error;
    }
    await touchWorkspaceInstance(finalized.instanceId, userId, lockedDb);
    return finalized.instance;
  });
}

function newRef(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
