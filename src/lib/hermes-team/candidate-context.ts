import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '@/db';
import { agentRuns, bots, hermesTeamCandidateContexts, hermesTeamCandidateRequests, hermesTeamChats, hermesTeamProfiles, type AgentRunStatus } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { authorizeTeam } from './store';
import { canonicalTeamToolInput } from './tool-policy';
import { evaluateTeamModelAccess, TEAM_MODEL_PURPOSES, VERIFIED_TEAM_MODEL_ROUTES, type TeamModelAuthority, type TeamModelPurpose, type VerifiedTeamModelRoute } from './model-policy';
import { candidateWireMetadata } from './candidate-wire-metadata';
import { loadTeamPersonalAccess } from './personal-access';

export const candidateHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const candidateObjectHash = (value: unknown) => candidateHash(canonicalTeamToolInput(value));
export type CandidateContext = typeof hermesTeamCandidateContexts.$inferSelect;
const OPEN:readonly AgentRunStatus[] = ['queued','running','waiting','waiting_tasks'];
const sameHash = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** Resolve every identity from the persisted run. A native token never grants audience or admin authority. */
export async function candidateRun(p: Principal, runId: string, q: DbOrTx = db) {
  const [run] = await q.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run || run.userId !== p.user.id || !run.botId || run.cancelRequestedAt || !OPEN.includes(run.status)) throw new HttpError(403, 'This Team run is no longer available.');
  const [chat] = await q.select().from(hermesTeamChats).where(eq(hermesTeamChats.conversationId, run.conversationId));
  const [profile] = chat ? await q.select().from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id, chat.profileId)) : [];
  if (!chat || !profile || profile.botId !== run.botId || chat.mode !== profile.mode || (profile.mode === 'member' && profile.userId !== p.user.id)) throw new HttpError(403, 'Invalid Team run context.');
  const auth = await authorizeTeam(p, run.botId, chat.mode, q);
  if (!profile.binding || profile.state !== 'ready') throw new HttpError(409, 'The Team runtime model adapter is not ready.');
  return { ...auth, run, chat, profile };
}

export async function candidateAuthority(p: Principal, runId: string, routes: readonly VerifiedTeamModelRoute[], q: DbOrTx = db): Promise<TeamModelAuthority> {
  const context = await candidateRun(p, runId, q);
  const personalRoute = routes.find(r => r.id === context.definition.modelPolicy.personalRouteId);
  return { userId: p.user.id, botId: context.bot.id, userEnabled: !context.principal.user.disabled, botEnabled: context.bot.enabled && context.definition.enabled,
    audienceAllowed: true, policyVersion: context.definition.version, hermesRevision: HERMES_COMMIT, policy: context.definition.modelPolicy,
    personalConnection: personalRoute ? await loadTeamPersonalAccess(context.principal, personalRoute.integration, q) : null };
}

/** Trusted native startup only: the return value is never sent to a browser or written to a profile file. */
export async function issueTeamCandidateContext(p: Principal, runId: string, choice: 'default'|'personal' = 'default', routes: readonly VerifiedTeamModelRoute[] = VERIFIED_TEAM_MODEL_ROUTES) {
  // Empty verification inventory stops before credential metadata, grants or provider reads.
  if (!routes.length) throw new HttpError(409, 'Team model and native bridge verification is required.');
  return db.transaction(async tx => {
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!run?.botId || run.userId !== p.user.id) throw new HttpError(404, 'Team run not found.');
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, run.botId)).for('update');
    const current = await candidateRun(p, runId, tx);
    const [retained] = await tx.select({id:hermesTeamCandidateContexts.id}).from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.runId,runId));
    if(retained)throw new HttpError(409,'This run already has a native grant. Start a new run after reconciliation.');
    await tx.select({ id: hermesTeamProfiles.id }).from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id, current.profile.id)).for('update');
    const authority = await candidateAuthority(p, runId, routes, tx);
    const selected = evaluateTeamModelAccess({ userId: p.user.id, botId: run.botId, runId, purpose: 'reply', choice }, authority, routes);
    if (selected.status !== 'ready') throw new HttpError(selected.status === 'blocked' ? 403 : 409, selected.message);
    const route = routes.find(r => r.id === selected.attribution.routeId)!;
    const transport=await candidateWireMetadata(current.principal,route,tx);
    if(!route.transportHash || route.transportHash!==transport.hash)throw new HttpError(409,'The actual native transport has not been verified.');
    const existing = await tx.select().from(hermesTeamCandidateContexts).where(and(eq(hermesTeamCandidateContexts.profileId, current.profile.id), isNull(hermesTeamCandidateContexts.revokedAt)));
    for (const prior of existing) {
      const [priorRun] = await tx.select().from(agentRuns).where(eq(agentRuns.id, prior.runId));
      const unresolved = await tx.select({ id: hermesTeamCandidateRequests.id }).from(hermesTeamCandidateRequests)
        .where(and(eq(hermesTeamCandidateRequests.contextId, prior.id), inArray(hermesTeamCandidateRequests.state, ['reserved','running','needs_attention'])));
      if (unresolved.length || (priorRun && OPEN.includes(priorRun.status) && !priorRun.cancelRequestedAt && prior.expiresAt.getTime() > Date.now()))
        throw new HttpError(409, 'Another native run or unresolved request holds this Team profile.');
      await tx.update(hermesTeamCandidateContexts).set({ revokedAt: new Date() }).where(eq(hermesTeamCandidateContexts.id, prior.id));
    }
    // A profile is shared by maintainers. Other queued contexts cannot inherit this actor's grant.
    const siblings = await tx.select({ run: agentRuns }).from(agentRuns).innerJoin(hermesTeamChats, eq(hermesTeamChats.conversationId, agentRuns.conversationId))
      .where(and(eq(hermesTeamChats.profileId, current.profile.id), inArray(agentRuns.status, OPEN)));
    if (siblings.some(({ run: sibling }) => sibling.id !== runId && !sibling.cancelRequestedAt)) throw new HttpError(409, 'Finish the active Team profile conversation first.');
    const tokens = Object.fromEntries(TEAM_MODEL_PURPOSES.map(purpose => [purpose, randomBytes(32).toString('hex')])) as Record<TeamModelPurpose,string>;
    const toolToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Math.min(Date.now() + 120_000, route.evidence.expiresAt, selected.attribution.billing === 'personal' ? authority.personalConnection?.expiresAt ?? 0 : Infinity));
    const [context] = await tx.insert(hermesTeamCandidateContexts).values({ runId, botId: run.botId, profileId: current.profile.id, actorId: p.user.id,
      sessionVersion: current.principal.user.sessionVersion, definitionVersion: current.definition.version, teamRevision: current.profile.installedRevision,
      mode: current.chat.mode, modelRoute: route, personalConnectionId: selected.attribution.connectionId, bindingHash: candidateObjectHash(current.profile.binding),
      modelTokens: Object.fromEntries(TEAM_MODEL_PURPOSES.map(purpose => [purpose,candidateHash(tokens[purpose])])) as Record<TeamModelPurpose,string>,
      toolTokenHash: candidateHash(toolToken), expiresAt }).returning();
    return { contextId: context.id, modelTokens: tokens, toolToken, model: route.model, adapterId: route.adapterId, expiresAt: expiresAt.getTime() };
  });
}

