import { readFileSync, readdirSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null, revoke: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => fixture.principal, requireAdmin: async () => fixture.principal }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: fixture.revoke }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'); const { drizzle } = await import('drizzle-orm/pglite'); const schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { authorizeTeam, configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { queueTeamAccessReconciliation, reconcileTeamAccess } from '@/lib/hermes-team/revocation';
import { recordTeamRunAdmission } from '@/lib/hermes-team/run-policy';
import { updateBot } from '@/app/(chat)/bots/actions';
import { deleteGroup, saveGroup, setBotEnabled } from '@/app/admin/actions';
import { changeUserAccess } from '@/lib/auth/local';
import { continueRun } from '@/lib/runs/store';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { TEAM_MODEL_PURPOSES, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
let admin: Principal, alice: Principal, bob: Principal;
const config = { enabled: true, modelPolicy: { mode: 'admin_provided' }, maintainerIds: ['admin'], expectedVersion: 0 };
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); fixture.revoke.mockReset(); fixture.revoke.mockResolvedValue({ stopped: true, interruption: 'runtime-wide' });
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await db.insert(schema.users).values([
    { id: 'admin', name: 'Admin', upn: 'admin@test.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true },
    { id: 'alice', name: 'Alice', upn: 'alice@test.invalid', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', name: 'Bob', upn: 'bob@test.invalid', authSource: 'local', identityRealm: 'local' },
  ]);
  admin = (await loadPrincipal('admin'))!; alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!; fixture.principal = admin;
  await db.insert(schema.aiApps).values({ id: 'old-app', name: 'Old company model', provider: 'openai', model: 'synthetic', isPublic: true });
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', appId: 'old-app', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values([{ botId: 'team', userId: 'alice' }, { botId: 'team', userId: 'bob' }]);
  await configureTeam(admin, 'team', config);
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });
async function runFor(p: Principal, id: string, status: 'queued'|'waiting' = 'queued') {
  const chat = await openTeamConversation(p, 'team', 'member');
  await db.insert(schema.agentRuns).values({ id, userId: p.user.id, botId: 'team', conversationId: chat.conversationId, messageId: `${id}-message`, status });
  return chat;
}
describe('Team Bot server capability policy persistence and lifecycle wiring', () => {
  it('persists validated tool policy, preserves it from older editors and rejects credential/scope tampering', async () => {
    const tools = { capabilities: [{ capabilityId: 'documents', connectionMode: 'disabled' as const, resourceIds: [], effect: 'read' as const, requireApproval: true }] };
    await configureTeam(admin, 'team', { ...config, expectedVersion: 1, toolPolicy: tools });
    await configureTeam(admin, 'team', { ...config, expectedVersion: 2 });
    expect((await db.select().from(schema.hermesTeamDefinitions))[0].toolPolicy).toEqual(tools);
    for (const toolPolicy of [
      { capabilities: [{ ...tools.capabilities[0], token: 'synthetic-secret' }] },
      { capabilities: [{ ...tools.capabilities[0], connectionMode: 'approved_team_connection', connectionId: 's', adapterId: 'a', action: 'write', resourceIds: [] }] },
      { capabilities: [{ ...tools.capabilities[0], effect: 'write', requireApproval: false }] },
    ]) await expect(configureTeam(admin, 'team', { ...config, expectedVersion: 3, toolPolicy })).rejects.toBeDefined();
    await expect(configureTeam(alice, 'team', { ...config, expectedVersion: 3, toolPolicy: tools })).rejects.toMatchObject({ status: 403 });
    expect(fixture.revoke).not.toHaveBeenCalled();
  });
  it('actual audience editor mutation cancels queued and waiting work, revokes only the removed member and retains native mapping/history', async () => {
    await runFor(alice, 'queued');
    await runFor(alice, 'approval', 'waiting');
    const retained = await reserveTeamProfile(alice, 'team', 'member');
    await reserveTeamProfile(bob, 'team', 'member');
    await updateBot('team', { name: 'Team', appId: 'old-app', visibility: 'groups', userIds: ['bob'], groupIds: [], tools: [], delegateIds: [], starters: [], maxSteps: 10 });
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith('alice', '/team/revoke', { teamBotId: 'team', mode: 'member' }, 3000);
    expect((await db.select().from(schema.agentRuns)).every(r => r.cancelRequestedAt !== null)).toBe(true);
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(bob, 'team', 'member')).resolves.toBeDefined();
    expect((await db.select().from(schema.hermesTeamProfiles).where(eq(schema.hermesTeamProfiles.id, retained.id)))[0].state).toBe('revoked');
    expect(await db.select().from(schema.conversations)).toHaveLength(1);
    expect((await db.select().from(schema.hermesTeamOperations))[0]).toMatchObject({ kind: 'revoke', state: 'complete', result: { interruption: 'runtime-wide', userId: 'alice' } });
    const [conversation] = await db.select().from(schema.conversations);
    await expect(continueRun({ principal: alice, conversation, messageId: 'approval-message', decisions: new Map([['synthetic-approval', { approved: true }]]) })).rejects.toMatchObject({ status: 409 });
  });
  it('actual group membership editor removal and group deletion reconcile derived audience grants', async () => {
    await db.insert(schema.groups).values({ id: 'engineering', name: 'Engineering' });
    await db.insert(schema.groupMembers).values([{ groupId: 'engineering', userId: 'alice' }, { groupId: 'engineering', userId: 'bob' }]);
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.botId, 'team'));
    await db.insert(schema.botAccess).values({ botId: 'team', groupId: 'engineering' });
    alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!;
    await runFor(alice, 'removed-group-member', 'waiting'); await runFor(bob, 'retained-group-member');
    await saveGroup({ id: 'engineering', name: 'Engineering', isAdmin: false, canCreateBots: false, mappings: [], memberIds: ['bob'] });
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith('alice', '/team/revoke', { teamBotId: 'team', mode: 'member' }, 3000);
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(bob, 'team', 'member')).resolves.toBeDefined();
    await deleteGroup('engineering');
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
    expect(fixture.revoke).toHaveBeenLastCalledWith('bob', '/team/revoke', { teamBotId: 'team', mode: 'member' }, 3000);
    expect((await db.select().from(schema.agentRuns)).every(r => r.cancelRequestedAt !== null)).toBe(true);
    expect(await db.select().from(schema.hermesTeamProfiles)).toHaveLength(2);
  });
  it('actual account disable and session revocation invalidate only that person’s retained grants', async () => {
    await db.update(schema.users).set({ identityRealm: 'directory', authSource: 'entra' }).where(eq(schema.users.id, 'admin'));
    admin = (await loadPrincipal('admin'))!; fixture.principal = admin;
    await runFor(alice, 'disabled'); await runFor(bob, 'old-session', 'waiting');
    await changeUserAccess(admin.user, 'alice', { disabled: true });
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(bob, 'team', 'member')).resolves.toBeDefined();
    await changeUserAccess(admin.user, 'bob', { revoke: true });
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
    expect((await db.select().from(schema.hermesTeamOperations)).map(r => r.result)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'alice', reason: 'principal_changed', accessRevoked: true }),
      expect.objectContaining({ userId: 'bob', reason: 'principal_changed', accessRevoked: false }),
    ]));
    expect((await db.select().from(schema.agentRuns)).every(r => r.cancelRequestedAt !== null)).toBe(true);
    await expect(authorizeTeam(bob, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    bob = (await loadPrincipal('bob'))!;
    await expect(authorizeTeam(bob, 'team', 'member')).resolves.toBeDefined();
  });
  it('a later group removal receives a fresh cleanup receipt after membership was restored', async () => {
    await db.insert(schema.groups).values({ id: 'engineering', name: 'Engineering' });
    await db.insert(schema.groupMembers).values({ groupId: 'engineering', userId: 'alice' });
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.botId, 'team'));
    await db.insert(schema.botAccess).values({ botId: 'team', groupId: 'engineering' });
    alice = (await loadPrincipal('alice'))!;
    await reserveTeamProfile(alice, 'team', 'member');
    const group = { id: 'engineering', name: 'Engineering', isAdmin: false, canCreateBots: false, mappings: [] };
    await saveGroup({ ...group, memberIds: [] });
    await saveGroup({ ...group, memberIds: ['alice'] });
    alice = (await loadPrincipal('alice'))!;
    await reserveTeamProfile(alice, 'team', 'member');
    await saveGroup({ ...group, memberIds: [] });
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
    expect(await db.select().from(schema.hermesTeamOperations)).toHaveLength(2);
  });
  it('disabling a Team definition during queued work is allowed and invalidates continuation promptly', async () => {
    await runFor(alice, 'active');
    await configureTeam(admin, 'team', { ...config, enabled: false, expectedVersion: 1 });
    expect((await db.select().from(schema.agentRuns))[0].cancelRequestedAt).not.toBeNull();
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
  });
  it('actual admin disable action reconciles retained Team work and creates durable interruption receipts', async () => {
    await runFor(alice, 'active');
    await setBotEnabled('team', false);
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.agentRuns))[0].cancelRequestedAt).not.toBeNull();
    expect((await db.select().from(schema.hermesTeamOperations))[0]).toMatchObject({ state: 'complete', result: { reason: 'bot_disabled' } });
  });
  it('retains failed cleanup receipts and fences reopening until an idempotent retry reconciles them', async () => {
    await reserveTeamProfile(alice, 'team', 'member'); fixture.revoke.mockRejectedValueOnce(new Error('Synthetic broker unavailable'));
    await configureTeam(admin, 'team', { ...config, expectedVersion: 1 });
    const [pending] = await db.select().from(schema.hermesTeamOperations);
    expect(pending.state).toBe('needs_attention');
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 409 });
    await reserveTeamProfile(alice, 'team', 'member'); await reconcileTeamAccess('team');
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
    await expect(authorizeTeam(alice, 'team', 'member')).resolves.toBeDefined();
    expect((await db.select().from(schema.hermesTeamOperations))[0].id).toBe(pending.id);
  });
  it('queues the same audience reconciliation once and never grants a previously revoked user via retained ownership', async () => {
    await reserveTeamProfile(alice, 'team', 'member');
    await db.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId, 'team'), eq(schema.botUserAccess.userId, 'alice')));
    for (let n = 0; n < 2; n++) await db.transaction(tx => queueTeamAccessReconciliation(tx, 'team', 'admin', { reason: 'audience_changed' }));
    expect(await db.select().from(schema.hermesTeamOperations)).toHaveLength(1);
    await reconcileTeamAccess('team');
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  });
  it('rejects every real run purpose without verified routes and records no false successful attribution', async () => {
    await runFor(alice, 'unverified');
    for (const purpose of TEAM_MODEL_PURPOSES) await expect(recordTeamRunAdmission(alice, 'unverified', purpose)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamRunAttribution)).toEqual([]);
    await expect(recordTeamRunAdmission(bob, 'unverified', 'reply')).rejects.toMatchObject({ status: 404 });
  });
  it('derives and retains one immutable run attribution from a trusted synthetic gateway route, then blocks cancellation', async () => {
    const now = Date.now();
    const route: VerifiedTeamModelRoute = { id: 'synthetic', adapterId: 'fixture', integration: 'admin_inference_gateway', model: 'synthetic-model', billing: 'admin', credentialHandling: 'server_gateway',
      evidence: { id: 'synthetic-only-evidence', hermesRevision: HERMES_COMMIT, adapterId: 'fixture', integration: 'admin_inference_gateway', model: 'synthetic-model', purposes: TEAM_MODEL_PURPOSES, verifiedAt: now - 1000, expiresAt: now + 60000 } };
    await configureTeam(admin, 'team', { ...config, expectedVersion: 1, modelPolicy: { mode: 'admin_provided', adminRouteId: route.id } });
    await runFor(alice, 'admitted');
    for (let n = 0; n < 2; n++) expect(await recordTeamRunAdmission(alice, 'admitted', 'reply', [route])).toMatchObject({ userId: 'alice', botId: 'team', billing: 'admin', policyVersion: 2 });
    expect(await db.select().from(schema.hermesTeamRunAttribution)).toHaveLength(1);
    await db.update(schema.agentRuns).set({ cancelRequestedAt: new Date() }).where(eq(schema.agentRuns.id, 'admitted'));
    await expect(recordTeamRunAdmission(alice, 'admitted', 'utility', [route])).rejects.toMatchObject({ status: 409 });
  });
});
