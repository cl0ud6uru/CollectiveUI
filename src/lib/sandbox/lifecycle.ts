import { audit } from "@/lib/audit";
import { getSetting } from "@/lib/settings";
import { sandboxd } from "./client";
import { clearDeleteAfter, expiredSandboxes, findSandbox, forgetSandbox, listSandboxRows, markDeleteAfter } from "./store";

const ORPHAN_AGE_MS = 60 * 60_000;

/**
 * A disabled person's workspace: the deletion date is recorded first (so it happens even if sandboxd is down now),
 * then the container is stopped best-effort. Re-enabling the person cancels the deletion.
 */
export async function onUserDisabled(userId: string, actorId: string) {
  const row = await findSandbox(userId);
  if (!row) return;
  await markDeleteAfter(userId, (await getSetting("sandbox")).deleteAfterDays);
  await sandboxd()
    ?.stop(row.ref)
    .catch(async (err) => {
      console.error("[sandbox] couldn't stop a disabled user's workspace", err);
      await audit(actorId, "workspace.stop_failed", userId, { reason: String((err as Error)?.message ?? err).slice(0, 200) });
    });
}

export async function onUserEnabled(userId: string) {
  await clearDeleteAfter(userId);
}

/**
 * Hourly: destroys workspaces past their deletion date, and sandboxes no person owns any more (e.g. the account was
 * deleted). Sandboxes are listed before the table is read, so one created meanwhile is never mistaken for an orphan.
 */
export async function sweepSandboxes(now = new Date()): Promise<{ expired: number; orphans: number }> {
  const client = sandboxd();
  if (!client) return { expired: 0, orphans: 0 };
  let expired = 0;
  for (const row of await expiredSandboxes(now)) {
    try {
      await client.destroy(row.ref);
      await forgetSandbox(row.userId);
      await audit(null, "workspace.destroyed_after_disable", row.userId);
      expired++;
    } catch (err) {
      console.error("[sandbox] couldn't destroy an expired workspace", err);
    }
  }
  const listed = await client.list();
  const known = new Set((await listSandboxRows()).map((r) => r.ref));
  let orphans = 0;
  for (const s of listed) {
    if (known.has(s.ref) || s.activeExecs > 0) continue;
    const created = s.createdAt ? Date.parse(s.createdAt) : 0;
    if (s.state !== "missing" && now.getTime() - created < ORPHAN_AGE_MS) continue;
    try {
      await client.destroy(s.ref);
      orphans++;
    } catch (err) {
      console.error("[sandbox] couldn't remove an orphaned sandbox", err);
    }
  }
  if (orphans) await audit(null, "workspace.orphans_removed", undefined, { count: orphans });
  return { expired, orphans };
}
