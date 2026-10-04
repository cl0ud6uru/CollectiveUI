import { and, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { dockerHermesEnrollments, users } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
export const isDockerHermes = (app: { provider: string; providerConfig: Record<string, unknown> }) => app.provider === 'hermes' && app.providerConfig.docker !== undefined;
/** Never trust a cached principal or an environment allowlist for enrollment. Database failures deny access. */
export async function dockerAllowed(p: Principal, q: DbOrTx = db) {
  if (p.user.disabled) return false;
  const [row] = await q.select({ enabled: dockerHermesEnrollments.enabled }).from(dockerHermesEnrollments)
    .innerJoin(users, eq(users.id, dockerHermesEnrollments.userId))
    .where(and(eq(users.id, p.user.id), eq(users.disabled, false), eq(users.sessionVersion, p.user.sessionVersion), eq(dockerHermesEnrollments.enabled, true)));
  return !!row?.enabled;
}
export async function assertDockerAllowed(p: Principal, q: DbOrTx = db) {
  if (!await dockerAllowed(p, q)) throw new HttpError(403, 'You are not authorized to use a personal Hermes runtime.');
}
export async function assertDockerCreate(p: Principal, policy: { botCreation: string }, q: DbOrTx = db) {
  await assertDockerAllowed(p, q);
  if ((policy.botCreation === 'admins' && !p.isAdmin) || (policy.botCreation === 'groups' && !p.canCreateBots))
    throw new HttpError(403, 'Bot-creation permission is required to enable Hermes or add native profiles.');
}
