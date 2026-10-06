import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { dockerControl, dockerFetch } from '@/lib/docker-hermes/client';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { authorizeTeam } from './store';
import type { TeamMode } from './types';
export type TeamResourceSelection = { skillPackages?: readonly string[]; includeRole?: boolean; documents?: readonly string[] };
export type TeamPublishableInventory = { selection: TeamResourceSelection; available: boolean; reason?: string };
/** Only this trusted server adapter constructs broker scopes and grant headers. */
async function grantTeam(p: Principal, botId: string, mode: TeamMode) {
  const auth = await authorizeTeam(p, botId, mode);
  const grant = await dockerControl<{ grantId: string; expiresAt: number }>(p.user.id, '/team/authorize', { teamBotId: botId, mode, modelPolicy: auth.definition.modelPolicy.mode });
  if (typeof grant.grantId !== 'string' || !/^[0-9a-f-]{36}$/.test(grant.grantId) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now())
    throw new HttpError(503, 'The Team runtime did not confirm a valid grant.');
  return { ...auth, grant };
}
export async function ensureTeamRuntime(p: Principal, botId: string, mode: TeamMode): Promise<unknown> {
  const { bot, grant } = await grantTeam(p, botId, mode);
  return teamRequest(p, botId, mode, grant.grantId, '/team/ensure', { teamBotId: botId, mode, name: bot.name.slice(0,80) });
}
export async function captureTeamResources(p: Principal, botId: string, selection: TeamResourceSelection): Promise<unknown> {
  const { grant } = await grantTeam(p, botId, 'admin');
  return teamRequest(p, botId, 'admin', grant.grantId, '/team/capture', { teamBotId: botId, mode: 'admin', selection });
}
export async function inventoryTeamResources(p: Principal, botId: string): Promise<TeamPublishableInventory> {
  const { grant } = await grantTeam(p, botId, 'admin');
  const selection = await teamRequest(p, botId, 'admin', grant.grantId, '/team/inventory', { teamBotId: botId, mode: 'admin' });
  const { teamResourceSelectionSchema } = await import('./publication');
  return { selection: teamResourceSelectionSchema.parse(selection), available: true };
}
async function teamRequest(p: Principal, botId: string, mode: TeamMode, grantId: string, action: '/team/ensure' | '/team/capture' | '/team/inventory', body: unknown) {
  let permissionDenied = false;
  const freshAuthorization = async () => {
    try { await authorizeTeam(p, botId, mode); }
    catch (e) { if (e instanceof HttpError && [403, 404].includes(e.status)) permissionDenied = true; throw e; }
  };
  try {
    await freshAuthorization();
    const response = await dockerFetch(p.user.id)(`${LOCAL_ORIGIN}${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-collective-team-grant': grantId },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    const value = await response.json();
    if (!response.ok) throw new HttpError(action === '/team/inventory' && response.status === 404 ? 503 : response.status, 'The Team runtime needs attention. Its model and volume adapters may still need verification.');
    // Fresh permission after broker I/O, before any mapping/resources reach the caller.
    await freshAuthorization();
    return value as unknown;
  } catch (e) {
    // Capability/binding HTTP errors are not proof that app authority was revoked.
    // Revoke only a confirmed freshness failure, including immediately after issue.
    if (permissionDenied) {
      await dockerControl(p.user.id, '/team/revoke', { teamBotId: botId, mode }, 3000).catch(() => {});
      throw e;
    }
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'The Team runtime broker is unavailable. Ask an admin to check setup.');
  }
}
