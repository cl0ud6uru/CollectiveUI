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
import { loadPrincipal, syncUserOnSignIn } from '@/lib/auth/groups';
import { authorizeTeam, configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation, teamChatStatus } from '@/lib/hermes-team/conversations';
import { queueTeamAccessReconciliation, reconcileTeamAccess, reconcileTeamActorAccess } from '@/lib/hermes-team/revocation';
import { recordTeamRunAdmission } from '@/lib/hermes-team/run-policy';
import { updateBot } from '@/app/(chat)/bots/actions';
import { deleteGroup, saveGroup, setBotEnabled } from '@/app/admin/actions';
import { changeOwnPassword, changeUserAccess, resetLocalPassword } from '@/lib/auth/local';
import { manageSecurity, reauthenticatePassword } from '@/lib/auth/security';
import { hashPassword } from '@/lib/auth/password';
import { continueRun } from '@/lib/runs/store';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { createTeamModelGateway, TEAM_MODEL_PURPOSES, type TeamModelAttribution, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { loadBuilderData } from '@/lib/bots/builder-data';
let admin: Principal, alice: Principal, bob: Principal;
const config = { enabled: true, modelPolicy: { mode: 'admin_provided' }, maintainerIds: ['admin'], expectedVersion: 0 };
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('AUTH_SECRET', 'synthetic-team-auth-fixture-secret');
  fixture.revoke.mockReset(); fixture.revoke.mockResolvedValue({ stopped: true, interruption: 'runtime-wide' });
  await fixture.client!.exec('TRUNCATE users, ai_apps, groups, settings, auth_throttle CASCADE');
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
  it('actual builder data retains saved fixed route and capability rules while offering no unverified inventory', async () => {
    const toolPolicy = { capabilities: [{ capabilityId: 'documents', connectionMode: 'disabled' as const, resourceIds: [], effect: 'read' as const, requireApproval: true }] };
    await configureTeam(admin, 'team', { ...config, expectedVersion: 1, modelPolicy: { mode: 'admin_default_personal_allowed', adminRouteId: 'saved-admin-route', personalRouteId: 'saved-personal-route' }, toolPolicy });
    const builder = await loadBuilderData(admin, 'team');
    expect(builder.teamConfig).toMatchObject({ modelRoutes: { adminRouteId: 'saved-admin-route', personalRouteId: 'saved-personal-route' }, toolPolicy, expectedVersion: 2 });
    expect(builder.teamModelOptions).toEqual([]);
    expect(await teamChatStatus(alice, 'team')).toMatchObject({ modelAccessAvailable: false, modelAccessReason: expect.any(String) });
  });
  it('actual audience editor mutation cancels queued and waiting work, revokes only the removed member and retains native mapping/history', async () => {
    await runFor(alice, 'queued');
    await runFor(alice, 'approval', 'waiting');
    const retained = await reserveTeamProfile(alice, 'team', 'member');
    await reserveTeamProfile(bob, 'team', 'member');
    await updateBot('team', { name: 'Team', appId: 'old-app', visibility: 'groups', userIds: ['bob'], groupIds: [], tools: [], delegateIds: [], starters: [], maxSteps: 10 });
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith('alice', '/team/revoke', expect.objectContaining({ teamBotId: 'team', mode: 'member', requestId: expect.stringMatching(/^revoke:[a-f0-9]{64}$/), digest: expect.stringMatching(/^[a-f0-9]{64}$/) }), 3000);
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
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith('alice', '/team/revoke', expect.objectContaining({ teamBotId: 'team', mode: 'member' }), 3000);
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(bob, 'team', 'member')).resolves.toBeDefined();
    await deleteGroup('engineering');
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
    expect(fixture.revoke).toHaveBeenLastCalledWith('bob', '/team/revoke', expect.objectContaining({ teamBotId: 'team', mode: 'member' }), 3000);
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
  it('directory audience removal and admin-group demotion revoke both member and working-profile grants', async () => {
    await db.update(schema.users).set({ identityRealm: 'directory', authSource: 'ldap' }).where(eq(schema.users.id, 'bob'));
    await db.insert(schema.groups).values({ id: 'directory-team', name: 'Directory team', isAdmin: true });
    await db.insert(schema.groupMappings).values({ groupId: 'directory-team', source: 'ldap', externalId: 'cn=team,dc=fixture' });
    await db.insert(schema.userExternalGroups).values({ userId: 'bob', source: 'ldap', externalId: 'cn=team,dc=fixture' });
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.botId, 'team'));
    await db.insert(schema.botAccess).values({ botId: 'team', groupId: 'directory-team' });
    bob = (await loadPrincipal('bob'))!;
    await configureTeam(admin, 'team', { ...config, expectedVersion: 1, maintainerIds: ['admin','bob'] });
    await runFor(bob, 'directory-member', 'waiting'); await openTeamConversation(bob, 'team', 'admin');
    await syncUserOnSignIn({ upn: bob.user.upn, name: bob.user.name, source: 'ldap', groups: [] });
    expect(fixture.revoke).toHaveBeenCalledTimes(2);
    expect(fixture.revoke.mock.calls.map(c => c[2].mode).sort()).toEqual(['admin','member']);
    expect((await db.select().from(schema.agentRuns))[0].cancelRequestedAt).not.toBeNull();
    await expect(authorizeTeam(bob, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(bob, 'team', 'admin')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(admin, 'team', 'admin')).resolves.toBeDefined();
  });
  it('nested directory refresh records revocation atomically and performs native cleanup only after commit', async () => {
    await db.update(schema.users).set({ identityRealm: 'directory', authSource: 'entra' }).where(eq(schema.users.id, 'alice'));
    await db.insert(schema.groups).values({ id: 'directory-team', name: 'Directory team' });
    await db.insert(schema.groupMappings).values({ groupId: 'directory-team', source: 'entra', externalId: 'synthetic-team' });
    await db.insert(schema.userExternalGroups).values({ userId: 'alice', source: 'entra', externalId: 'synthetic-team' });
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.botId, 'team'));
    await db.insert(schema.botAccess).values({ botId: 'team', groupId: 'directory-team' });
    alice = (await loadPrincipal('alice'))!; await runFor(alice, 'directory-queued');
    await db.transaction(async tx => {
      await syncUserOnSignIn({ upn: alice.user.upn, name: alice.user.name, source: 'entra', groups: [] }, tx);
      expect(fixture.revoke).not.toHaveBeenCalled();
      expect((await tx.select().from(schema.hermesTeamOperations))[0].state).toBe('pending');
      expect((await tx.select().from(schema.agentRuns))[0].cancelRequestedAt).not.toBeNull();
    });
    await reconcileTeamActorAccess('alice');
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
  });
  it('password change, Account Security and admin reset each invalidate grants issued to the previous session', async () => {
    vi.stubEnv('AUTH_LOCAL_ENABLED', 'true');
    await db.update(schema.users).set({ identityRealm: 'directory', authSource: 'entra' }).where(eq(schema.users.id, 'admin'));
    admin = (await loadPrincipal('admin'))!;
    const oldPassword = 'Synthetic old fixture passphrase!'; const nextPassword = 'Synthetic next fixture passphrase!';
    await db.insert(schema.localCredentials).values({ userId: 'alice', username: 'alice', passwordHash: await hashPassword(oldPassword), mustChangePassword: false });
    await runFor(alice, 'password', 'waiting');
    await changeOwnPassword(alice.user, oldPassword, nextPassword, new Headers());
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(eq(schema.agentRuns.id, 'password'));
    alice = (await loadPrincipal('alice'))!; await runFor(alice, 'security', 'waiting');
    const actor = { ...alice.user, sessionId: 'synthetic-session-binding-value' };
    const proof = await reauthenticatePassword(actor, 'password', nextPassword, '', false, new Headers());
    if (!proof.proof) throw new Error('Synthetic reauthentication failed.');
    await manageSecurity(actor, 'password', proof.proof, 'Synthetic security fixture passphrase!');
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(eq(schema.agentRuns.id, 'security'));
    alice = (await loadPrincipal('alice'))!; await runFor(alice, 'reset', 'waiting');
    await resetLocalPassword(admin.user, 'alice', 'Synthetic reset fixture passphrase!');
    expect(fixture.revoke).toHaveBeenCalledTimes(3);
    expect((await db.select().from(schema.agentRuns)).every(r => r.cancelRequestedAt !== null)).toBe(true);
  }, 20000);
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
  it('blocks first conversion while ordinary work or approvals are open, including a disabled Team definition', async () => {
    await db.insert(schema.bots).values({ id: 'ordinary', ownerId: 'admin', name: 'Ordinary', appId: 'old-app' });
    await db.insert(schema.conversations).values({ id: 'ordinary-history', userId: 'alice', botId: 'ordinary' });
    await db.insert(schema.agentRuns).values({ id: 'ordinary-work', userId: 'alice', botId: 'ordinary', conversationId: 'ordinary-history', messageId: 'ordinary-message', status: 'queued' });
    for (const status of ['queued', 'running', 'waiting', 'waiting_tasks'] as const) {
      await db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, 'ordinary-work'));
      for (const enabled of [false, true])
        await expect(configureTeam(admin, 'ordinary', { ...config, enabled, modelPolicy: { mode: 'personal_required' } })).rejects.toMatchObject({ status: 409 });
    }
    expect((await db.select().from(schema.bots).where(eq(schema.bots.id, 'ordinary')))[0].hermesTeam).toBe(false);
    expect(await db.select().from(schema.hermesTeamDefinitions).where(eq(schema.hermesTeamDefinitions.botId, 'ordinary'))).toEqual([]);
    expect((await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, 'ordinary-work')))[0].cancelRequestedAt).toBeNull();
    expect(await db.select().from(schema.conversations).where(eq(schema.conversations.id, 'ordinary-history'))).toHaveLength(1);
    expect(fixture.revoke).not.toHaveBeenCalled();
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
  it('serializes concurrent cleanup and ignores a stale completed receipt after reopening', async () => {
    await reserveTeamProfile(alice, 'team', 'member');
    await db.transaction(tx => queueTeamAccessReconciliation(tx, 'team', 'admin', { reason: 'policy_changed', force: true }));
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 409 });
    let settle!: (value: { stopped: boolean; interruption: string }) => void;
    fixture.revoke.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const first = reconcileTeamAccess('team');
    await vi.waitFor(() => expect(fixture.revoke).toHaveBeenCalledTimes(1));
    const second = reconcileTeamAccess('team');
    settle({ stopped: true, interruption: 'runtime-wide' });
    await Promise.all([first, second]);
    await reserveTeamProfile(alice, 'team', 'member');
    await reconcileTeamAccess('team');
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
    await expect(authorizeTeam(alice, 'team', 'member')).resolves.toBeDefined();
  });
  it('unknown or corrupted cleanup authority fences renewal instead of dispatching an inferred target', async () => {
    const profile = await reserveTeamProfile(alice, 'team', 'member');
    await db.insert(schema.hermesTeamOperations).values({ botId: 'team', profileId: profile.id, actorId: 'admin', requestId: 'malformed-fixture', kind: 'revoke', digest: 'f'.repeat(64), result: { mode: 'member' } });
    await reconcileTeamAccess('team');
    expect(fixture.revoke).not.toHaveBeenCalled();
    expect((await db.select().from(schema.hermesTeamOperations))[0].state).toBe('needs_attention');
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 409 });
    await expect(authorizeTeam(bob, 'team', 'member')).rejects.toMatchObject({ status: 409 });
    await expect(reserveTeamProfile(alice, 'team', 'member')).rejects.toMatchObject({ status: 409 });
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
    await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: { runtimeId: 'synthetic-private-runtime', profile: 'server-derived-alice' } }).where(eq(schema.hermesTeamProfiles.userId, 'alice'));
    for (const missingReceipt of [{}, { usageReceiptId: 'synthetic-reply-usage' }, { gatewayGrantId: 'synthetic-gateway-grant' }])
      await expect(recordTeamRunAdmission(alice, 'admitted', 'reply', [route], missingReceipt)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamRunAttribution)).toEqual([]);
    for (let n = 0; n < 2; n++) expect(await recordTeamRunAdmission(alice, 'admitted', 'reply', [route], { usageReceiptId: 'synthetic-reply-usage', gatewayGrantId: 'synthetic-gateway-grant' })).toMatchObject({ userId: 'alice', botId: 'team', billing: 'admin', policyVersion: 2 });
    await recordTeamRunAdmission(alice, 'admitted', 'learning', [route], { usageReceiptId: 'synthetic-learning-usage', gatewayGrantId: 'synthetic-gateway-grant' });
    expect(await db.select().from(schema.hermesTeamRunAttribution)).toHaveLength(1);
    const [stored] = await db.select().from(schema.hermesTeamRunAttribution);
    expect(stored.admission).toMatchObject({ routeId: route.id, adapterId: route.adapterId, model: route.model, integration: route.integration, billing: 'admin', gatewayGrantId: 'synthetic-gateway-grant', evidence: { id: route.evidence.id, hermesRevision: HERMES_COMMIT },
      purposes: { reply: { usageReceiptId: 'synthetic-reply-usage' }, learning: { usageReceiptId: 'synthetic-learning-usage' } } });
    await expect(recordTeamRunAdmission(alice, 'admitted', 'reply', [route], { usageReceiptId: 'different-usage', gatewayGrantId: 'synthetic-gateway-grant' })).rejects.toMatchObject({ status: 409 });
    for (const invalid of [{}, { ...stored.admission, secret: 'synthetic' }, { ...stored.admission, model: 'x'.repeat(9000) }, { ...stored.admission, purposes: { arbitrary: { usageReceiptId: null } } }])
      await expect(fixture.client!.query('UPDATE hermes_team_run_attribution SET admission = $1::jsonb WHERE run_id = $2', [JSON.stringify(invalid), 'admitted'])).rejects.toBeDefined();
    await db.update(schema.hermesTeamProfiles).set({ state: 'updating' }).where(eq(schema.hermesTeamProfiles.userId, 'alice'));
    await expect(recordTeamRunAdmission(alice, 'admitted', 'subagent', [route])).rejects.toMatchObject({ status: 409 });
    await db.update(schema.hermesTeamProfiles).set({ state: 'ready' }).where(eq(schema.hermesTeamProfiles.userId, 'alice'));
    await db.update(schema.agentRuns).set({ cancelRequestedAt: new Date() }).where(eq(schema.agentRuns.id, 'admitted'));
    await expect(recordTeamRunAdmission(alice, 'admitted', 'utility', [route])).rejects.toMatchObject({ status: 409 });
  });
  it('persists verified usage intent before an injected synthetic gateway dispatch and never enables a production adapter', async () => {
    const now = Date.now();
    const route: VerifiedTeamModelRoute = { id: 'synthetic', adapterId: 'fixture', integration: 'admin_inference_gateway', model: 'synthetic-model', billing: 'admin', credentialHandling: 'server_gateway',
      evidence: { id: 'synthetic-only-evidence', hermesRevision: HERMES_COMMIT, adapterId: 'fixture', integration: 'admin_inference_gateway', model: 'synthetic-model', purposes: TEAM_MODEL_PURPOSES, verifiedAt: now - 1000, expiresAt: now + 60000 } };
    await configureTeam(admin, 'team', { ...config, expectedVersion: 1, modelPolicy: { mode: 'admin_provided', adminRouteId: route.id } });
    await runFor(alice, 'gateway-intent');
    await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: { runtimeId: 'synthetic-private-runtime', profile: 'server-derived-alice' } }).where(eq(schema.hermesTeamProfiles.userId, 'alice'));
    const dispatch = vi.fn(async (_input: string, _attribution: TeamModelAttribution, receiptId: string) => {
      const [intent] = await db.select().from(schema.hermesTeamRunAttribution);
      expect(intent).toMatchObject({ actorId: 'alice', botId: 'team', definitionVersion: 2, admission: { routeId: route.id, model: route.model, purposes: { utility: { usageReceiptId: receiptId } } } });
      return 'synthetic-result';
    });
    const gateway = createTeamModelGateway({ currentUserId: async () => alice.user.id, routes: [route], now: () => now,
      loadAuthority: async () => {
        const current = await authorizeTeam(alice, 'team', 'member');
        return { userId: alice.user.id, botId: 'team', userEnabled: true, botEnabled: true, audienceAllowed: true, policyVersion: current.definition.version, hermesRevision: HERMES_COMMIT, policy: current.definition.modelPolicy };
      },
      reserveUsage: async attribution => {
        const receipt = { id: 'synthetic-usage-receipt', attribution };
        await recordTeamRunAdmission(alice, attribution.runId, attribution.purpose, [route], { usageReceiptId: receipt.id, gatewayGrantId: 'synthetic-gateway-grant' });
        return receipt;
      }, releaseUsage: vi.fn(), dispatch });
    await expect(gateway.execute({ botId: 'team', runId: 'gateway-intent', purpose: 'utility' }, 'synthetic-input')).resolves.toBe('synthetic-result');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
