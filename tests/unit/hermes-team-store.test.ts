import { readFileSync, readdirSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, schedule: vi.fn(async () => {}), enqueue: vi.fn(), utility: vi.fn(), ensure: vi.fn() }));
vi.mock('@/lib/jobs', () => ({ scheduleMemoryExtraction: fixture.schedule, enqueue: fixture.enqueue, QUEUES: { learningReview: 'learning.review' } }));
vi.mock('@/lib/llm', async original => ({ ...await original<typeof import('@/lib/llm')>(), utilityApp: fixture.utility }));
vi.mock('@/lib/hermes-team/transport', () => ({ ensureTeamRuntime: fixture.ensure }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'); const { drizzle } = await import('drizzle-orm/pglite'); const schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { authorizeTeam, configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { authorizeTeamConversation, filterTeamConversationViews, openTeamConversation } from '@/lib/hermes-team/conversations';
import { getOwnedConversation } from '@/lib/authz';
import { resolveTurnTarget } from '@/lib/agent/target';
import { afterAssistantSaved } from '@/lib/agent/persist';
import { extractMemoriesFromConversation } from '@/lib/agent/memory';
import { loadGroupMembers } from '@/lib/agent/group';
import { scheduleLearningReview, recoverLearningReviews, reviewNativeRun } from '@/lib/agent/learning/review';
import { learnedSkillsForBot, learningViews } from '@/lib/agent/learning/store';
import { ensureTeamPrivateInstance } from '@/lib/hermes-team/provisioning';
import { teamChatStatus } from '@/lib/hermes-team/conversations';
import { resolveTargetOption } from '@/lib/chat/targets';
import { openBotHome } from '@/lib/chat/home';
let admin: Principal, alice: Principal, bob: Principal;
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  fixture.schedule.mockClear();
  fixture.enqueue.mockClear(); fixture.utility.mockReset();
  fixture.utility.mockImplementation(() => { throw new Error('Company utility access is forbidden in this Team fixture.'); });
  fixture.ensure.mockReset();
  fixture.ensure.mockImplementation(async (p: Principal, botId: string, mode: 'member'|'admin') => ({ bindingId: 'a'.repeat(32), botId, appId: 'runtime-app', ownerId: mode === 'admin' ? `team-admin:${botId}` : p.user.id, runtimeId: 'native-runtime', profile: `cui-team-${'b'.repeat(32)}`, identity: 'native-identity', name: 'Team', purpose: `team-${mode}`, teamBotId: botId, modelPolicy: 'personal_required' }));
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1');
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await db.insert(schema.users).values([
    { id: 'admin', name: 'Admin', upn: 'admin@test.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true },
    { id: 'alice', name: 'Alice', upn: 'alice@test.invalid', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', name: 'Bob', upn: 'bob@test.invalid', authSource: 'local', identityRealm: 'local' },
  ]);
  admin = (await loadPrincipal('admin'))!; alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!;
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values([{ botId: 'team', userId: 'alice' }, { botId: 'team', userId: 'bob' }]);
  await configureTeam(admin, 'team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 0 });
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });
describe('disabled Team Bot schema and fresh authorization', () => {
  it('is disabled by default including reservations, even for administrators', async () => {
    vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '');
    await expect(authorizeTeam(admin, 'team', 'admin')).rejects.toMatchObject({ status: 404 });
    await expect(reserveTeamProfile(alice, 'team', 'member')).rejects.toMatchObject({ status: 404 });
  });
  it('requires both current admin status and this bot maintainer permission', async () => {
    await expect(authorizeTeam(alice, 'team', 'admin')).rejects.toMatchObject({ status: 403 });
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, 'bob'));
    await expect(authorizeTeam(bob, 'team', 'admin')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam({ ...alice, isAdmin: true }, 'team', 'admin')).rejects.toMatchObject({ status: 403 });
    await db.update(schema.users).set({ isAdmin: false }).where(eq(schema.users.id, 'admin'));
    await expect(authorizeTeam(admin, 'team', 'admin')).rejects.toMatchObject({ status: 403 });
  });
  it('reserves one private member instance per user×bot and one separate shared admin instance', async () => {
    const [a, again, b, working] = await Promise.all([reserveTeamProfile(alice, 'team', 'member'), reserveTeamProfile(alice, 'team', 'member'), reserveTeamProfile(bob, 'team', 'member'), reserveTeamProfile(admin, 'team', 'admin')]);
    expect(a.id).toBe(again.id); expect(a.id).not.toBe(b.id); expect(working.ownerKey).toBe('team-admin:team'); expect(working.userId).toBeNull();
    expect(a.ownerKey).toBe('alice'); expect(b.ownerKey).toBe('bob');
  });
  it('instance ownership cannot bypass audience removal; admin oversight is not member access', async () => {
    await reserveTeamProfile(alice, 'team', 'member');
    await db.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId, 'team'), eq(schema.botUserAccess.userId, 'alice')));
    await expect(reserveTeamProfile(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await expect(authorizeTeam(admin, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.hermesTeamProfiles)).toHaveLength(1);
  });
  it('rejects stale sessions and disabled definitions while retaining native mapping reservations', async () => {
    const a = await reserveTeamProfile(alice, 'team', 'member');
    await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'alice'));
    await expect(authorizeTeam(alice, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    await configureTeam(admin, 'team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: false, expectedVersion: 1 });
    await expect(authorizeTeam(bob, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(schema.hermesTeamProfiles))[0].id).toBe(a.id);
  });
  it('rejects stale definition edits and unsafe maintainer grants', async () => {
    const input = { modelPolicy: { mode: 'admin_provided' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 0 };
    await expect(configureTeam(admin, 'team', input)).rejects.toMatchObject({ status: 409 });
    await expect(configureTeam(admin, 'team', { ...input, expectedVersion: 1, maintainerIds: ['admin', 'alice'] })).rejects.toMatchObject({ status: 400 });
    await expect(configureTeam(admin, 'team', { ...input, expectedVersion: 1, profile: '../../default' })).rejects.toBeDefined();
  });
  it('protects existing personal bindings and native volumes from conversion', async () => {
    await db.insert(schema.aiApps).values({ id: 'personal', name: 'Personal', provider: 'hermes', model: 'native', baseUrl: 'http://collective-hermes.invalid', providerConfig: { docker: { ownerId: 'admin' } } });
    await db.insert(schema.bots).values({ id: 'personal-bot', ownerId: 'admin', name: 'Personal', appId: 'personal' });
    await expect(configureTeam(admin, 'personal-bot', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 0 })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(schema.bots).where(eq(schema.bots.id, 'personal-bot')))[0].hermesTeam).toBe(false);
  });
  it('switches mode into a distinct conversation without changing existing private context', async () => {
    await db.insert(schema.botUserAccess).values({ botId: 'team', userId: 'admin' });
    const member = await openTeamConversation(admin, 'team', 'member');
    const working = await openTeamConversation(admin, 'team', 'admin');
    expect(working.conversationId).not.toBe(member.conversationId);
    expect((await openTeamConversation(admin, 'team', 'admin')).conversationId).toBe(working.conversationId);
    expect((await authorizeTeamConversation(admin, member.conversationId)).chat.mode).toBe('member');
    expect((await authorizeTeamConversation(admin, working.conversationId)).chat.mode).toBe('admin');
  });
  it('blocks foreign private routes, saved admin URLs and history after maintainer revocation', async () => {
    const working = await openTeamConversation(admin, 'team', 'admin');
    const member = await openTeamConversation(alice, 'team', 'member');
    await expect(getOwnedConversation(bob, member.conversationId)).rejects.toMatchObject({ status: 404 });
    await expect(authorizeTeamConversation(alice, working.conversationId)).rejects.toMatchObject({ status: 404 });
    await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId, 'admin'));
    await expect(getOwnedConversation(admin, working.conversationId)).rejects.toMatchObject({ status: 403 });
  });
  it('never resolves the previous company app as a fallback for an unverified Team runtime', async () => {
    await db.insert(schema.aiApps).values({ id: 'old-app', name: 'Company', provider: 'openai', model: 'synthetic', isPublic: true });
    await db.update(schema.bots).set({ appId: 'old-app' }).where(eq(schema.bots.id, 'team'));
    await expect(resolveTurnTarget(alice, { botId: 'team', appId: null })).rejects.toMatchObject({ status: 409 });
    await db.insert(schema.conversations).values({ id: 'old-group', userId: 'alice', isGroup: true });
    await db.insert(schema.conversationBots).values({ conversationId: 'old-group', botId: 'team', position: 0 });
    await expect(loadGroupMembers(alice, 'old-group')).rejects.toMatchObject({ status: 403 });
    vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '');
    await expect(loadGroupMembers(alice, 'old-group')).rejects.toMatchObject({ status: 403 });
  });
  it('suppresses duplicate learning queues and old extraction jobs even after definition mutation', async () => {
    const chat = await openTeamConversation(alice, 'team', 'member');
    await afterAssistantSaved({ conversationId: chat.conversationId, userId: 'alice', botId: 'team', responseMessage: { id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Fixture' }] }, isContinuation: false, parentId: null, background: false, extra: { model: 'synthetic', inputTokens: null, outputTokens: null } });
    expect(fixture.schedule).not.toHaveBeenCalled();
    await db.update(schema.bots).set({ hermesTeam: false }).where(eq(schema.bots.id, 'team'));
    expect(await extractMemoriesFromConversation(chat.conversationId)).toBe(0);
  });
  it('filters revoked Admin mode search/sidebar views without filtering unrelated private history', async () => {
    const working = await openTeamConversation(admin, 'team', 'admin');
    await db.insert(schema.conversations).values({ id: 'personal-history', userId: 'admin' });
    const rows = [{ id: working.conversationId, snippet: 'Shared working memory' }, { id: 'personal-history', snippet: 'Private' }];
    expect(await filterTeamConversationViews(admin, rows, r => r.id)).toEqual(rows);
    await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId, 'admin'));
    expect(await filterTeamConversationViews(admin, rows, r => r.id)).toEqual([rows[1]]);
  });
  it('blocks native-harness paid utility scheduling, stale workers and recovery for retained Team contexts', async () => {
    const chat = await openTeamConversation(alice, 'team', 'member');
    await db.insert(schema.aiApps).values({ id: 'company-model', name: 'Company model', provider: 'openai', model: 'synthetic', isPublic: true });
    await db.update(schema.bots).set({ appId: 'company-model' }).where(eq(schema.bots.id, 'team'));
    await db.insert(schema.messages).values([{ id: 'learning-prompt', conversationId: chat.conversationId, role: 'user', parts: [{ type: 'text', text: 'Remember this preference.' }] }, { id: 'learning-reply', conversationId: chat.conversationId, parentId: 'learning-prompt', role: 'assistant', parts: [{ type: 'text', text: 'Synthetic reply.' }] }]);
    await db.insert(schema.agentRuns).values({ id: 'learning-run', userId: 'alice', conversationId: chat.conversationId, messageId: 'learning-reply', parentMessageId: 'learning-prompt', appId: 'company-model', botId: 'team', status: 'succeeded' });
    // A changed definition cannot turn this saved Team context into paid utility work.
    await db.update(schema.bots).set({ hermesTeam: false }).where(eq(schema.bots.id, 'team'));
    await scheduleLearningReview('learning-run');
    expect(await db.select().from(schema.botLearningReviews)).toHaveLength(0);
    await db.insert(schema.botLearningReviews).values({ runId: 'learning-run' });
    expect(await reviewNativeRun('learning-run')).toBe(0);
    expect((await db.select().from(schema.botLearningReviews))[0].completedAt).not.toBeNull();
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    await recoverLearningReviews();
    expect((await db.select().from(schema.botLearningReviews))[0].completedAt).not.toBeNull();
    expect(fixture.enqueue).not.toHaveBeenCalled(); expect(fixture.utility).not.toHaveBeenCalled();
  });
  it('does not expose old native-harness procedures as published Team skills', async () => {
    await db.insert(schema.botLearnings).values({ id: 'legacy-learning', botId: 'team', topic: 'old-topic', kind: 'procedure', status: 'active', verification: 'Synthetic evidence.', content: { name: 'Old procedure', description: 'Never published.', instructions: 'Old company procedure.', expectedOutput: '', boundaries: '' } });
    expect(await learnedSkillsForBot('team', 'alice')).toEqual([]);
    expect(await learningViews(alice, 'team')).toEqual([]);
  });
  it('lazily binds one retained native instance and stays connection-needed without model verification', async () => {
    const first = await ensureTeamPrivateInstance(alice, 'team', 'member');
    const again = await ensureTeamPrivateInstance(alice, 'team', 'member');
    expect(first.id).toBe(again.id); expect(first.state).toBe('connection_needed');
    expect(fixture.ensure).toHaveBeenCalledTimes(2);
    await ensureTeamPrivateInstance(admin, 'team', 'admin');
    expect(fixture.ensure.mock.calls[2][2]).toBe('admin');
  });
  it('preserves preparing reservations after broker failure and rejects cross-user native binding responses', async () => {
    fixture.ensure.mockRejectedValueOnce(new Error('Synthetic unavailable broker'));
    const attention = await ensureTeamPrivateInstance(alice, 'team', 'member');
    expect(attention.state).toBe('needs_attention'); expect(attention.binding).toBeNull();
    fixture.ensure.mockResolvedValueOnce({ bindingId: 'a'.repeat(32), botId: 'team', appId: 'runtime-app', ownerId: 'bob', runtimeId: 'native-runtime', profile: `cui-team-${'b'.repeat(32)}`, identity: 'native-identity', name: 'Team', purpose: 'team-member', teamBotId: 'team', modelPolicy: 'personal_required' });
    const denied = await ensureTeamPrivateInstance(alice, 'team', 'member');
    expect(denied.binding).toBeNull(); expect(denied.id).toBe(attention.id);
  });
  it('allows an assigned admin outside member audience to view its separate working controls', async () => {
    const home = await openBotHome(admin, 'team');
    const working = { conversationId: home.id };
    const status = await teamChatStatus(admin, 'team', working.conversationId);
    expect(status).toMatchObject({ mode: 'admin', canMaintain: true });
    expect((await resolveTargetOption(admin, { botId: 'team', conversationId: working.conversationId })).target).toMatchObject({ hermesTeam: true, hermes: true });
    expect(await teamChatStatus(admin, 'team')).toMatchObject({ canMaintain: true });
    await expect(openTeamConversation(admin, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(schema.hermesTeamProfiles)).every(p => p.mode === 'admin')).toBe(true);
    expect((await authorizeTeamConversation(alice, (await openBotHome(alice, 'team')).id)).chat.mode).toBe('member');
  });
  it('does not bind a profile when settings change during broker I/O', async () => {
    const native = fixture.ensure.getMockImplementation()!;
    fixture.ensure.mockImplementationOnce(async (...args) => {
      const response = await native(...args);
      await configureTeam(admin, 'team', { modelPolicy: { mode: 'admin_provided' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 1 });
      return response;
    });
    const result = await ensureTeamPrivateInstance(alice, 'team', 'member');
    expect(result.state).toBe('needs_attention'); expect(result.binding).toBeNull();
  });
  it('refreshes mutable native policy/name without replacing retained identity and renews after a broker restart', async () => {
    const first = await ensureTeamPrivateInstance(alice, 'team', 'member');
    await configureTeam(admin, 'team', { modelPolicy: { mode: 'admin_provided' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 1 });
    fixture.ensure.mockResolvedValue({ ...first.binding, name: 'Renamed Team', modelPolicy: 'admin_provided' });
    const refreshed = await ensureTeamPrivateInstance(alice, 'team', 'member');
    expect(refreshed.id).toBe(first.id); expect(refreshed.state).toBe('connection_needed');
    expect(refreshed.binding).toMatchObject({ name: 'Renamed Team', modelPolicy: 'admin_provided' });
    fixture.ensure.mockRejectedValueOnce(new Error('Broker restarted; lease needs reopening'));
    expect((await ensureTeamPrivateInstance(alice, 'team', 'member')).state).toBe('needs_attention');
    expect((await ensureTeamPrivateInstance(alice, 'team', 'member')).state).toBe('connection_needed');
    expect(fixture.ensure).toHaveBeenCalledTimes(4);
  });
});
