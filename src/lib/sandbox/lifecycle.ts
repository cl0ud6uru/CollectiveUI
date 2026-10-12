import { and, eq } from "drizzle-orm";
import type { DB, DbOrTx } from "@/db";
import { sandboxes, users, workspaceInstances } from "@/db/schema";
import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { withWorkspaceUserLock } from "@/lib/workspaces/locks";
import { sandboxd } from "./client";
import {
  clearDeleteAfter,
  ensureLegacyInstance,
  expiredWorkspaceInstances,
  findSandbox,
  forgetWorkspaceInstance,
  listSandboxRows,
  listWorkspaceInstances,
  markDeleteAfter,
} from "./store";

const ORPHAN_AGE_MS = 60 * 60_000;

/** Must be called with the per-owner lock held. Persists retention before stopping, so a daemon outage is safe. */
export async function onUserDisabledLocked(userId: string, actorId: string, lockedDb: DB) {
  const refs = await lockedDb.transaction(async (tx) => {
    const legacy = await findSandbox(userId, tx);
    if (legacy) await ensureLegacyInstance(userId, legacy.ref, tx);
    const instances = await tx.select({ sandboxRef: workspaceInstances.sandboxRef }).from(workspaceInstances)
      .where(eq(workspaceInstances.ownerUserId, userId));
    if (!instances.length) return [];
    await markDeleteAfter(userId, (await getSetting("sandbox", tx)).deleteAfterDays, tx);
    return instances.map((row) => row.sandboxRef);
  });
  const client = sandboxd();
  if (!client) return;
  for (const ref of refs) {
    await client.stop(ref).catch(async (err) => {
      console.error("[sandbox] couldn't stop a disabled user's workspace", err);
      await audit(actorId, "workspace.stop_failed", userId, { reason: String((err as Error)?.message ?? err).slice(0, 200) });
    });
  }
}

/** Disabled people keep their workspaces for the configured retention period; re-enabling cancels the deadline. */
export async function onUserDisabled(userId: string, actorId: string) {
  return withWorkspaceUserLock(userId, (lockedDb) => onUserDisabledLocked(userId, actorId, lockedDb));
}

export async function onUserEnabledLocked(userId: string, lockedDb: DB) {
  await lockedDb.transaction((tx) => clearDeleteAfter(userId, tx));
}

export async function onUserEnabled(userId: string) {
  return withWorkspaceUserLock(userId, (lockedDb) => onUserEnabledLocked(userId, lockedDb));
}

/** Bring retention written by older portal binaries into the additive instance registry. */
async function reconcileRetention(ownerUserId: string, query: DbOrTx, deleteAfterDays: number) {
  const legacy = await findSandbox(ownerUserId, query);
  if (legacy) await ensureLegacyInstance(ownerUserId, legacy.ref, query);
  const instances = await query.select().from(workspaceInstances).where(eq(workspaceInstances.ownerUserId, ownerUserId));
  if (!instances.length) return;
  const [account] = await query.select({ disabled: users.disabled }).from(users).where(eq(users.id, ownerUserId));
  if (!account?.disabled) {
    // Enabled accounts should not retain a deadline left by an older disable/enable flow.
    await clearDeleteAfter(ownerUserId, query);
    return;
  }

  // Preserve an existing legacy deadline, including an already-expired one. If an older binary disabled the
  // account before this registry existed, give every registered ref the same retention deadline.
  const existing = legacy?.deleteAfter ?? instances.map((row) => row.deleteAfter)
    .filter((value): value is Date => value !== null && value !== undefined)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const deadline = existing ?? new Date(Date.now() + deleteAfterDays * 86_400_000);
  await query.update(sandboxes).set({ deleteAfter: deadline }).where(eq(sandboxes.userId, ownerUserId));
  await query.update(workspaceInstances).set({ deleteAfter: deadline }).where(eq(workspaceInstances.ownerUserId, ownerUserId));
}

/**
 * Hourly: destroys workspaces past their retention date and truly unregistered sandboxd volumes.
 * Reservations commit before a volume is created, and the owner lock serializes sweep with assignment and lifecycle.
 */
export async function sweepSandboxes(now = new Date()): Promise<{ expired: number; orphans: number }> {
  const client = sandboxd();
  if (!client) return { expired: 0, orphans: 0 };
  const settings = await getSetting("sandbox");

  // Older binaries update only sandboxes. Reconcile all owners before selecting expired rows, including owners
  // whose template instances were created after the legacy sandbox was registered.
  const sandboxRows = await listSandboxRows();
  const instanceRows = await listWorkspaceInstances();
  const owners = new Set([...sandboxRows.map((row) => row.userId), ...instanceRows.map((row) => row.ownerUserId)]);
  for (const ownerUserId of owners) {
    await withWorkspaceUserLock(ownerUserId, async (lockedDb) => {
      await lockedDb.transaction((tx) => reconcileRetention(ownerUserId, tx, settings.deleteAfterDays));
    });
  }

  let expired = 0;
  for (const candidate of await expiredWorkspaceInstances(now)) {
    await withWorkspaceUserLock(candidate.ownerUserId, async (lockedDb) => {
      try {
        const didExpire = await lockedDb.transaction(async (tx) => {
          // Re-read old-binary retention changes under row locks immediately before destruction. Current portal
          // disable/enable actions share the advisory lock; these row locks also serialize legacy binary updates.
          await tx.select({ id: users.id }).from(users).where(eq(users.id, candidate.ownerUserId)).for("update");
          await tx.select({ userId: sandboxes.userId }).from(sandboxes).where(eq(sandboxes.userId, candidate.ownerUserId)).for("update");
          await tx.select({ id: workspaceInstances.id }).from(workspaceInstances)
            .where(eq(workspaceInstances.ownerUserId, candidate.ownerUserId)).for("update");
          await reconcileRetention(candidate.ownerUserId, tx, settings.deleteAfterDays);
          const [row] = await tx.select().from(workspaceInstances).where(and(
            eq(workspaceInstances.ownerUserId, candidate.ownerUserId),
            eq(workspaceInstances.id, candidate.id),
          ));
          if (!row || !row.deleteAfter || row.deleteAfter > now) return false;
          await client.destroy(row.sandboxRef);
          await forgetWorkspaceInstance(row.ownerUserId, row.id, tx);
          return true;
        });
        if (didExpire) {
          await audit(null, "workspace.destroyed_after_disable", candidate.ownerUserId);
          expired++;
        }
      } catch (err) {
        console.error("[sandbox] couldn't destroy an expired workspace", err);
      }
    });
  }

  // The reservation row is committed before client.start(), so even a volume created after list() is represented
  // when the live registry union is read below.
  const listed = await client.list();
  const [legacyRows, currentInstances] = await Promise.all([listSandboxRows(), listWorkspaceInstances()]);
  const known = new Set([...legacyRows.map((row) => row.ref), ...currentInstances.map((row) => row.sandboxRef)]);
  let orphans = 0;
  for (const state of listed) {
    if (known.has(state.ref) || state.activeExecs > 0) continue;
    const created = state.createdAt ? Date.parse(state.createdAt) : 0;
    if (state.state !== "missing" && now.getTime() - created < ORPHAN_AGE_MS) continue;
    try {
      await client.destroy(state.ref);
      orphans++;
    } catch (err) {
      console.error("[sandbox] couldn't remove an orphaned sandbox", err);
    }
  }
  if (orphans) await audit(null, "workspace.orphans_removed", undefined, { count: orphans });
  return { expired, orphans };
}