export async function loadCandidateContext(contextId: string, authorization: string | null, purpose: TeamModelPurpose|'tool', routes: readonly VerifiedTeamModelRoute[] = VERIFIED_TEAM_MODEL_ROUTES, q: DbOrTx = db) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? '')?.[1];
  if (!token) throw new HttpError(401, 'A native Team run grant is required.');
  const [context] = await q.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id, contextId));
  const expected = context && (purpose === 'tool' ? context.toolTokenHash : context.modelTokens[purpose]);
  if (!context || !expected || !sameHash(expected,candidateHash(token)) || context.revokedAt || context.expiresAt.getTime() <= Date.now()) throw new HttpError(403, 'The native Team grant expired or was revoked.');
  return validateCandidateContext(context, routes, q, purpose);
}

/** Shared, token-free server validation for human approval. Possession of a session is checked by the caller. */
export async function validateCandidateContext(context: CandidateContext, routes: readonly VerifiedTeamModelRoute[], q: DbOrTx = db, purpose: TeamModelPurpose|'tool' = 'reply') {
  if (context.revokedAt || context.expiresAt.getTime() <= Date.now()) throw new HttpError(403, 'The native Team context expired.');
  const principal = await loadPrincipal(context.actorId, q);
  if (!principal || principal.user.sessionVersion !== context.sessionVersion) throw new HttpError(403, 'The native Team session changed.');
  const run = await candidateRun(principal, context.runId, q);
  if (run.profile.id !== context.profileId || run.bot.id !== context.botId || run.chat.mode !== context.mode || run.definition.version !== context.definitionVersion
    || run.profile.installedRevision !== context.teamRevision || candidateObjectHash(run.profile.binding) !== context.bindingHash) throw new HttpError(403, 'The native Team binding changed.');
  const route = routes.find(r => r.id === context.modelRoute.id);
  if (!route || candidateObjectHash(route) !== candidateObjectHash(context.modelRoute)) throw new HttpError(409, 'The native route is no longer verified.');
  const transport=await candidateWireMetadata(principal,route,q);
  if(!route.transportHash || route.transportHash!==transport.hash)throw new HttpError(409,'The actual native transport changed after verification.');
  const authority = await candidateAuthority(principal, context.runId, routes, q);
  const decision = evaluateTeamModelAccess({ userId: context.actorId, botId: context.botId, runId: context.runId, purpose: purpose === 'tool' ? 'reply' : purpose,
    choice: context.modelRoute.billing === 'personal' ? 'personal' : 'default' }, authority, routes);
  if (decision.status !== 'ready' || decision.attribution.connectionId !== context.personalConnectionId) throw new HttpError(403, 'Current Team model access is unavailable.');
  return { context, principal, run, authority,transport };
}

/** Bot lock precedes context/request locks, matching audience edits and resource operations. */
export async function lockCandidateContext(tx: Tx, context: CandidateContext) {
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, context.botId)).for('update');
  await tx.select({ id: hermesTeamCandidateContexts.id }).from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id, context.id)).for('update');
}
