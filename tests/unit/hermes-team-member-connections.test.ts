import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, revoke: vi.fn(), human: null as Principal | null }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: fixture.revoke, dockerFetch: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => fixture.human }));
vi.mock('@/lib/mcp/url', () => ({ checkMcpUrl: vi.fn().mockResolvedValue(null) }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { TEAM_MODEL_PURPOSES, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import { issueTeamCandidateContext } from '@/lib/hermes-team/candidate-context';
import { executeCandidateTool, candidateToolName, answerCandidateApproval, listCandidateTools, listCandidateApprovals } from '@/lib/hermes-team/candidate-tools';
import { candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
import { sealAppSecret } from '@/lib/llm/secrets';
import { encrypt } from '@/lib/crypto';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { candidateResourceAdapter, candidateResourceAdapterId } from '@/lib/hermes-team/candidate-resource-adapter';
import { snapshotHash } from '@/lib/mcp/snapshot';
import { saveTeamMemberMcpConnection, readTeamMemberMcpConnection, revokeTeamMemberMcpConnection,
  resolveMemberMcpConnection, openMemberMcpHeaders, memberMcpBindingHash, rewrapMemberMcpSecrets, revokeOwnedMemberMcpConnection, listTeamMemberMcpConnections, listOwnedMemberMcpConnections } from '@/lib/mcp/member-connections';
import { connectMemberMcp, redactMemberMcpValue } from '@/lib/mcp/member-transport';
import { GET, PUT } from '@/app/api/bots/[id]/team/connections/[capabilityId]/route';
import { GET as retainedGET } from '@/app/api/hermes-team/member-connections/route';
import { DELETE as retainedDELETE } from '@/app/api/hermes-team/member-connections/[id]/route';
let admin: Principal, alice: Principal, bob: Principal;
const def = { name: 'documents.read', inputSchema: { type: 'object' as const, properties: { resourceId: { type: 'string' } }, required: ['resourceId'], additionalProperties: false } };
const adapterId = candidateResourceAdapterId(def);
const adapter = candidateResourceAdapter('documents', def, 'read', { id: 'synthetic-member-evidence', hermesRevision: HERMES_COMMIT,
  adapterId, capabilityId: 'documents', action: def.name, effect: 'read', verifiedAt: 1, expiresAt: 4102444800000 });
const input = (secret = 'synthetic-alice-header', expectedRevision = 0) => ({ expectedRevision, headers: { Authorization: `Bearer ${secret}` }, expiresAt: new Date(Date.now() + 300000).toISOString() });
const server = async () => (await db.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, 'personal-docs')))[0];
const account = async (userId = 'alice') => (await db.select().from(schema.mcpMemberConnections).where(eq(schema.mcpMemberConnections.userId, userId)))[0];
const caller = (p: Principal) => ({ subject: { kind: 'user' as const, id: p.user.id, upn: p.user.upn, email: p.user.email, name: p.user.name, groups: p.groupIds } });
const routeContext = { params: Promise.resolve({ id: 'team', capabilityId: 'documents' }) };
const route: VerifiedTeamModelRoute = { id: 'app:fixture', adapterId: 'collective-openai-chat-v1', model: 'synthetic-model', billing: 'admin', integration: 'admin_inference_gateway', credentialHandling: 'server_gateway',
  evidence: { id: 'synthetic-only', hermesRevision: HERMES_COMMIT, adapterId: 'collective-openai-chat-v1', model: 'synthetic-model', integration: 'admin_inference_gateway', purposes: TEAM_MODEL_PURPOSES, verifiedAt: 1, expiresAt: 4102444800000 } };
async function readyCandidateRun(p: Principal, id = 'member-run', mode: 'member' | 'admin' = 'member') {
  if (!(await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, 'fixture'))).length)
    await db.insert(schema.aiApps).values({ id: 'fixture', name: 'Synthetic provider', provider: 'openai-compatible', baseUrl: 'https://provider.test.invalid/v1', model: route.model, credentialMode: 'org', apiKeyEnc: sealAppSecret('fixture', 'synthetic-provider-only') });
  route.transportHash = (await candidateWireMetadata(p, route)).hash;
  const chat = await openTeamConversation(p, 'team', mode), profile = await reserveTeamProfile(p, 'team', mode);
  await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: { bindingId: 'a'.repeat(32), ownerId: profile.ownerKey, botId: 'team', teamBotId: 'team', appId: 'team', runtimeId: 'synthetic-runtime', profile: `cui-team-${'b'.repeat(32)}`, identity: 'synthetic-native-identity', purpose: `team-${mode}`, name: 'Team', modelPolicy: 'admin_provided' } }).where(eq(schema.hermesTeamProfiles.id, profile.id));
  await db.insert(schema.agentRuns).values({ id, userId: p.user.id, botId: 'team', conversationId: chat.conversationId, messageId: `${id}-message` });
  return { ...await issueTeamCandidateContext(p, id, 'default', [route]), conversationId: chat.conversationId };
}
const nativeRequest = (token: string, body: unknown, id = randomUUID(), signal?: AbortSignal) => new Request('https://app.test.invalid/native', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-collective-request-id': id }, body: JSON.stringify(body), signal,
});
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('AUTH_URL', 'https://app.test.invalid'); vi.stubEnv('ENCRYPTION_KEY', 'synthetic-member-connection-fixture-only');
  vi.stubEnv('ENCRYPTION_KEYS', ''); vi.stubEnv('ENCRYPTION_PRIMARY_KID', '');
  fixture.revoke.mockResolvedValue({ stopped: true, interruption: 'none' }); fixture.human = null;
  await fixture.client!.exec('TRUNCATE users,ai_apps,groups,mcp_servers,settings CASCADE');
  await db.insert(schema.users).values([{ id: 'admin', upn: 'admin@test.invalid', name: 'Admin', isAdmin: true, authSource: 'local', identityRealm: 'local' },
    { id: 'alice', upn: 'alice@test.invalid', name: 'Alice', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', upn: 'bob@test.invalid', name: 'Bob', authSource: 'local', identityRealm: 'local' }]);
  admin = (await loadPrincipal('admin'))!; alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!;
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values([{ botId: 'team', userId: 'alice' }, { botId: 'team', userId: 'bob' }]);
  // Unreadable shared secrets are intentional: no member path may try opening them.
  await db.insert(schema.mcpServers).values({ id: 'personal-docs', name: 'Documents', url: 'https://member.test.invalid/mcp', status: 'enabled', trust: 'trusted',
    toolsSnapshot: [def], toolsHash: snapshotHash([def]), headersEnc: 'not-a-readable-company-ciphertext', identityHeader: 'X-Portal-Identity', identitySecretEnc: 'not-a-readable-company-signing-secret' });
  await configureTeam(admin, 'team', { enabled: true, expectedVersion: 0, maintainerIds: ['admin'], modelPolicy: { mode: 'admin_provided', adminRouteId: 'app:fixture' },
    toolPolicy: { capabilities: [{ capabilityId: 'documents', connectionMode: 'member_connection', connectionId: 'personal-docs', adapterId, action: def.name, resourceIds: ['document-a'], effect: 'read', requireApproval: false }] } });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('Owner-bound member MCP account storage', () => {
  it('stores only encrypted personal headers and returns private safe metadata for the current actor', async () => {
    const result = await saveTeamMemberMcpConnection(alice, 'team', 'documents', input());
    expect(result).toMatchObject({ status: 'connected', revision: 1 });
    const own = await account(), endpoint = await server();
    expect(own.headersEnc).not.toContain('synthetic-alice-header'); expect(openMemberMcpHeaders(own, endpoint)).toEqual({ authorization: 'Bearer synthetic-alice-header' });
    expect(JSON.stringify(await readTeamMemberMcpConnection(alice, 'team', 'documents'))).not.toMatch(/headers|synthetic-alice-header|targetHash/);
    expect(await readTeamMemberMcpConnection(bob, 'team', 'documents')).toEqual({ status: 'connection_needed', revision: 0 });
    expect(await resolveMemberMcpConnection('bob', endpoint)).toBeNull();
  });
  it('never accepts a browser actor, URL, server ID or credential identity and rechecks the current audience', async () => {
    for (const extra of [{ userId: 'bob' }, { url: 'https://other.test.invalid/mcp' }, { serverId: 'company' }, { id: 'bob-account' }])
      await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', { ...input(), ...extra })).rejects.toBeDefined();
    await db.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId, 'team'), eq(schema.botUserAccess.userId, 'alice')));
    await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', input())).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.mcpMemberConnections)).toHaveLength(0);
  });
  it.each(['mcp', 'mcp:personal-docs'])('does not save a personal credential when the admin disabled %s', async disabled => {
    await db.insert(schema.settings).values({ key: 'tools', value: { disabledTools: [disabled] } });
    await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', input())).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.mcpMemberConnections)).toHaveLength(0);
  });
  it('bounds headers/expiry, forbids transport/identity injection and does not silently accept cleartext endpoints', async () => {
    for (const headers of [{ Host: 'other.test.invalid' }, { 'X-Portal-Identity': 'forged' }, { 'X-Collective-Request-Id': 'forged' },
      { Cookie: 'secret' }, { Authorization: 'one', authorization: 'two' }, { Authorization: 'line\r\nbreak' }, { Authorization: '   ' }, {}, { Authorization: 'x'.repeat(8001) }])
      await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', { ...input(), headers })).rejects.toBeDefined();
    for (const expiresAt of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 31 * 86400000).toISOString()])
      await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', { ...input(), expiresAt })).rejects.toBeDefined();
    await db.update(schema.mcpServers).set({ url: 'http://127.0.0.1/mcp' }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', input())).rejects.toMatchObject({ status: 409 });
  });
  it('uses revision CAS for concurrent rotations and binds ciphertext to owner, row and reviewed target', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input());
    const endpoint = await server(), before = await account(), binding = memberMcpBindingHash(endpoint, before);
    const results = await Promise.allSettled([saveTeamMemberMcpConnection(alice, 'team', 'documents', input('first', 1)), saveTeamMemberMcpConnection(alice, 'team', 'documents', input('second', 1))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect((await account()).revision).toBe(2);
    expect(memberMcpBindingHash(endpoint, await account())).not.toBe(binding);
    await saveTeamMemberMcpConnection(bob, 'team', 'documents', input('bob'));
    const b = await account('bob');
    for (const changed of [{ ...before, id: b.id }, { ...before, userId: 'bob' }, { ...before, serverId: 'other' }, { ...before, targetHash: 'a'.repeat(64) }])
      expect(() => openMemberMcpHeaders(changed, endpoint)).toThrow();
    const legacy = encrypt(JSON.stringify({ authorization: 'Bearer other-owner' })).split('.').slice(2).join('.');
    expect(() => openMemberMcpHeaders({ ...before, headersEnc: legacy }, endpoint)).toThrow();
    await expect(db.update(schema.mcpMemberConnections).set({ userId: 'bob', revision: 3 }).where(eq(schema.mcpMemberConnections.id, before.id))).rejects.toBeDefined();
    await expect(db.update(schema.mcpMemberConnections).set({ revision: 1 }).where(eq(schema.mcpMemberConnections.id, before.id))).rejects.toBeDefined();
    await expect(db.update(schema.mcpMemberConnections).set({ targetHash: 'e'.repeat(64), revision: 3 }).where(eq(schema.mcpMemberConnections.id, before.id))).rejects.toBeDefined();
  });
  it.each(['url', 'transport', 'policy'] as const)('invalidates old credentials after a reviewed %s change before decryption or initialize', async kind => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const own = await account();
    await db.update(schema.mcpServers).set(kind === 'url' ? { url: 'https://replacement.test.invalid/mcp' } : kind === 'transport' ? { transport: 'sse' } : { policyRevision: 2 }).where(eq(schema.mcpServers.id, 'personal-docs'));
    const endpoint = await server(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await resolveMemberMcpConnection('alice', endpoint)).toBeNull();
    const who = caller(alice);
    await expect(connectMemberMcp(endpoint, own, { ...who, authorize: async () => who })).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled(); expect(await readTeamMemberMcpConnection(alice, 'team', 'documents')).toMatchObject({ status: 'connection_needed', revision: 1 });
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input('explicitly-reconnected', 1));
    expect(openMemberMcpHeaders(await account(), endpoint).authorization).toBe('Bearer explicitly-reconnected');
  });
  it('disconnects only the current actor and persists revocation without deleting historical conversations', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); await saveTeamMemberMcpConnection(bob, 'team', 'documents', input('bob'));
    expect(await revokeTeamMemberMcpConnection(alice, 'team', 'documents', { expectedRevision: 1 })).toMatchObject({ status: 'revoked', revision: 2 });
    expect(await resolveMemberMcpConnection('alice', await server())).toBeNull(); expect(await resolveMemberMcpConnection('bob', await server())).not.toBeNull();
    const revoked = await account(), endpoint = await server();
    expect(() => openMemberMcpHeaders(revoked, endpoint)).toThrow();
  });
  it('allows only the enabled session owner to disconnect a retained account after capability and audience removal', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const own = await account(), chat = await openTeamConversation(alice, 'team', 'member');
    await db.update(schema.hermesTeamDefinitions).set({ toolPolicy: { capabilities: [] } }).where(eq(schema.hermesTeamDefinitions.botId, 'team'));
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'alice'));
    expect((await listOwnedMemberMcpConnections(alice)).connections).toEqual([{ id: own.id, name: 'Documents', revision: 1, expiresAt: own.expiresAt.toISOString(), status: 'connected' }]);
    expect((await listOwnedMemberMcpConnections(bob)).connections).toEqual([]);
    expect((await listOwnedMemberMcpConnections(admin)).connections).toEqual([]);
    await expect(listOwnedMemberMcpConnections({ ...alice, user: { ...alice.user, sessionVersion: 99 } })).rejects.toMatchObject({ status: 403 });
    await expect(revokeOwnedMemberMcpConnection(bob, own.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(revokeOwnedMemberMcpConnection(admin, own.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(revokeOwnedMemberMcpConnection({ ...alice, user: { ...alice.user, sessionVersion: 99 } }, own.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    expect(await revokeOwnedMemberMcpConnection(alice, own.id, { expectedRevision: 1 })).toMatchObject({ status: 'revoked', revision: 2 });
    await expect(revokeOwnedMemberMcpConnection(alice, own.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamProfiles)).toHaveLength(1);
    expect(await db.select().from(schema.conversations).where(eq(schema.conversations.id, chat.conversationId))).toHaveLength(1);
  });
  it('rejects retained-account disconnect from a disabled owner without granting admin oversight', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const own = await account();
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'alice'));
    await expect(listOwnedMemberMcpConnections(alice)).rejects.toMatchObject({ status: 403 });
    await expect(revokeOwnedMemberMcpConnection(alice, own.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    expect((await account()).status).toBe('active');
  });
  it('rejects transplanted pre-AAD ciphertext rather than silently rewrapping it into an accepted account', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const own = await account();
    const legacy = encrypt(JSON.stringify({ authorization: 'Bearer legacy-other-owner' })).split('.').slice(2).join('.');
    await db.update(schema.mcpMemberConnections).set({ headersEnc: legacy, revision: 2 }).where(eq(schema.mcpMemberConnections.id, own.id));
    await expect(rewrapMemberMcpSecrets()).rejects.toMatchObject({ status: 409 });
    expect((await account()).headersEnc).toBe(legacy);
    const endpoint = await server();
    expect(() => openMemberMcpHeaders({ ...own, headersEnc: legacy }, endpoint)).toThrow();
  });
  it('allows local disconnect after admin disables MCP/server/Team without permitting a credential save', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input());
    await db.insert(schema.settings).values({ key: 'tools', value: { disabledTools: ['mcp'] } });
    await db.update(schema.mcpServers).set({ status: 'disabled' }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await db.update(schema.hermesTeamDefinitions).set({ enabled: false }).where(eq(schema.hermesTeamDefinitions.botId, 'team'));
    await expect(saveTeamMemberMcpConnection(alice, 'team', 'documents', input('next', 1))).rejects.toBeDefined();
    expect(await revokeTeamMemberMcpConnection(alice, 'team', 'documents', { expectedRevision: 1 })).toMatchObject({ status: 'revoked', revision: 2 });
  });
  it('returns only fixed own required-account inventory and keeps real setup unavailable', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input());
    const result = await listTeamMemberMcpConnections(alice, 'team');
    expect(result.connections).toHaveLength(1); expect(result.connections[0]).toMatchObject({ capabilityId: 'documents', name: 'Documents', status: 'connected', revision: 1, available: false, setup: { kind: 'unavailable' } });
    expect(JSON.stringify(result)).not.toMatch(/headers|targetHash|member\.test\.invalid|synthetic-alice-header/);
    expect((await listTeamMemberMcpConnections(bob, 'team')).connections[0]).toMatchObject({ status: 'connection_needed', revision: 0 });
  });
  it('rewraps personal ciphertext under row locks without resurrecting revoked credentials', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); await saveTeamMemberMcpConnection(bob, 'team', 'documents', input('bob'));
    await revokeTeamMemberMcpConnection(bob, 'team', 'documents', { expectedRevision: 1 });
    vi.stubEnv('ENCRYPTION_KEYS', 'fixture:' + Buffer.alloc(32, 7).toString('base64')); vi.stubEnv('ENCRYPTION_PRIMARY_KID', 'fixture');
    expect(await rewrapMemberMcpSecrets()).toBe(2); expect(await rewrapMemberMcpSecrets()).toBe(0);
    const a = await account(), b = await account('bob'); expect(a.headersEnc).toMatch(/^v2\.fixture\./); expect(a.revision).toBe(2); expect(b.status).toBe('revoked'); expect(b.revision).toBe(3);
    expect(openMemberMcpHeaders(a, await server()).authorization).toBe('Bearer synthetic-alice-header');
    expect(await resolveMemberMcpConnection('bob', await server())).toBeNull();
  });
  it('owner-scoped HTTP requires origin and returns no credential data to another member', async () => {
    fixture.human = alice;
    const make = (origin: string) => new Request('https://app.test.invalid/api/bots/team/team/connections/documents', { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(input()) });
    expect((await PUT(make('https://other.test.invalid'), routeContext)).status).toBe(403);
    const response = await PUT(make('https://app.test.invalid'), routeContext); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('synthetic-alice-header'); fixture.human = bob;
    const other = await GET(new Request('https://app.test.invalid'), routeContext); expect(await other.json()).toEqual({ status: 'connection_needed', revision: 0 });
  });
  it('retained account HTTP offers private offboarded cleanup and requires the enabled owner session and origin', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const own = await account();
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'alice'));
    await db.update(schema.hermesTeamDefinitions).set({ toolPolicy: { capabilities: [] } }).where(eq(schema.hermesTeamDefinitions.botId, 'team'));
    const url = 'https://app.test.invalid/api/hermes-team/member-connections', context = { params: Promise.resolve({ id: own.id }) };
    fixture.human = alice;
    const list = await retainedGET(new Request(url));
    expect(list.status).toBe(200); expect(list.headers.get('cache-control')).toBe('no-store');
    expect(await list.json()).toEqual({ connections: [{ id: own.id, name: 'Documents', revision: 1, expiresAt: own.expiresAt.toISOString(), status: 'connected' }], nextCursor: null });
    expect((await retainedGET(new Request(`${url}?userId=bob`))).status).toBe(400);
    expect((await retainedGET(new Request(`${url}?cursor=invalid`))).status).toBe(400);
    const deletion = (origin: string) => new Request(`${url}/${own.id}`, { method: 'DELETE', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1 }) });
    expect((await retainedDELETE(deletion('https://other.test.invalid'), context)).status).toBe(403);
    fixture.human = bob;
    expect(await (await retainedGET(new Request(url))).json()).toEqual({ connections: [], nextCursor: null });
    expect((await retainedDELETE(deletion('https://app.test.invalid'), context)).status).toBe(404);
    fixture.human = { ...alice, user: { ...alice.user, sessionVersion: 99 } };
    expect((await retainedGET(new Request(url))).status).toBe(403);
    fixture.human = alice;
    expect((await retainedDELETE(deletion('https://app.test.invalid'), context)).status).toBe(200);
    expect((await account()).status).toBe('revoked');
  });
  it('actual SDK transport sends only the owner headers and reauthorizes initialize/call without company secret access', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const endpoint = await server(), own = await account();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe(endpoint.url); const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-alice-header'); expect(headers.has('X-Portal-Identity')).toBe(false); expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      if (!body.id) return new Response(null, { status: 202 });
      const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-member', version: '1' } }
        : { content: [{ type: 'text', text: 'synthetic-alice-header private result' }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }); vi.stubGlobal('fetch', fetch);
    const who = caller(alice), authorize = vi.fn(async () => who), client = await connectMemberMcp(endpoint, own, { ...who, authorize });
    try {
      const result = await client.callTool({ name: def.name, arguments: { resourceId: 'document-a' } });
      expect(JSON.stringify(redactMemberMcpValue(result, endpoint, own))).not.toContain('synthetic-alice-header');
      expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally { await client.close(); }
  });
});

