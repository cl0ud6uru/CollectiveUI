import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { aiApps, bots } from '@/db/schema';
import { loadPrincipal } from '@/lib/auth/groups';
import { getSetting } from '@/lib/settings';
import { dockerControl } from './client';
import { assertDockerCreate, dockerAllowed, isDockerHermes } from './policy';
import { pairDockerBot } from './store';
import { cleanupDockerEnrollment, isOwnerLockBusy, lockDockerOwner, pendingDockerCleanup } from './enrollment';
import type { DockerStatus } from '@/docker-hermes/types';
let cleanupCursor = 0;
// Leases last 60s and renew every 15s. A per-owner lock wait is bounded so one busy owner cannot delay the whole tick.
const OWNER_LOCK_WAIT_MS = 2000;
/** A busy owner is skipped this tick (its state is unchanged and retried next tick); other errors still surface. */
const retryCleanup = (id: string) => cleanupDockerEnrollment(id, OWNER_LOCK_WAIT_MS).catch(e => { if (!isOwnerLockBusy(e)) throw e; });
/** Trusted worker only. Fresh database permission is required for every lease, never an environment fallback. */
export async function reconcileDockerRuntimes() {
  // Pending revocations are retried even if configuration is currently missing or owners listing fails.
  const pending = new Set((await pendingDockerCleanup()).map(row => row.userId));
  const pendingOwners = [...pending].sort();
  const batch = Array.from({ length: Math.min(2, pendingOwners.length) }, (_, i) => pendingOwners[(cleanupCursor + i) % pendingOwners.length]);
  cleanupCursor = pendingOwners.length ? (cleanupCursor + batch.length) % pendingOwners.length : 0;
  if (!process.env.DOCKER_HERMES_SOCKET) { await Promise.all(batch.map(retryCleanup)); return; }
  const owners = await dockerControl<string[]>('worker', '/admin/owners', undefined, 3000).catch(() => []);
  // Start healthy checks before at most two short cleanup polls; reserve pool capacity for web/admin.
  const active = owners.filter(owner => !pending.has(owner)).map(async owner => {
    try {
      const result = await db.transaction(async tx => {
        // A lock timeout leaves this transaction before any decision: no lease and no revoke for a busy owner.
        await lockDockerOwner(tx, owner, OWNER_LOCK_WAIT_MS);
        try {
          const p = await loadPrincipal(owner, tx);
          if (!p || !await dockerAllowed(p, tx)) { await dockerControl(owner, '/control/revoke', {}, 3000); return null; }
          const assigned = await tx.select({ bot: bots, app: aiApps }).from(bots).innerJoin(aiApps, eq(aiApps.id, bots.appId)).where(eq(bots.ownerId, owner));
          if (assigned.some(({ bot, app }) => isDockerHermes(app) && (!bot.enabled || !app.enabled || bot.visibility !== 'private' || bot.executionMode !== 'caller' || bot.coordinatorEligible))) {
            await dockerControl(owner, '/control/revoke', {}, 3000); return null;
          }
          let canCreate = true;
          try { await assertDockerCreate(p, await getSetting('tools', tx), tx); } catch { canCreate = false; }
          await dockerControl(owner, '/control/lease', { canCreate }, 3000);
          return { p, canCreate };
        } catch {
          // Cleanup of a failed authorization/lease must finish under the same lock.
          await dockerControl(owner, '/control/revoke', {}, 3000).catch(() => {});
          return null;
        }
      });
      if (!result) return;
      const status = await dockerControl<DockerStatus>(owner, '/control/status', undefined, 3000);
      if (result.canCreate && status.phase === 'ready') for (const b of status.bindings) await pairDockerBot(result.p, b, OWNER_LOCK_WAIT_MS);
    } catch {
      // A delayed status/pairing result cannot revoke a newer enrollment or lease.
      // A failed transaction acquires no fresh authority; its prior lease expires closed.
      // Pairing rechecks enrollment itself, and the next tick retries status/publication.
    }
  });
  await Promise.all([...active, ...batch.map(retryCleanup)]);
}
