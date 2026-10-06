import { readFileSync, readdirSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, schedule: vi.fn(async () => {}) }));
vi.mock('@/lib/jobs', () => ({ scheduleMemoryExtraction: fixture.schedule }));
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
let admin: Principal, alice: Principal, bob: Principal;
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  fixture.schedule.mockClear();
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
});