describe('Native member MCP authorization and approval continuation', () => {
  it('production native HTTP holds approval, normalizes own wire headers and keeps echoed tokens out of results and durable replay', async () => {
    await db.update(schema.mcpServers).set({ toolPolicy: { [def.name]: { requireApproval: true } }, policyRevision: 2 }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', { ...input(), headers: { Authorization: '  Bearer synthetic-alice-header  ' } });
    const grant = await readyCandidateRun(alice), endpoint = await server(), nonce = randomUUID();
    expect(openMemberMcpHeaders(await account(), endpoint)).toEqual({ authorization: 'Bearer synthetic-alice-header' });
    const methods: string[] = [], fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe(endpoint.url); expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-alice-header'); expect(headers.has('X-Portal-Identity')).toBe(false);
      const body = JSON.parse(String(init?.body)); methods.push(body.method);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-member', version: '1' } }
        : { content: [{ type: 'text', text: 'Own result synthetic-alice-header' }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }); vi.stubGlobal('fetch', fetch);
    const connect = vi.fn(), body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: candidateToolName('documents'), arguments: { resourceId: 'document-a' } } };
    const dependencies = { routes: [route], adapters: [adapter], connect, approvalWaitMs: 2000 };
    const pending = candidateMcpHttp(nativeRequest(grant.toolToken, body, nonce), grant.contextId, dependencies);
    await vi.waitFor(async () => expect(await db.select().from(schema.hermesTeamCandidateApprovals)).toHaveLength(1));
    expect(fetch).not.toHaveBeenCalled();
    const approval = (await db.select().from(schema.hermesTeamCandidateApprovals))[0];
    await answerCandidateApproval(alice, approval.id, 'approved', dependencies);
    const response = await pending; expect(response.status).toBe(200);
    expect(await response.text()).toContain('Own result [redacted]');
    expect(methods.filter(method => method === 'tools/call')).toHaveLength(1); expect(connect).not.toHaveBeenCalled();
    const fetched = fetch.mock.calls.length;
    const replay = await candidateMcpHttp(new Request(nativeRequest(grant.toolToken, body, nonce), { headers: {
      authorization: `Bearer ${grant.toolToken}`, 'content-type': 'application/json', 'x-collective-request-id': nonce, 'x-collective-approval-id': approval.id,
    } }), grant.contextId, dependencies);
    expect(replay.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(fetched);
    const receipt = (await db.select().from(schema.hermesTeamCandidateRequests))[0];
    expect(receipt.state).toBe('complete'); expect(JSON.stringify(receipt.response)).not.toContain('synthetic-alice-header');
  });
  it('an assigned Admin-mode maintainer outside member audience can connect and use only their own required account', async () => {
    await saveTeamMemberMcpConnection(admin, 'team', 'documents', input('synthetic-admin-header'));
    expect((await listTeamMemberMcpConnections(admin, 'team')).connections[0]).toMatchObject({ status: 'connected', available: false });
    await db.insert(schema.users).values({ id: 'other-admin', upn: 'other-admin@test.invalid', name: 'Other admin', isAdmin: true, authSource: 'local', identityRealm: 'local' });
    const other = (await loadPrincipal('other-admin'))!;
    await expect(saveTeamMemberMcpConnection(other, 'team', 'documents', input('forbidden'))).rejects.toMatchObject({ status: 403 });
    await expect(listTeamMemberMcpConnections(other, 'team')).rejects.toMatchObject({ status: 403 });
    const grant = await readyCandidateRun(admin, 'admin-run', 'admin'), callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'shared working result' }] });
    const connectMember = vi.fn().mockImplementation(async (endpoint, own, who) => {
      expect(own.userId).toBe('admin'); expect(who.subject.id).toBe('admin'); expect(openMemberMcpHeaders(own, endpoint).authorization).toBe('Bearer synthetic-admin-header');
      return { callTool, close: vi.fn().mockResolvedValue(undefined) };
    });
    await executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, { routes: [route], adapters: [adapter], connectMember });
    expect(callTool).toHaveBeenCalledOnce();
  });
  it('does not list or call a missing member account and never opens a shared connection', async () => {
    const grant = await readyCandidateRun(alice), connect = vi.fn(), connectMember = vi.fn(), dependencies = { routes: [route], adapters: [adapter], connect, connectMember };
    expect(await listCandidateTools(grant.contextId, `Bearer ${grant.toolToken}`, dependencies)).toEqual([]);
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, dependencies)).rejects.toBeDefined();
    expect(connect).not.toHaveBeenCalled(); expect(connectMember).not.toHaveBeenCalled(); expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(0);
  });
  it('two actors resolve only their own account and retain private results without any team-secret fallback', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); await saveTeamMemberMcpConnection(bob, 'team', 'documents', input('synthetic-bob-header'));
    const grants = [await readyCandidateRun(alice), await readyCandidateRun(bob, 'bob-run')], connect = vi.fn();
    const connectMember = vi.fn().mockImplementation(async (endpoint, own, who) => {
      expect(own.userId).toBe(who.subject.id); const headers = openMemberMcpHeaders(own, endpoint);
      expect(headers.authorization).toBe(`Bearer synthetic-${who.subject.id}-header`); await who.authorize();
      return { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: `${who.subject.id} private result ${headers.authorization}` }] }), close: vi.fn().mockResolvedValue(undefined) };
    });
    const dependencies = { routes: [route], adapters: [adapter], connect, connectMember };
    for (const grant of grants) {
      expect(await listCandidateTools(grant.contextId, `Bearer ${grant.toolToken}`, dependencies)).toHaveLength(1);
      const response = await executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, dependencies);
      expect(response.body).not.toMatch(/synthetic-alice-header|synthetic-bob-header|not-a-readable-company/);
    }
    expect(connect).not.toHaveBeenCalled(); expect(connectMember).toHaveBeenCalledTimes(2);
    expect((await db.select().from(schema.hermesTeamCandidateRequests)).every(row => row.state === 'complete')).toBe(true);
  });
  it('blocks forged scopes and stale or disabled audience before own credentials are resolved', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), connectMember = vi.fn();
    const dependencies = { routes: [route], adapters: [adapter], connectMember };
    for (const args of [{ resourceId: 'private-bob' }, { resourceId: 'document-a', actorId: 'bob' }, { resourceId: 'document-a', connectionId: 'company' }])
      await expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), args, undefined, dependencies)).rejects.toBeDefined();
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'alice'));
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, dependencies)).rejects.toBeDefined();
    expect(connectMember).not.toHaveBeenCalled();
  });
  it.each(['reserved', 'running', 'needs_attention'] as const)('a persisted %s tool receipt fences fresh UUID dispatch after a crash', async state => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), connectMember = vi.fn();
    await db.insert(schema.hermesTeamCandidateRequests).values({ contextId: grant.contextId, requestId: randomUUID(), kind: 'tool', state, inputHash: 'a'.repeat(64) });
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, { routes: [route], adapters: [adapter], connectMember })).rejects.toMatchObject({ status: 409 });
    expect(connectMember).not.toHaveBeenCalled(); expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(1);
  });
  it('honors server-required human approval and rotation invalidates its exact account binding', async () => {
    await db.update(schema.mcpServers).set({ toolPolicy: { [def.name]: { requireApproval: true } }, policyRevision: 2 }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), nonce = randomUUID(), connectMember = vi.fn();
    const dependencies = { routes: [route], adapters: [adapter], connectMember }, args = { resourceId: 'document-a' };
    const pending = JSON.parse((await executeCandidateTool(nativeRequest(grant.toolToken, args, nonce), grant.contextId, candidateToolName('documents'), args, undefined, dependencies)).body);
    const id = pending._meta.collectiveApprovalId; expect(id).toBeTruthy(); expect(await listCandidateApprovals(alice, grant.conversationId, dependencies)).toHaveLength(1);
    await expect(answerCandidateApproval(bob, id, 'approved', dependencies)).rejects.toMatchObject({ status: 404 });
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input('rotated-personal-only', 1));
    await expect(answerCandidateApproval(alice, id, 'approved', dependencies)).rejects.toBeDefined();
    expect(await listCandidateApprovals(alice, grant.conversationId, dependencies)).toEqual([]);
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, args, nonce), grant.contextId, candidateToolName('documents'), args, id, dependencies)).rejects.toBeDefined();
    expect(connectMember).not.toHaveBeenCalled(); expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(0);
  });
  it.each(['url', 'transport'] as const)('a %s change during approval rejects before any own credential reaches initialize', async field => {
    await db.update(schema.mcpServers).set({ toolPolicy: { [def.name]: { requireApproval: true } }, policyRevision: 2 }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const dependencies = { routes: [route], adapters: [adapter], approvalWaitMs: 2000 };
    const pending = candidateMcpHttp(nativeRequest(grant.toolToken, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: candidateToolName('documents'), arguments: { resourceId: 'document-a' } } }), grant.contextId, dependencies);
    await vi.waitFor(async () => expect(await db.select().from(schema.hermesTeamCandidateApprovals)).toHaveLength(1));
    const approval = (await db.select().from(schema.hermesTeamCandidateApprovals))[0];
    await db.update(schema.mcpServers).set(field === 'url' ? { url: 'https://replacement.test.invalid/mcp' } : { transport: 'sse' }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await expect(answerCandidateApproval(alice, approval.id, 'approved', dependencies)).rejects.toBeDefined();
    expect((await pending).status).not.toBe(200); expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(0);
  });
  it('consumes an approved exact member call once and refuses cached replay after the personal account rotates', async () => {
    await db.update(schema.mcpServers).set({ toolPolicy: { [def.name]: { requireApproval: true } }, policyRevision: 2 }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), nonce = randomUUID(), args = { resourceId: 'document-a' };
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'private result' }] }), connectMember = vi.fn().mockResolvedValue({ callTool, close: vi.fn().mockResolvedValue(undefined) });
    const dependencies = { routes: [route], adapters: [adapter], connectMember };
    const pending = JSON.parse((await executeCandidateTool(nativeRequest(grant.toolToken, args, nonce), grant.contextId, candidateToolName('documents'), args, undefined, dependencies)).body), id = pending._meta.collectiveApprovalId;
    await answerCandidateApproval(alice, id, 'approved', dependencies);
    for (let count = 0; count < 2; count++) await executeCandidateTool(nativeRequest(grant.toolToken, args, nonce), grant.contextId, candidateToolName('documents'), args, id, dependencies);
    expect(callTool).toHaveBeenCalledOnce(); expect((await db.select().from(schema.hermesTeamCandidateApprovals))[0].state).toBe('consumed');
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input('rotated', 1));
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, args, nonce), grant.contextId, candidateToolName('documents'), args, id, dependencies)).rejects.toBeDefined();
    expect(callTool).toHaveBeenCalledOnce();
  });
  it('blocks revocation during initialization before tools/call', async () => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), callTool = vi.fn();
    const connectMember = vi.fn().mockImplementation(async () => {
      await revokeTeamMemberMcpConnection(alice, 'team', 'documents', { expectedRevision: 1 });
      return { callTool, close: vi.fn().mockResolvedValue(undefined) };
    }), dependencies = { routes: [route], adapters: [adapter], connectMember };
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, dependencies)).rejects.toBeDefined();
    expect(callTool).not.toHaveBeenCalled(); expect((await db.select().from(schema.hermesTeamCandidateRequests))[0].state).toBe('needs_attention');
  });
  it.each(['expire', 'disconnect'] as const)('aborts an active member call on %s and fences a fresh nonce', async kind => {
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice);
    let started!: () => void; const launched = new Promise<void>(resolve => { started = resolve; });
    const callTool = vi.fn().mockImplementation(({ options }) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true }); started(); }));
    const connectMember = vi.fn().mockResolvedValue({ callTool, close: vi.fn().mockResolvedValue(undefined) }), dependencies = { routes: [route], adapters: [adapter], connectMember };
    const rejected = expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, dependencies)).rejects.toMatchObject({ status: 409 });
    await launched;
    if (kind === 'expire') await db.update(schema.mcpMemberConnections).set({ expiresAt: new Date(Date.now() - 1000), revision: 2 }).where(eq(schema.mcpMemberConnections.userId, 'alice'));
    else await revokeTeamMemberMcpConnection(alice, 'team', 'documents', { expectedRevision: 1 });
    await rejected; expect(callTool).toHaveBeenCalledOnce();
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input('reconnected', 2));
    await expect(executeCandidateTool(nativeRequest(grant.toolToken, {}), grant.contextId, candidateToolName('documents'), { resourceId: 'document-a' }, undefined, dependencies)).rejects.toMatchObject({ status: 409 });
    expect(connectMember).toHaveBeenCalledOnce(); expect((await db.select().from(schema.hermesTeamCandidateRequests))[0].state).toBe('needs_attention');
  });
  it('disconnect during a held approval rejects the native request without detached work or company fallback', async () => {
    await db.update(schema.mcpServers).set({ toolPolicy: { [def.name]: { requireApproval: true } }, policyRevision: 2 }).where(eq(schema.mcpServers.id, 'personal-docs'));
    await saveTeamMemberMcpConnection(alice, 'team', 'documents', input()); const grant = await readyCandidateRun(alice), connectMember = vi.fn(), connect = vi.fn();
    const response = candidateMcpHttp(nativeRequest(grant.toolToken, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: candidateToolName('documents'), arguments: { resourceId: 'document-a' } } }), grant.contextId,
      { routes: [route], adapters: [adapter], connect, connectMember, approvalWaitMs: 2000 });
    await vi.waitFor(async () => expect(await db.select().from(schema.hermesTeamCandidateApprovals)).toHaveLength(1));
    await revokeTeamMemberMcpConnection(alice, 'team', 'documents', { expectedRevision: 1 });
    expect((await response).status).not.toBe(200); expect(connectMember).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(0);
  });
});
