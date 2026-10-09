import { readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, beforeOpen: null as ((path: string) => Promise<void>) | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => { await fixture.beforeOpen?.(String(args[0])); return actual.open(...args); } };
});
vi.mock('@/db', async () => { const { PGlite } = await import('@electric-sql/pglite'); const { drizzle } = await import('drizzle-orm/pglite'); const schema = await import('@/db/schema'); fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema }; });
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { sha256Hex } from '@/lib/crypto';
import { officialPlanMetadata, openOfficialPlanSecret, OFFICIAL_PLAN_ORIGIN, type VerifiedOfficialAccessClaims } from '@/lib/hermes-team/official-plan';
import { operateOfficialPlanAuth, officialPlanAuthStatus, OFFICIAL_TOKEN_URL } from '@/lib/hermes-team/official-plan-auth';
import { startOfficialPlanTransfer, completeOfficialPlanTransfer, cancelOfficialPlanTransfer, protectedOfficialPlanFileReader, VERIFIED_OFFICIAL_VM_TRANSFERS, type OfficialPlanTransferServices, type OfficialPlanTransfer } from '@/lib/hermes-team/official-plan-vm-transfer';
let alice: Principal, bob: Principal, root: string, services: OfficialPlanTransferServices;
const selected = { clientId: 'issued-alice-work', subject: 'official-alice', workspaceId: 'work-business' };
const file = (actor = 'alice', suffix = 'one') => ({ version: 1, client_id: `issued-${actor}-work`, subject: `official-${actor}`, source_host_id: `source-${actor}`, access_token: `synthetic-access-${actor}-${suffix}`, refresh_token: `synthetic-refresh-${actor}-${suffix}`, id_token: `synthetic-id-${actor}-${suffix}` });
const claims = (actor = 'alice'): VerifiedOfficialAccessClaims => ({ issuer: 'https://auth.openai.com', audience: OFFICIAL_PLAN_ORIGIN, subject: `official-${actor}`, clientId: `issued-${actor}-work`, scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'], issuedAt: Date.now() - 1000, notBefore: Date.now() - 1000, expiresAt: Date.now() + 3500000 });
const receipt = (p: Principal, ticket: OfficialPlanTransfer) => ({ ownerId: p.user.id, clientId: ticket.clientId, subject: ticket.subject, workspaceId: ticket.workspaceId??undefined, sourceHostId: `source-${p.user.id}`, destinationHostId: ticket.hostId, transportId: ticket.transportId, handoffId: ticket.id, refreshOwner: 'collective_vm' as const, verifiedAt: Date.now(), expiresAt: Date.now() + 86400000 });
const io = vi.fn<typeof fetch>();
async function stage(p = alice, suffix = 'one', selection: Parameters<typeof startOfficialPlanTransfer>[1] = selected) {
  const { transferId } = await startOfficialPlanTransfer(p, selection, services);
  const directory = join(root, sha256Hex(p.user.id), transferId); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'credentials.json'), JSON.stringify(file(p.user.id, suffix)), { mode: 0o600 });
  return transferId;
}
async function connected() { const id = await stage(); expect(await completeOfficialPlanTransfer(alice, id, services)).toEqual({ connected: true }); return id; }
beforeAll(async () => { await fixture.client!.waitReady; for (const f of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort()) await fixture.client!.exec(readFileSync(`src/db/migrations/${f}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]')); }, 60000);
beforeEach(async () => {
  vi.restoreAllMocks(); fixture.beforeOpen = null; vi.stubEnv('ENCRYPTION_KEY', 'synthetic-transfer-only'); await fixture.client!.exec('TRUNCATE users CASCADE');
  await db.insert(schema.users).values(['alice', 'bob'].map(id => ({ id, upn: `${id}@test.invalid`, name: id, authSource: 'local' as const, identityRealm: 'local' as const })));
  alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!; root = await mkdtemp(join(tmpdir(), 'collective-transfer-')); await chmod(root, 0o700);
  io.mockReset(); io.mockImplementation(async () => Response.json({ models: [{ slug: 'synthetic-model', visibility: 'list' }] }));
  services = { fetch: io, verifier: { verifyAccessToken: vi.fn(async token => claims(token.includes('bob') ? 'bob' : 'alice')), verifyIdToken: vi.fn(async (_token, expected) => ({ subject: expected.subject! })), revocationEndpoint: vi.fn(async () => 'https://auth.openai.com/api/accounts/oauth/revoke') },
    transports: [{ id: 'synthetic-supported-transfer', hostId: 'persisted-vm-host', read: protectedOfficialPlanFileReader(root), verifyHandoff: vi.fn(async (p, ticket) => receipt(p, ticket)) }] };
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Protected official VM transfer and durable owner custody (synthetic only)', () => {
  it('keeps production import unavailable before file, network or DB mutation', async () => {
    expect(VERIFIED_OFFICIAL_VM_TRANSFERS).toEqual([]);
    await expect(startOfficialPlanTransfer(alice, selected)).rejects.toMatchObject({ status: 409 });
    await expect(completeOfficialPlanTransfer(alice, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.officialPlanTransfers)).toEqual([]); expect(io).not.toHaveBeenCalled();
  });
  it('imports two independent accounts, retains destination host and private provenance, and seals credentials', async () => {
    await connected(); const id = await stage(bob, 'one', { ...selected, clientId: 'issued-bob-work', subject: 'official-bob' }); await completeOfficialPlanTransfer(bob, id, services);
    const rows = await db.select().from(schema.officialPlanConnections);
    for (const row of rows) { expect(row.hostId).toBe('persisted-vm-host'); expect(row.provenance).toMatchObject({ ownerId: row.userId, workspaceId: selected.workspaceId, refreshOwner: 'collective_vm' }); expect(row.tokenBundleEnc).not.toContain('synthetic'); expect(openOfficialPlanSecret(row).access).toBe(file(row.userId).access_token); }
    expect((await officialPlanMetadata('alice', 'synthetic-model'))?.workspaceId).toBe(selected.workspaceId);
    expect((await officialPlanMetadata('alice', 'synthetic-model'))?.bindingHash).not.toBe((await officialPlanMetadata('bob', 'synthetic-model'))?.bindingHash);
    expect(JSON.stringify(await db.select().from(schema.officialPlanTransfers))).not.toMatch(/synthetic-access|synthetic-refresh|synthetic-id/);
    expect(io.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it('isolates the chosen client registration without treating a label or subject as a workspace identifier', async () => {
    const id = await stage(alice, 'one', { clientId: selected.clientId, subject: selected.subject });
    await completeOfficialPlanTransfer(alice, id, services); const row = (await db.select().from(schema.officialPlanConnections))[0];
    expect(row.clientId).toBe(selected.clientId); expect(row.provenance?.workspaceId).toBeUndefined(); expect((await officialPlanMetadata('alice', 'synthetic-model'))?.workspaceId).toBeUndefined();
  });
  it('rejects cross-user completion/cancellation and duplicate completion without reading a file', async () => {
    const id = await stage(); const read = vi.spyOn(services.transports[0], 'read');
    await expect(completeOfficialPlanTransfer(bob, id, services)).rejects.toMatchObject({ status: 404 }); await expect(cancelOfficialPlanTransfer(bob, id)).rejects.toMatchObject({ status: 404 }); expect(read).not.toHaveBeenCalled();
    await completeOfficialPlanTransfer(alice, id, services); await expect(completeOfficialPlanTransfer(alice, id, services)).rejects.toMatchObject({ status: 409 }); expect(read).toHaveBeenCalledOnce();
  });
  it('fences duplicate starts, canceled imports, and delayed completion across restart', async () => {
    const id = await stage(); await expect(startOfficialPlanTransfer(alice, selected, services)).rejects.toMatchObject({ status: 409 });
    let finish!: (value: unknown) => void; let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    const actual = services.transports[0].read; vi.spyOn(services.transports[0], 'read').mockImplementation(async (p, ticket) => { await actual(p, ticket); started(); return new Promise(resolve => { finish = resolve; }); });
    const pending = completeOfficialPlanTransfer(alice, id, services); await entered; await cancelOfficialPlanTransfer(alice, id); finish(file()); await expect(pending).rejects.toMatchObject({ status: 409 });
    await expect(completeOfficialPlanTransfer(alice, id, { ...services })).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]); expect(io).not.toHaveBeenCalled();
  });
  it('disconnect fences a first import during provider I/O before any selected connection exists', async () => {
    const id = await stage(); let release!: (response: Response) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }); io.mockImplementation(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = completeOfficialPlanTransfer(alice, id, services); await entered;
    expect(await operateOfficialPlanAuth(alice, 'revoke', { ...services, transports: [] })).toEqual({ disconnected: true, remoteRevocationConfirmed: false });
    release(Response.json({ models: [{ slug: 'synthetic-model', visibility: 'list' }] })); await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.officialPlanConnections)).toEqual([]); expect((await db.select().from(schema.officialPlanTransfers))[0].state).toBe('cancelled');
  });
  it('pins directory descriptors when the ticket pathname is replaced just before credential open', async () => {
    const id = await stage(), directory = join(root, sha256Hex('alice'), id);
    fixture.beforeOpen = async path => {
      if (!path.endsWith('/credentials.json')) return; fixture.beforeOpen = null;
      await rename(directory, `${directory}-held`); await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'credentials.json'), JSON.stringify(file('bob')), { mode: 0o600 });
    };
    expect(await completeOfficialPlanTransfer(alice, id, services)).toEqual({ connected: true });
    expect(openOfficialPlanSecret((await db.select().from(schema.officialPlanConnections))[0]).access).toBe(file().access_token);
  });
  it.each(['ownerId', 'workspaceId', 'clientId', 'subject', 'destinationHostId', 'sourceHostId', 'handoffId', 'refreshOwner'] as const)('rejects wrong %s provenance before provider I/O', async field => {
    const id = await stage(); vi.spyOn(services.transports[0], 'verifyHandoff').mockImplementation(async (p, ticket) => ({ ...receipt(p, ticket), [field]: 'foreign' }) as never);
    await expect(completeOfficialPlanTransfer(alice, id, services)).rejects.toMatchObject({ status: 409 }); expect(io).not.toHaveBeenCalled(); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('reserves a refresh session once even if a copied file is presented by a different owner', async () => {
    await connected(); const id = await stage(bob, 'one', { ...selected, clientId: 'issued-bob-work', subject: 'official-bob' });
    await writeFile(join(root, sha256Hex('bob'), id, 'credentials.json'), JSON.stringify({ ...file('bob'), refresh_token: file().refresh_token })); io.mockClear();
    await expect(completeOfficialPlanTransfer(bob, id, services)).rejects.toMatchObject({ status: 409 }); expect(io).not.toHaveBeenCalled(); expect(await db.select().from(schema.officialPlanConnections)).toHaveLength(1);
  });
  it('requires the authenticated source token-set digest, even when ID and access tokens belong to the selected person', async () => {
    const id = await stage(); await writeFile(join(root, sha256Hex('alice'), id, 'credentials.json'), JSON.stringify({ ...file(), refresh_token: 'synthetic-foreign-refresh' }));
    vi.spyOn(services.transports[0], 'verifyHandoff').mockImplementation(async (p, ticket, digest) => {
      if (digest !== sha256Hex(JSON.stringify(file()))) throw new Error('Source exchange snapshot mismatch'); return receipt(p, ticket);
    });
    await expect(completeOfficialPlanTransfer(alice, id, services)).rejects.toMatchObject({ status: 409 }); expect(services.verifier.verifyIdToken).not.toHaveBeenCalled(); expect(io).not.toHaveBeenCalled(); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('rejects session revocation during catalog I/O', async () => {
    const id = await stage(); io.mockImplementation(async () => { await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'alice')); return Response.json({ models: [{ slug: 'synthetic-model', visibility: 'list' }] }); });
    await expect(completeOfficialPlanTransfer(alice, id, services)).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('rejects an expired completion after catalog I/O without installing the grant', async () => {
    const id = await stage(); io.mockImplementation(async () => { vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001); return Response.json({ models: [{ slug: 'synthetic-model', visibility: 'list' }] }); });
    await expect(completeOfficialPlanTransfer(alice, id, services)).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]); expect((await db.select().from(schema.officialPlanTransfers))[0].state).toBe('needs_attention');
  });
  it('reconnects without touching retained conversations or local private state', async () => {
    await connected(); await db.insert(schema.conversations).values({ id: 'retained-private-chat', userId: 'alice', title: 'Retained private history' });
    await writeFile(join(root, 'retained-private-state'), 'Private history, learning and volume fixture', { mode: 0o600 }); const before = await db.select().from(schema.conversations);
    const id = await stage(alice, 'two'); await completeOfficialPlanTransfer(alice, id, services);
    expect(await db.select().from(schema.conversations)).toEqual(before); expect(await readFile(join(root, 'retained-private-state'), 'utf8')).toBe('Private history, learning and volume fixture'); const row = (await db.select().from(schema.officialPlanConnections))[0]; expect(row.revision).toBe(2); expect(openOfficialPlanSecret(row).access).toBe(file('alice', 'two').access_token);
  });
  it('keeps uncertain imports paused after restart without repeating provider verification', async () => {
    const id = await stage(); io.mockRejectedValue(new Error('synthetic lost reply')); await expect(completeOfficialPlanTransfer(alice, id, services)).rejects.toMatchObject({ status: 409 });
    await expect(completeOfficialPlanTransfer(alice, id, { ...services })).rejects.toMatchObject({ status: 409 }); expect(io).toHaveBeenCalledOnce(); expect((await db.select().from(schema.officialPlanTransfers))[0].state).toBe('needs_attention');
    const status = await officialPlanAuthStatus(alice); expect(status).toMatchObject({ connectAvailable: false, state: 'needs_attention' }); expect(JSON.stringify(status)).not.toMatch(/issued-alice|official-alice|synthetic-access|synthetic-refresh|persisted-vm|credentials.json/);
  });
  it('preserves work provenance through refresh, has one refresh owner, and clears local credentials on revoke', async () => {
    await connected(); const before = (await db.select().from(schema.officialPlanConnections))[0];
    io.mockImplementation(async url => String(url) === OFFICIAL_TOKEN_URL ? Response.json({ access_token: 'synthetic-access-alice-two', refresh_token: 'synthetic-refresh-alice-two', token_type: 'Bearer', expires_in: 3500, scope: 'chatgpt.tokens.use.direct resource.invoke' }) : String(url).endsWith('/revoke') ? new Response(null) : Response.json({ models: [{ slug: 'synthetic-model', visibility: 'list' }] }));
    const results = await Promise.allSettled([operateOfficialPlanAuth(alice, 'refresh', { ...services, transports: [] }), operateOfficialPlanAuth(alice, 'refresh', { ...services, transports: [] })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); const after = (await db.select().from(schema.officialPlanConnections))[0]; expect(after.provenance).toEqual(before.provenance); expect(after.revision).toBe(2); expect(openOfficialPlanSecret(after).refresh).toBe('synthetic-refresh-alice-two');
    await operateOfficialPlanAuth(alice, 'revoke', { ...services, transports: [] }); await expect(officialPlanMetadata('alice', 'synthetic-model')).rejects.toMatchObject({ status: 409 }); const revoked = (await db.select().from(schema.officialPlanConnections))[0]; expect(() => openOfficialPlanSecret(revoked)).toThrow(); expect(revoked.status).toBe('revoked');
  });
  it('fences authentication and refresh while an owner transfer is pending and preserves old account on cancel', async () => {
    await connected(); const before = (await db.select().from(schema.officialPlanConnections))[0]; const id = await stage(alice, 'two');
    await expect(operateOfficialPlanAuth(alice, 'refresh', { ...services, transports: [] })).rejects.toMatchObject({ status: 409 }); await cancelOfficialPlanTransfer(alice, id);
    expect((await db.select().from(schema.officialPlanConnections))[0]).toEqual(before); expect(await officialPlanMetadata('alice', 'synthetic-model')).toBeTruthy();
  });
  it('stops fencing refresh once an abandoned pending transfer expires', async () => {
    await connected(); await stage(alice, 'two');
    io.mockImplementation(async url => String(url) === OFFICIAL_TOKEN_URL ? Response.json({ access_token: 'synthetic-access-alice-two', refresh_token: 'synthetic-refresh-alice-two', token_type: 'Bearer', expires_in: 3500, scope: 'chatgpt.tokens.use.direct resource.invoke' }) : Response.json({ models: [{ slug: 'synthetic-model', visibility: 'list' }] }));
    await expect(operateOfficialPlanAuth(alice, 'refresh', { ...services, transports: [] })).rejects.toMatchObject({ status: 409 });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
    expect(await operateOfficialPlanAuth(alice, 'refresh', { ...services, transports: [] })).toEqual({ connected: true });
    expect((await db.select().from(schema.officialPlanTransfers)).map(row => row.state).sort()).toEqual(['cancelled', 'complete']);
  });
  it('rejects refresh after the transfer approval expires without spending the refresh token', async () => {
    await connected(); const row = (await db.select().from(schema.officialPlanConnections))[0]; io.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(row.provenance!.expiresAt + 1);
    await expect(operateOfficialPlanAuth(alice, 'refresh', { ...services, transports: [] })).rejects.toMatchObject({ status: 409 });
    expect(io).not.toHaveBeenCalled(); expect(await db.select().from(schema.officialPlanAuthOperations)).toEqual([]);
    expect(openOfficialPlanSecret((await db.select().from(schema.officialPlanConnections))[0]).refresh).toBe(file().refresh_token);
  });
  it.each(['public-file', 'public-directory', 'symlink', 'oversize', 'invalid-json'] as const)('rejects %s staging without credential leakage or provider I/O', async kind => {
    const id = await stage(), directory = join(root, sha256Hex('alice'), id), path = join(directory, 'credentials.json');
    if (kind === 'public-file') await chmod(path, 0o644); if (kind === 'public-directory') await chmod(directory, 0o755);
    if (kind === 'symlink') { await rm(path); await symlink(join(directory, 'foreign.json'), path); }
    if (kind === 'oversize') await writeFile(path, 'x'.repeat(50001)); if (kind === 'invalid-json') await writeFile(path, '{synthetic-access-secret');
    const pending = completeOfficialPlanTransfer(alice, id, services); await expect(pending).rejects.toMatchObject({ status: 409 }); await expect(pending).rejects.toThrow('The protected credential transfer was not confirmed.'); expect(io).not.toHaveBeenCalled();
  });
  it('makes transfer authority and provenance revision immutable in storage', async () => {
    const id = await connected(); await expect(db.update(schema.officialPlanTransfers).set({ userId: 'bob' }).where(eq(schema.officialPlanTransfers.id, id))).rejects.toThrow();
    const row = (await db.select().from(schema.officialPlanConnections))[0]; await expect(db.update(schema.officialPlanConnections).set({ provenance: { ...row.provenance!, workspaceId: 'foreign' } }).where(eq(schema.officialPlanConnections.id, row.id))).rejects.toThrow();
    expect(() => openOfficialPlanSecret({ ...row, provenance: { ...row.provenance!, workspaceId: 'foreign' } })).toThrow();
  });
});
