import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agentRuns, bots, hermesTeamChats, hermesTeamProfiles, hermesTeamRunAttribution } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { authorizeTeam } from './store';
import { evaluateTeamModelAccess, VERIFIED_TEAM_MODEL_ROUTES, type TeamModelPurpose, type VerifiedTeamModelRoute } from './model-policy';
import { TeamRunAdmissionDetailsSchema } from './run-attribution';

/** Gateway-only admission. The profile, human, bot and version are derived from the persisted run and chat. */
export async function recordTeamRunAdmission(p: Principal, runId: string, purpose: TeamModelPurpose, routes: readonly VerifiedTeamModelRoute[] = VERIFIED_TEAM_MODEL_ROUTES,
  receipts: { usageReceiptId?: string; gatewayGrantId?: string } = {}) {
  return db.transaction(async tx => {
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!run || run.userId !== p.user.id || !run.botId) throw new HttpError(404, 'Team run not found.');
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, run.botId)).for('update');
    const [lockedRun] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for('update');
    if (!lockedRun || lockedRun.userId !== p.user.id || lockedRun.botId !== run.botId || lockedRun.conversationId !== run.conversationId)
      throw new HttpError(404, 'Team run changed.');
    const [chat] = await tx.select().from(hermesTeamChats).where(eq(hermesTeamChats.conversationId, run.conversationId));
    const [profile] = chat ? await tx.select().from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id, chat.profileId)) : [];
    if (!chat || !profile || profile.botId !== run.botId || profile.mode !== chat.mode || (chat.mode === 'member' && profile.userId !== p.user.id))
      throw new HttpError(404, 'Team run context not found.');
    const auth = await authorizeTeam(p, run.botId, chat.mode, tx);
    if (lockedRun.cancelRequestedAt || !['queued','running','waiting'].includes(lockedRun.status)) throw new HttpError(409, 'This Team run is no longer admissible.');
    const decision = evaluateTeamModelAccess({ userId: auth.principal.user.id, botId: run.botId, runId, purpose }, {
      userId: auth.principal.user.id, botId: run.botId, userEnabled: !auth.principal.user.disabled,
      botEnabled: auth.bot.enabled && auth.definition.enabled, audienceAllowed: true,
      policyVersion: auth.definition.version, hermesRevision: HERMES_COMMIT, policy: auth.definition.modelPolicy,
      // Native Codex and official ChatGPT plan connections require different tested bridges. Neither is installed here.
      personalConnection: null,
    }, routes);
    if (decision.status !== 'ready') throw new HttpError(decision.status === 'blocked' ? 403 : 409, decision.message);
    if (!profile.binding || profile.state !== 'ready') throw new HttpError(409, 'Finish preparing or recovering this private Team profile before starting model work.');
    if (decision.attribution.billing === 'admin' && (!receipts.usageReceiptId || !receipts.gatewayGrantId))
      throw new HttpError(409, 'An attributed usage reservation and server gateway grant are required before starting admin-provided model work.');
    const values = { runId, profileId: profile.id, botId: run.botId, actorId: auth.principal.user.id, definitionVersion: auth.definition.version,
      teamRevision: profile.installedRevision, mode: profile.mode, modelSource: decision.attribution.billing };
    const route = routes.find(r => r.id === decision.attribution.routeId)!;
    const details = TeamRunAdmissionDetailsSchema.parse({ version: 1, routeId: decision.attribution.routeId, adapterId: decision.attribution.adapterId,
      integration: decision.attribution.integration, model: decision.attribution.model, billing: decision.attribution.billing, connectionId: decision.attribution.connectionId,
      gatewayGrantId: receipts.gatewayGrantId ?? null, evidence: { id: route.evidence.id, hermesRevision: route.evidence.hermesRevision,
        verifiedAt: route.evidence.verifiedAt, expiresAt: route.evidence.expiresAt }, purposes: { [purpose]: { usageReceiptId: receipts.usageReceiptId ?? null } } });
    const [previous] = await tx.select().from(hermesTeamRunAttribution).where(eq(hermesTeamRunAttribution.runId, runId));
    if (previous && Object.entries(values).some(([key, value]) => previous[key as keyof typeof previous] !== value))
      throw new HttpError(409, 'The Team run attribution changed. Start a new run.');
    if (previous) {
      const prior = TeamRunAdmissionDetailsSchema.safeParse(previous.admission);
      if (!prior.success || JSON.stringify({ ...prior.data, purposes: undefined }) !== JSON.stringify({ ...details, purposes: undefined })
        || (prior.data.purposes[purpose] && prior.data.purposes[purpose]!.usageReceiptId !== (receipts.usageReceiptId ?? null)))
        throw new HttpError(409, 'The Team model route, evidence or usage receipt changed. Start a new run.');
      if (!prior.data.purposes[purpose]) await tx.update(hermesTeamRunAttribution).set({ admission: { ...prior.data, purposes: { ...prior.data.purposes, ...details.purposes } } }).where(eq(hermesTeamRunAttribution.runId, runId));
    } else await tx.insert(hermesTeamRunAttribution).values({ ...values, admission: details });
    return decision.attribution;
  });
}
