import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceBotBindings, workspaceInstances } from "@/db/schema";
import { getUsableBot, HttpError } from "@/lib/authz";
import type { Principal } from "@/lib/auth/groups";
import { getSetting } from "@/lib/settings";
import { userMayUseWorkspace } from "@/lib/sandbox/policy";
import { ensureLegacyInstance, findSandbox, getOrCreateRef } from "@/lib/sandbox/store";
import type { ResolvedWorkspace } from "./contracts";

async function assertWorkspaceAccess(principal: Principal) {
  const settings = await getSetting("sandbox");
  if (!userMayUseWorkspace(principal, settings)) throw new HttpError(403, "Workspace access is unavailable");
  return settings;
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

/**
 * Read-only resolution never creates an instance or starts a daemon container. Kept worker-safe because the
 * standalone agent worker shares this read path outside Next's server-only import condition.
 */
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
    if (instance.provisionState === "unavailable") throw new HttpError(503, "This bot's private workspace is unavailable. Reassign its template to try again.");
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

export { assertWorkspaceAccess };
