import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
export const isDockerHermes = (app: { provider: string; providerConfig: Record<string, unknown> }) => app.provider === 'hermes' && app.providerConfig.docker !== undefined;
/** Explicit operator enrollment is distinct from ordinary chat permission and runtime administration. */
export function dockerAllowed(p: Principal) {
  return !p.user.disabled && !!process.env.DOCKER_HERMES_SOCKET && (process.env.DOCKER_HERMES_ALLOWED_USER_IDS ?? '').split(/[\s,;]+/).includes(p.user.id);
}
export function assertDockerAllowed(p: Principal) {
  if (!dockerAllowed(p)) throw new HttpError(403, 'You are not authorized to use a personal Hermes runtime.');
}
export function assertDockerCreate(p: Principal, policy: { botCreation: string }) {
  assertDockerAllowed(p);
  if ((policy.botCreation === 'admins' && !p.isAdmin) || (policy.botCreation === 'groups' && !p.canCreateBots))
    throw new HttpError(403, 'Bot-creation permission is required to enable Hermes or add native profiles.');
}
