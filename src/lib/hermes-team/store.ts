import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { agentRuns, aiApps, botAccess, botUserAccess, bots, hermesTeamDefinitions, hermesTeamMaintainers, hermesTeamProfiles } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { teamBotsEnabled, teamModeAllows, teamOwnerKey } from './policy';
import { teamConfiguration, type TeamMode } from './types';
import { OPEN_STATUSES } from '@/lib/runs/types';
export async function freshTeamPrincipal(p: Principal, q: DbOrTx = db) {
  if (!teamBotsEnabled()) throw new HttpError(404, 'Team Bots are not enabled.');
  const fresh = await loadPrincipal(p.user.id, q);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Your access changed. Sign in again.');
  return fresh;
}
/** Every dispatch and continuation must call this using fresh database state. */
export async function authorizeTeam(p: Principal, botId: string, mode: TeamMode, q: DbOrTx = db, allowDisabled = false) {
  const fresh = await freshTeamPrincipal(p, q);
  const [bot] = await q.select().from(bots).where(eq(bots.id, botId));
  const [definition] = await q.select().from(hermesTeamDefinitions).where(eq(hermesTeamDefinitions.botId, botId));
  if (!bot?.hermesTeam || !definition || (!allowDisabled && (!bot.enabled || !definition.enabled))) throw new HttpError(403, 'This Team Bot is unavailable.');
  const maintainers = await q.select().from(hermesTeamMaintainers).where(eq(hermesTeamMaintainers.botId, botId));
  const audienceGroups = await q.select().from(botAccess).where(eq(botAccess.botId, botId));
  const audienceUsers = await q.select().from(botUserAccess).where(eq(botUserAccess.botId, botId));
  if (!teamModeAllows(fresh, bot, { groupIds: audienceGroups.map(r => r.groupId), userIds: audienceUsers.map(r => r.userId) }, maintainers.map(r => r.userId), mode))
    throw new HttpError(403, mode === 'admin' ? 'Admin status and permission to maintain this bot are required.' : 'You are outside this bot’s audience.');
  return { principal: fresh, bot, definition };
}
/** Existing catalog/editor identity is retained; personal Hermes bindings cannot become shared definitions. */
export async function configureTeam(p: Principal, botId: string, raw: unknown) {
  const input = teamConfiguration.parse(raw);
  return db.transaction(async tx => {
    const fresh = await freshTeamPrincipal(p, tx);
    if (!fresh.isAdmin) throw new HttpError(403, 'Admin only');
    const [bot] = await tx.select().from(bots).where(eq(bots.id, botId)).for('update');
    if (!bot) throw new HttpError(404, 'Bot not found');
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.botId, botId), inArray(agentRuns.status, [...OPEN_STATUSES]))).limit(1);
    if (active) throw new HttpError(409, 'Finish active bot work and approvals before changing its Team configuration.');
    if (bot.executionMode !== 'caller' || bot.coordinatorEligible || bot.isCoordinator) throw new HttpError(400, 'Team Bots support direct chats only.');
    const [app] = bot.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
    if (app && (app.providerConfig.docker !== undefined || app.providerConfig.local !== undefined || app.providerConfig.managed !== undefined))
      throw new HttpError(409, 'Create a separate Team Bot. Existing native bindings and personal profiles must be retained.');
    const [previous] = await tx.select().from(hermesTeamDefinitions).where(eq(hermesTeamDefinitions.botId, botId)).for('update');
    if ((previous?.version ?? 0) !== input.expectedVersion) throw new HttpError(409, 'The bot changed. Reload before saving.');
    if (previous) await authorizeTeam(fresh, botId, 'admin', tx, true);
    const maintainerIds = [...new Set(input.maintainerIds)];
    if (!maintainerIds.includes(fresh.user.id)) throw new HttpError(400, 'Keep yourself as a maintainer while editing.');
    for (const id of maintainerIds) {
      const maintainer = await loadPrincipal(id, tx);
      if (!maintainer?.isAdmin) throw new HttpError(400, 'Every maintainer must be an active administrator.');
    }
    const values = { enabled: input.enabled, modelPolicy: input.modelPolicy, version: (previous?.version ?? 0) + 1, updatedBy: fresh.user.id, updatedAt: new Date() };
    if (previous) await tx.update(hermesTeamDefinitions).set(values).where(eq(hermesTeamDefinitions.botId, botId));
    else await tx.insert(hermesTeamDefinitions).values({ botId, ...values });
    await tx.delete(hermesTeamMaintainers).where(eq(hermesTeamMaintainers.botId, botId));
    await tx.insert(hermesTeamMaintainers).values(maintainerIds.map(userId => ({ botId, userId })));
    await tx.update(bots).set({ hermesTeam: true, updatedAt: new Date() }).where(eq(bots.id, botId));
    return { version: values.version };
  });
}
/** Caller locks bot first. A durable user×bot reservation never derives identity from a chat or browser path. */
export async function reserveTeamProfile(p: Principal, botId: string, mode: TeamMode) {
  return db.transaction(async tx => {
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
    await authorizeTeam(p, botId, mode, tx);
    const userId = mode === 'member' ? p.user.id : null;
    const where = and(eq(hermesTeamProfiles.botId, botId), eq(hermesTeamProfiles.mode, mode), userId ? eq(hermesTeamProfiles.userId, userId) : isNull(hermesTeamProfiles.userId));
    const [existing] = await tx.select().from(hermesTeamProfiles).where(where);
    if (existing) return existing;
    const [profile] = await tx.insert(hermesTeamProfiles).values({ botId, userId, mode, ownerKey: teamOwnerKey(p.user.id, botId, mode), requestId: randomUUID() }).returning();
    return profile;
  });
}
