import { readFileSync, readdirSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite|null, principal: null as Principal|null,
  proof: vi.fn(), enqueue: vi.fn(), statements: [] as string[], authorize: undefined as undefined|(() => Promise<void>) }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'); const { drizzle } = await import('drizzle-orm/pglite'); const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema, logger: { logQuery(query: string) { fixture.statements.push(query); } } }), schema };
});
// Only readiness evidence is synthetic. Ownership, mode, DB admission, /new and route callbacks are production code.
vi.mock('@/lib/hermes-team/candidate-availability', () => ({ teamNativeAvailability: fixture.proof }));
vi.mock('@/lib/jobs', () => ({ enqueueRun: fixture.enqueue, scheduleMemoryExtraction: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => fixture.principal,
  errorResponse: (error: { status?: number; message?: string }) => Response.json({ error: error.message }, { status: error.status ?? 500 }) }));
vi.mock('@/lib/runs/tail', () => ({ tailRun: (_id: string, options: { authorize?: () => Promise<void> }) => {
  fixture.authorize = options.authorize; return new ReadableStream({ start(controller) { controller.close(); } });
} }));
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { authorizeTeamConversation, openTeamConversation } from '@/lib/hermes-team/conversations';
import { resolveTurnTarget } from '@/lib/agent/target';
import { startRun, continueRun } from '@/lib/runs/store';
import { freshConversation } from '@/lib/chat/fresh';
import { hermesTargetFor, resolveModel } from '@/lib/llm/resolve';
import { POST } from '@/app/api/chat/route';
import { GET } from '@/app/api/chat/[id]/stream/route';
let admin: Principal, alice: Principal, bob: Principal;
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.restoreAllMocks(); vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); fixture.enqueue.mockReset(); fixture.enqueue.mockResolvedValue(undefined);
  fixture.proof.mockReset(); fixture.proof.mockResolvedValue({ available: false, reason: 'No verified model route.', choice: 'default' }); fixture.authorize = undefined;
  await fixture.client!.exec('TRUNCATE users,ai_apps,settings CASCADE');
  await db.insert(schema.users).values([{ id: 'admin', upn: 'admin@test.invalid', name: 'Admin', isAdmin: true, authSource: 'local', identityRealm: 'local' },
    { id: 'alice', upn: 'alice@test.invalid', name: 'Alice', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', upn: 'bob@test.invalid', name: 'Bob', authSource: 'local', identityRealm: 'local' }]);
  admin = (await loadPrincipal('admin'))!; alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!; fixture.principal = alice;
  await db.insert(schema.aiApps).values({ id: 'old-app', name: 'Disabled company app', provider: 'openai-compatible', baseUrl: 'https://company.test.invalid/v1', enabled: false, model: 'company-model', apiKeyEnc: 'never-open-this-company-credential' });
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', appId: 'old-app', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values([{ botId: 'team', userId: 'alice' }, { botId: 'team', userId: 'bob' }]);
  await configureTeam(admin, 'team', { enabled: true, expectedVersion: 0, maintainerIds: ['admin'], modelPolicy: { mode: 'personal_required' } });
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });
async function privateChat(p = alice, mode: 'member'|'admin' = 'member') {
  const opened = await openTeamConversation(p, 'team', mode); const profile = await reserveTeamProfile(p, 'team', mode);
  await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: { bindingId: 'a'.repeat(32), ownerId: profile.ownerKey } }).where(eq(schema.hermesTeamProfiles.id, profile.id));
  const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, opened.conversationId));
  return { conversation, profile };
}
function ready() { fixture.proof.mockResolvedValue({ available: true, reason: 'Synthetic tested route.', choice: 'default', model: 'server-verified-model' }); }
const input = (conversation: typeof schema.conversations.$inferSelect, target: Awaited<ReturnType<typeof resolveTurnTarget>>) =>
  ({ principal: alice, conversation, ...target, parentId: null, userMessage: { id: 'user-message', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Teach a procedure' }] } });
const streamAuthority = () => fixture.authorize;

describe('private Team web admission with injected server evidence', () => {
  it('keeps unavailable proof and unbound new chats closed without company fallback', async () => {
    const { conversation } = await privateChat();
    await expect(resolveTurnTarget(alice, conversation)).rejects.toMatchObject({ status: 409 }); ready();
    await expect(resolveTurnTarget(alice, { botId: 'team', appId: null })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.agentRuns)).toHaveLength(0); expect(fixture.enqueue).not.toHaveBeenCalled();
  });
  it('derives a credential-free target and never lends a private context to another actor', async () => {
    const { conversation } = await privateChat(); ready(); const target = await resolveTurnTarget(alice, conversation);
    expect(target.app).toMatchObject({ id: 'old-app', provider: 'hermes', model: 'server-verified-model', providerConfig: { teamNative: true }, apiKeyEnc: null, providerConnectionId: null });
    expect(JSON.stringify(target.app)).not.toContain('never-open-this-company-credential');
    await expect(resolveTurnTarget(bob, conversation)).rejects.toMatchObject({ status: 404 });
    await expect(resolveTurnTarget(alice, { ...conversation, botId: null, appId: 'old-app' })).rejects.toMatchObject({ status: 404 });
    await expect(hermesTargetFor(target.app)).rejects.toThrow('active server-owned run');
    await expect(resolveModel(target.app, { purpose: 'chat', principal: alice, botId: 'team', conversationId: conversation.id })).rejects.toThrow('active server-owned native run');
  });
  it('retains Team denial after a legacy flag changes and preserves ordinary personal target/admission', async () => {
    const { conversation } = await privateChat(); ready();
    await db.update(schema.bots).set({ hermesTeam: false }).where(eq(schema.bots.id, 'team'));
    await expect(resolveTurnTarget(alice, conversation)).rejects.toBeDefined();
    await expect(resolveTurnTarget(alice, { botId: 'team', appId: null })).rejects.toMatchObject({ status: 409 });
    await db.update(schema.aiApps).set({ enabled: true }).where(eq(schema.aiApps.id, 'old-app'));
    await db.insert(schema.bots).values({ id: 'personal', ownerId: 'alice', name: 'Personal', appId: 'old-app' });
    const [ordinary] = await db.insert(schema.conversations).values({ userId: 'alice', botId: 'personal' }).returning();
    fixture.proof.mockClear(); const target = await resolveTurnTarget(alice, ordinary);
    expect(target.app.provider).toBe('openai-compatible'); expect(fixture.proof).not.toHaveBeenCalled();
    expect((await startRun(input(ordinary, target))).status).toBe('queued');
  });
  it('admits maintained Admin context without requiring membership in the member audience', async () => {
    const { conversation } = await privateChat(admin, 'admin'); ready();
    expect((await resolveTurnTarget(admin, conversation)).bot?.id).toBe('team');
    expect(fixture.proof).toHaveBeenCalledWith(admin, 'team', 'admin', { conversationId: conversation.id });
    await expect(resolveTurnTarget(alice, conversation)).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks proof in the admission transaction after the bot lock and leaves no partial message on failure', async () => {
    const { conversation } = await privateChat(); ready(); const target = await resolveTurnTarget(alice, conversation);
    fixture.proof.mockResolvedValueOnce({ available: false, reason: 'Reconnect your own model.', choice: 'personal' });
    fixture.statements.length = 0; await expect(startRun(input(conversation, target))).rejects.toMatchObject({ status: 409 });
    const botLock = fixture.statements.findIndex(query => query.includes('from "bots"') && query.includes('for share'));
    const userLock = fixture.statements.findIndex(query => query.includes('pg_advisory_xact_lock'));
    expect(botLock).toBeGreaterThanOrEqual(0); expect(userLock).toBeGreaterThan(botLock);
    expect(fixture.proof.mock.lastCall?.[3]).toHaveProperty('q');
    expect(await db.select().from(schema.messages)).toHaveLength(0); expect(await db.select().from(schema.agentRuns)).toHaveLength(0);
  });
  it('queues a verified private Team run without creating a personal Hermes binding', async () => {
    const { conversation } = await privateChat(); ready(); const target = await resolveTurnTarget(alice, conversation);
    const run = await startRun(input(conversation, target)); expect(run).toMatchObject({ status: 'queued', botId: 'team', appId: 'old-app', userId: 'alice' });
    expect(fixture.enqueue).toHaveBeenCalledOnce(); expect(await db.select().from(schema.hermesRunContexts)).toHaveLength(0);
    expect((await db.select().from(schema.messages))[0].parts).toEqual([{ type: 'text', text: 'Teach a procedure' }]);
  });
  it('preserves the exact private instance, mode and personal choice across /new and its retry', async () => {
    const { conversation, profile } = await privateChat(); ready(); const target = await resolveTurnTarget(alice, conversation);
    await db.update(schema.hermesTeamChats).set({ modelChoice: 'personal' }).where(eq(schema.hermesTeamChats.conversationId, conversation.id));
    const next = await freshConversation(alice, { conversationId: conversation.id, ...target }, 'next-team-chat');
    expect((await authorizeTeamConversation(alice, next.id)).chat).toMatchObject({ profileId: profile.id, mode: 'member', modelChoice: 'personal' });
    expect((await freshConversation(alice, { conversationId: conversation.id, ...target }, next.id)).id).toBe(next.id);
    expect(await db.select().from(schema.hermesTeamProfiles)).toHaveLength(1);
    await expect(freshConversation(bob, { conversationId: conversation.id, ...target }, 'wrong-owner-chat')).rejects.toMatchObject({ status: 404 });
  });
  it('refuses paused Team continuation and post-resolution revocation before any queue or message write', async () => {
    const { conversation } = await privateChat(); ready(); const target = await resolveTurnTarget(alice, conversation);
    await expect(continueRun({ principal: alice, conversation, messageId: 'unknown', decisions: new Map() })).rejects.toMatchObject({ status: 409 });
    await db.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId, 'team'), eq(schema.botUserAccess.userId, 'alice')));
    await expect(startRun(input(conversation, target))).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.messages)).toHaveLength(0); expect(fixture.enqueue).not.toHaveBeenCalled();
  });
  it('installs fresh Team authority on the actual POST and reload stream routes', async () => {
    const { conversation } = await privateChat(); ready();
    const response = await POST(new Request('https://app.test.invalid/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, message: { id: 'stream-user', role: 'user', parts: [{ type: 'text', text: 'Synthetic turn' }] } }) }));
    expect(response.status).toBe(200); const postAuthorize = fixture.authorize; expect(postAuthorize).toBeTypeOf('function'); await postAuthorize!();
    fixture.authorize = undefined;
    const resumed = await GET(new Request(`https://app.test.invalid/api/chat/${conversation.id}/stream`), { params: Promise.resolve({ id: conversation.id }) });
    expect(resumed.status).toBe(200); const getAuthorize = streamAuthority(); expect(getAuthorize).toBeTypeOf('function');
    await db.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId, 'team'), eq(schema.botUserAccess.userId, 'alice')));
    await expect(postAuthorize!()).rejects.toMatchObject({ status: 403 }); await expect(getAuthorize!()).rejects.toMatchObject({ status: 403 });
  });
});
