import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '@/db';
import { auditLog, dockerHermesEnrollments, users } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { ownerId } from '@/docker-hermes/types';
import { dockerControl } from './client';

export async function lockDockerOwner(tx: Tx, id: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`docker-hermes:${id}`}))`);
}
export async function freshEnrollmentAdmin(p: Principal, tx: Tx) {
  const fresh = await loadPrincipal(p.user.id, tx);
  if (!fresh?.isAdmin || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Admin only');
}
/** Commit denial and audit before broker cleanup. No grant ever provisions a runtime. */
export async function setDockerEnrollment(p: Principal, id: string, enabled: boolean) {
  ownerId.parse(id);
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'Invalid enrollment');
  await db.transaction(async tx => {
    await lockDockerOwner(tx, id);
    await freshEnrollmentAdmin(p, tx);
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for('share');
    if (!user) throw new HttpError(404, 'User not found');
    const [prior] = await tx.select().from(dockerHermesEnrollments).where(eq(dockerHermesEnrollments.userId, id));
    if (enabled && prior && !['none', 'stopped'].includes(prior.cleanup))
      throw new HttpError(409, 'Confirm the retained runtime has stopped before allowing access again. Retry cleanup.');
    if (prior?.enabled === enabled) return;
    const values = { enabled, cleanup: enabled ? 'none' as const : 'pending' as const, error: null, changedBy: p.user.id, updatedAt: new Date() };
    await tx.insert(dockerHermesEnrollments).values({ userId: id, ...values }).onConflictDoUpdate({ target: dockerHermesEnrollments.userId, set: values });
    await tx.insert(auditLog).values({ actorId: p.user.id, action: enabled ? 'hermes.docker.enroll' : 'hermes.docker.revoke', target: id, details: { enabled } });
  });
  if (!enabled) await cleanupDockerEnrollment(id);
}
/** Worker/admin retry path. Serializes with leases and re-enrollment, retaining all ownership/data. */
export async function cleanupDockerEnrollment(id: string) {
  return db.transaction(async tx => {
    await lockDockerOwner(tx, id);
    const [row] = await tx.select().from(dockerHermesEnrollments).where(eq(dockerHermesEnrollments.userId, id));
    if (row?.enabled || row?.cleanup === 'stopped') return;
    if (row) await tx.update(dockerHermesEnrollments).set({ cleanup: 'stopping', error: null }).where(eq(dockerHermesEnrollments.userId, id));
    try {
      await dockerControl(id, '/control/revoke', {});
      if (row) await tx.update(dockerHermesEnrollments).set({ cleanup: 'stopped', error: null }).where(eq(dockerHermesEnrollments.userId, id));
    } catch {
      if (row) await tx.update(dockerHermesEnrollments).set({ cleanup: 'failed', error: 'Runtime stop is unconfirmed. Access is denied; the worker will retry. Ask the operator to check broker availability.' }).where(eq(dockerHermesEnrollments.userId, id));
    }
  });
}
export async function pendingDockerCleanup() {
  return db.select({ userId: dockerHermesEnrollments.userId }).from(dockerHermesEnrollments)
    .where(and(eq(dockerHermesEnrollments.enabled, false), inArray(dockerHermesEnrollments.cleanup, ['pending', 'stopping', 'failed'])));
}
export type DockerReadiness = { status: 'not-configured' | 'unavailable' | 'ready'; message: string };
export async function dockerBrokerReadiness(): Promise<DockerReadiness> {
  if (!process.env.DOCKER_HERMES_SOCKET) return { status: 'not-configured', message: 'An operator must configure the protected broker socket in web and worker, pinned image, storage, resource limits and network policy.' };
  try {
    const result = await dockerControl<{ ready: boolean }>('admin', '/admin/ready', undefined, 3000);
    if (result.ready !== true) throw new Error('Unexpected broker response');
    return { status: 'ready', message: 'The web app can reach the broker. The worker must also be configured and running. Runtime setup and provider authentication are checked separately when the user enables Hermes.' };
  } catch { return { status: 'unavailable', message: 'The broker is unavailable or incompatible. An operator must check its protected socket, service and worker configuration. Enrollment does not start a runtime.' }; }
}
