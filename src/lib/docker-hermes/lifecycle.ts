import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { aiApps, bots } from '@/db/schema';
import { loadPrincipal } from '@/lib/auth/groups';
import { getSetting } from '@/lib/settings';
import { dockerControl } from './client';
import { assertDockerCreate, dockerAllowed, isDockerHermes } from './policy';
import { pairDockerBot } from './store';
import { cleanupDockerEnrollment, lockDockerOwner, pendingDockerCleanup } from './enrollment';
import type { DockerStatus } from '@/docker-hermes/types';
/** Trusted worker only. Fresh database permission is required for every lease, never an environment fallback. */
export async function reconcileDockerRuntimes() {
  // Pending revocations are retried even if configuration is currently missing or owners listing fails.
  for (const { userId } of await pendingDockerCleanup()) await cleanupDockerEnrollment(userId);
  if (!process.env.DOCKER_HERMES_SOCKET) return;
  const owners = await dockerControl<string[]>('worker', '/admin/owners');
  for (const owner of owners) {
    try {
      const result = await db.transaction(async tx => {
        await lockDockerOwner(tx, owner);
        const p = await loadPrincipal(owner, tx);
        if (!p || !await dockerAllowed(p, tx)) { await dockerControl(owner, '/control/revoke', {}); return null; }
        const assigned = await tx.select({ bot: bots, app: aiApps }).from(bots).innerJoin(aiApps, eq(aiApps.id, bots.appId)).where(eq(bots.ownerId, owner));
        if (assigned.some(({ bot, app }) => isDockerHermes(app) && (!bot.enabled || !app.enabled || bot.visibility !== 'private' || bot.executionMode !== 'caller' || bot.coordinatorEligible))) {
          await dockerControl(owner, '/control/revoke', {}); return null;
        }
        let canCreate = true;
        try { await assertDockerCreate(p, await getSetting('tools', tx), tx); } catch { canCreate = false; }
        await dockerControl(owner, '/control/lease', { canCreate });
        return { p, canCreate };
      });
      if (!result) continue;
      const status = await dockerControl<DockerStatus>(owner, '/control/status');
      if (result.canCreate && status.phase === 'ready') for (const b of status.bindings) await pairDockerBot(result.p, b);
    } catch {
      // A failed owner or database authorization cannot retain a new lease or block cleanup of other owners.
      await dockerControl(owner, '/control/revoke', {}).catch(() => {});
    }
  }
}
