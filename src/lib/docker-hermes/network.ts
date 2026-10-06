import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '@/db';
import { auditLog, dockerHermesEnrollments, users } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { getSetting } from '@/lib/settings';
import { networkRequest, type NetworkMode, type NetworkStatus } from '@/docker-hermes/network';
import { ownerId } from '@/docker-hermes/types';
import { freshEnrollmentAdmin, lockDockerOwner } from './enrollment';
import { assertDockerCreate } from './policy';
import { dockerControl } from './client';

export type DockerNetworks = { defaultMode: NetworkMode; owners: Record<string, NetworkStatus> };
export async function getDockerNetworks(p: Principal) {
  await db.transaction(tx => freshEnrollmentAdmin(p, tx));
  return dockerControl<DockerNetworks>('admin', '/admin/networks', undefined, 15000);
}
async function target(p: Principal, id: string, tx: Tx) {
  await freshEnrollmentAdmin(p, tx);
  const [row] = await tx.select({ disabled: users.disabled }).from(users).where(eq(users.id, id)).for('share');
  if (!row) throw new HttpError(404, 'User not found.');
  if (row.disabled) throw new HttpError(403, 'This user is disabled.');
  const [enrollment] = await tx.select().from(dockerHermesEnrollments).where(eq(dockerHermesEnrollments.userId, id));
  if (!enrollment?.enabled || enrollment.cleanup !== 'none') throw new HttpError(409, 'Allow personal Hermes and finish cleanup before changing network access.');
}
/** Commit a reviewable audit intent first. Recheck fresh Admin/session/enrollment before short asynchronous dispatch. */
export async function requestDockerNetwork(p: Principal, id: string, raw: unknown) {
  ownerId.parse(id); const request = networkRequest.parse(raw);
  const audit = await db.transaction(async tx => {
    await lockDockerOwner(tx, id, 3000); await target(p, id, tx);
    const [prior] = await tx.select().from(auditLog).where(and(eq(auditLog.action, 'hermes.docker.network.request'), eq(auditLog.target, id), sql`${auditLog.details}->>'requestId' = ${request.requestId}`));
    if (prior) {
      const details = prior.details as { mode?: unknown; revision?: unknown } | null;
      if (prior.actorId !== p.user.id || details?.mode !== request.mode || details?.revision !== request.revision)
        throw new HttpError(409, 'This network request already has different details.');
      return prior.id;
    }
    const status = await dockerControl<NetworkStatus>(id, '/control/network', undefined, 5000);
    if (status.revision !== request.revision) throw new HttpError(409, 'Network policy changed. Reload before applying it.');
    const [inserted] = await tx.insert(auditLog).values({ actorId: p.user.id, action: 'hermes.docker.network.request', target: id,
      details: { requestId: request.requestId, mode: request.mode, revision: request.revision, previous: status.mode, status: 'requested', confirmedRestart: true } }).returning({ id: auditLog.id });
    return inserted.id;
  });
  const result = await db.transaction(async tx => {
    await lockDockerOwner(tx, id, 3000); await target(p, id, tx);
    const fresh = await loadPrincipal(id, tx);
    if (!fresh) throw new HttpError(403, 'User access changed.');
    let canCreate = true;
    try { await assertDockerCreate(fresh, await getSetting('tools', tx), tx); }
    catch (e) { if (!(e instanceof HttpError) || e.status !== 403) throw e; canCreate = false; }
    await dockerControl(id, '/control/lease', { canCreate }, 3000);
    return dockerControl<NetworkStatus>(id, '/control/network', { actor: p.user.id, request }, 5000);
  });
  // "Accepted" describes the broker receipt, not successful completion of the migration.
  await db.update(auditLog).set({ details: { requestId: request.requestId, mode: request.mode, revision: request.revision, status: 'accepted', confirmedRestart: true } }).where(eq(auditLog.id, audit));
  return result;
}
