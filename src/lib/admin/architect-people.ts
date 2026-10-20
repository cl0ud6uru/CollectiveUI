import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, type DB, type Tx } from "@/db";
import { groups, users } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { auditVia } from "@/lib/audit";
import { lockArchitectActor, authorizeArchitectCall } from "@/lib/agent/tools/admin-guard";
import type { AgentCtx } from "@/lib/agent/types";
import { changeUserAccess, lockAccounts } from "@/lib/auth/local";
import { withWorkspaceUserLock } from "@/lib/workspaces/locks";
import { onUserDisabledLocked, onUserEnabledLocked } from "@/lib/sandbox/lifecycle";
import { invalidateChatGPTConnection } from "@/lib/llm/chatgpt/invalidation";
import { teamBotsEnabled } from "@/lib/hermes-team/policy";

const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();
const via = (ctx: AgentCtx) => ({ agent: "architect" as const, botId: ctx.bot!.id });

async function prepareWrite(ctx: AgentCtx, tx: Tx): Promise<Principal> {
  await lockArchitectActor(ctx, tx);
  const fresh = await authorizeArchitectCall(ctx, tx);
  if (!fresh.isAdmin) throw new HttpError(403, "Admin tools are for administrators only.");
  return fresh;
}

export const architectUserDisabledInput = z.object({
  userId: z.string().min(1).max(128), expectedSessionVersion: z.number().int().min(0), disabled: z.boolean(),
}).strict();

type UserLock = <T>(userId: string, run: (database: DB) => Promise<T>) => Promise<T>;

/** Reuses the account lifecycle core, including self/last-local-admin fences and post-commit cleanup. */
export async function setArchitectUserDisabled(
  ctx: AgentCtx,
  _actor: Principal,
  raw: unknown,
  signal?: AbortSignal,
  ownerLock: UserLock = withWorkspaceUserLock,
) {
  const input = architectUserDisabledInput.parse(raw);
  return ownerLock(input.userId, async lockedDb => {
    const result = await lockedDb.transaction(async tx => {
      // Keep the shared access-mutation lock order: account lock, Team bot locks, then actor/target rows.
      // changeUserAccess reacquires these transaction-scoped locks before its own checks and update.
      await lockAccounts(tx);
      if (teamBotsEnabled()) {
        const team = await import("@/lib/hermes-team/revocation");
        await team.lockTeamAccessBots(tx);
      }
      const fresh = await prepareWrite(ctx, tx);
      const [target] = await tx.select().from(users).where(eq(users.id, input.userId)).for("update");
      if (!target) throw new HttpError(404, "User not found.");
      if (target.sessionVersion !== input.expectedSessionVersion)
        throw new HttpError(409, "User access changed. Read it again and request fresh approval.");
      if (target.disabled === input.disabled) throw new HttpError(409, "The user already has that access state.");
      checkAbort(signal);

      const teamBotIds = await changeUserAccess(fresh.user, target.id, { disabled: input.disabled }, {
        database: tx, deferTeamReconciliation: true, expectedSessionVersion: input.expectedSessionVersion, signal,
      });
      const revokeChatGPT = input.disabled ? await invalidateChatGPTConnection(target.id, tx) : null;
      checkAbort(signal);
      const [saved] = await tx.select({ id: users.id, name: users.name, email: users.email, disabled: users.disabled, sessionVersion: users.sessionVersion })
        .from(users).where(eq(users.id, target.id));
      if (!saved || saved.disabled !== input.disabled || saved.sessionVersion !== input.expectedSessionVersion + 1)
        throw new HttpError(409, "User access change could not be verified.");
      await auditVia(fresh.user.id, via(ctx), input.disabled ? "architect.user.disable" : "architect.user.enable", saved.id,
        { disabled: saved.disabled, sessionVersion: saved.sessionVersion }, tx);
      checkAbort(signal);
      return { saved, revokeChatGPT, teamBotIds };
    });

    // Follow the same account lifecycle path as the Admin UI after the owner lock is acquired.
    if (result.saved.disabled) await onUserDisabledLocked(result.saved.id, ctx.principal.user.id, lockedDb);
    else await onUserEnabledLocked(result.saved.id, lockedDb);
    if (result.revokeChatGPT) await result.revokeChatGPT();
    if (result.teamBotIds.length) {
      const { reconcileTeamAccess } = await import("@/lib/hermes-team/revocation");
      for (const botId of result.teamBotIds) await reconcileTeamAccess(botId);
    }
    return { status: "verified" as const, user: result.saved };
  });
}

export function groupRevision(row: { id: string; name: string; description: string | null; isAdmin: boolean; canCreateBots: boolean; createdAt: Date }) {
  return createHash("sha256").update(JSON.stringify([row.id, row.name, row.description, row.isAdmin, row.canCreateBots, row.createdAt.toISOString()])).digest("hex");
}

export const architectGroupProfileInput = z.object({
  groupId: z.string().min(1).max(128), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).nullable().optional(),
}).strict().refine(input => input.name !== undefined || input.description !== undefined, "Choose a group name or description to update.");

export async function updateArchitectGroupProfile(ctx: AgentCtx, _actor: Principal, raw: unknown, signal?: AbortSignal) {
  const input = architectGroupProfileInput.parse(raw);
  try {
    return await db.transaction(async tx => {
      const fresh = await prepareWrite(ctx, tx);
      const [current] = await tx.select().from(groups).where(eq(groups.id, input.groupId)).for("update");
      if (!current) throw new HttpError(404, "Group not found.");
      if (groupRevision(current) !== input.expectedRevision) throw new HttpError(409, "Group changed. Read it again and request fresh approval.");
      const next = { name: input.name ?? current.name, description: input.description === undefined ? current.description : input.description };
      if (next.name === current.name && next.description === current.description) throw new HttpError(400, "The group profile is already up to date.");
      checkAbort(signal);
      const [saved] = await tx.update(groups).set(next).where(and(eq(groups.id, current.id), eq(groups.name, current.name),
        current.description === null ? isNull(groups.description) : eq(groups.description, current.description))).returning();
      if (!saved) throw new HttpError(409, "Group changed. Read it again and request fresh approval.");
      const [readback] = await tx.select().from(groups).where(eq(groups.id, current.id));
      if (!readback || readback.name !== next.name || readback.description !== next.description || readback.isAdmin !== current.isAdmin || readback.canCreateBots !== current.canCreateBots)
        throw new HttpError(409, "Group update could not be verified.");
      checkAbort(signal);
      await auditVia(fresh.user.id, via(ctx), "architect.group.profile.update", readback.id,
        { fields: Object.keys(input).filter(key => key !== "groupId" && key !== "expectedRevision"), name: readback.name }, tx);
      checkAbort(signal);
      return { status: "verified" as const, group: { id: readback.id, name: readback.name, description: readback.description,
        isAdmin: readback.isAdmin, canCreateBots: readback.canCreateBots, revision: groupRevision(readback) } };
    });
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    if (e.code === "23505" || e.cause?.code === "23505") throw new HttpError(409, "That group name is already in use.");
    throw err;
  }
}
