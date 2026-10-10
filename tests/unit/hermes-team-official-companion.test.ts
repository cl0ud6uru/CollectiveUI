import { readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, stat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock('@/db', async () => { const { PGlite } = await import('@electric-sql/pglite'); const { drizzle } = await import('drizzle-orm/pglite'); const schema = await import('@/db/schema'); fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema }; });
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { sha256Hex } from '@/lib/crypto';
import { openOfficialPlanSecret } from '@/lib/hermes-team/official-plan';
import { cancelOfficialPlanTransfer } from '@/lib/hermes-team/official-plan-vm-transfer';
import { operateOfficialPlanAuth } from '@/lib/hermes-team/official-plan-auth';
import { OfficialPlanLocalCompanion } from '@/lib/hermes-team/official-plan-local-companion';
import { CompanionPrivateStore } from '@/lib/hermes-team/official-plan-companion-storage';
import { credentialDigest, openCompanionPayload, sealCompanionPayload, signTranscript, transcriptDigest } from '@/lib/hermes-team/official-plan-companion-protocol';
import { runOfficialPlanLocalCommand, VERIFIED_OFFICIAL_LOCAL_DRIVERS } from '@/lib/hermes-team/official-plan-companion-stdio';
import { VERIFIED_OFFICIAL_COMPANION_PAIRINGS } from '@/lib/hermes-team/official-plan-companion-receiver';
import { syntheticCompanion } from '../fixtures/official-plan-companion';
type Synthetic = Awaited<ReturnType<typeof syntheticCompanion>>;
let c: Synthetic, other: Synthetic;
beforeAll(async () => { await fixture.client!.waitReady; for (const f of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort()) await fixture.client!.exec(readFileSync(`src/db/migrations/${f}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]')); }, 60000);
beforeEach(async () => { vi.stubEnv('ENCRYPTION_KEY', 'synthetic-companion-db-only'); await fixture.client!.exec('TRUNCATE users CASCADE'); await db.insert(schema.users).values(['alice', 'bob'].map(id => ({ id, upn: `${id}@test.invalid`, name: id, authSource: 'local' as const, identityRealm: 'local' as const }))); c = await syntheticCompanion((await loadPrincipal('alice'))!); other = await syntheticCompanion((await loadPrincipal('bob'))!); });
afterEach(async () => { await c.dispose(); await other.dispose(); vi.restoreAllMocks(); });
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });
async function suspended() { await c.local.signIn(c.browser); const ticket = await c.receiver.challenge(await c.local.offer()), envelope = await c.local.suspend(ticket); return { ticket, envelope }; }
describe('Executable same-tool local SIWC companion and authenticated VM receiver', () => {
  it('executes real loopback, signatures, encrypted stdio and protected custody for two independently authenticated owners', async () => {
    for (const s of [c, other]) {
      expect(await runOfficialPlanLocalCommand('sign-in', [s.driver])).toEqual({ connectedLocally: true });
      expect(await runOfficialPlanLocalCommand('transfer', [s.driver])).toEqual({ transferred: true });
      const row = (await db.select().from(schema.officialPlanConnections)).find(row => row.userId === s.pairing.appOwnerId)!;
      expect(openOfficialPlanSecret(row).access).toBe(s.control.access); expect(row.clientId).toBe(s.clientId); expect(row.hostId).toBe(s.pairing.receiverHostId); expect(row.provenance?.workspaceId).toBeUndefined();
      expect(await s.local.status()).toEqual({ state: 'transferred' }); expect(await readFile(join(s.root, 'journal.json'), 'utf8')).not.toContain(s.control.refresh);
      expect((await stat(join(s.root, 'journal.json'))).mode & 0o777).toBe(0o600); expect(s.control.exchangeCount).toBe(1);
    }
  });
  it('keeps executable installation and pairing registries empty before OAuth or SSH can run', async () => {
    expect(VERIFIED_OFFICIAL_LOCAL_DRIVERS).toEqual([]); expect(VERIFIED_OFFICIAL_COMPANION_PAIRINGS).toEqual([]);
    await expect(runOfficialPlanLocalCommand('sign-in')).rejects.toMatchObject({ status: 409 }); expect(c.control.exchangeCount).toBe(0);
  });
  it('requires the independently authenticated app owner; a correctly signed sender cannot choose another app user', async () => {
    await c.local.signIn(c.browser); c.control.principal = other.control.principal;
    await expect(c.receiver.challenge(await c.local.offer())).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanTransfers)).toEqual([]);
  });
  it('rejects unapproved/self-signed source identities and revoked pairings', async () => {
    await c.local.signIn(c.browser); const offer = await c.local.offer(), foreign = generateKeyPairSync('ed25519');
    await expect(c.receiver.challenge(signTranscript(offer.body, foreign.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()))).rejects.toMatchObject({ status: 409 });
    c.control.approved = false; await expect(c.receiver.challenge(offer)).rejects.toMatchObject({ status: 409 });
  });
  it('rejects changed token bytes, forged receipt and wrong destinations without importing credentials', async () => {
    const { envelope } = await suspended();
    expect(JSON.stringify(envelope)).not.toContain(c.control.refresh); expect(JSON.stringify(envelope)).not.toContain(c.control.access);
    // Flip a decoded byte; swapping the last base64url character can be a no-op (same char or ignored padding bits).
    const tampered = Buffer.from(envelope.ciphertext, 'base64url'); tampered[0] ^= 1;
    await expect(c.receiver.receive({ ...envelope, ciphertext: tampered.toString('base64url') })).rejects.toMatchObject({ status: 409 });
    await expect(c.receiver.receive({ ...envelope, ticketDigest: 'a'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect(() => openCompanionPayload(envelope, 'invalid', c.pairing.sourceSigningPublicKey)).toThrow();
  });
  it('rejects mixed refresh credentials even with valid signed access and identity tokens', async () => {
    const { ticket, envelope } = await suspended();
    // Source private fixture material is used only to simulate a buggy/compromised packet producer; the stored exchange snapshot still binds the original set.
    const signed = JSON.parse(await readFile(join(c.root, 'journal.json'), 'utf8'));
    const file = { ...signed.body.file, refresh_token: 'synthetic-foreign-refresh' };
    const mixed = sealCompanionPayload({ file, snapshot: signed.body.snapshot, custody: signed.body.custody }, ticket.body, c.pairing.receiverEncryptionPublicKey, c.pairing.sourceSigningPrivateKey);
    expect(credentialDigest(file)).not.toBe(ticket.body.credentialDigest); await expect(c.receiver.receive(mixed)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.officialPlanConnections)).toEqual([]); await c.receiver.receive(envelope);
  });
  it('fences canceled, replayed and stale completion; a source stays suspended', async () => {
    const { ticket, envelope } = await suspended(); await cancelOfficialPlanTransfer(c.control.principal, ticket.body.transferId);
    await expect(c.receiver.receive(envelope)).rejects.toMatchObject({ status: 409 }); await expect(c.local.refresh()).rejects.toMatchObject({ status: 409 });
    expect(await c.local.status()).toEqual({ state: 'suspended' }); expect(c.control.exchangeCount).toBe(1);
    const ack = await c.receiver.recover(await c.local.recoveryRequest()); expect(await c.local.acknowledge(ack)).toEqual({ transferred: false, state: 'needs_attention' });
    await c.local.signIn(c.browser, true); expect(await c.local.status()).toEqual({ state: 'active' });
  });
  it('retries a lost delivery only after authenticated pending status, with the exact suspended snapshot', async () => {
    await suspended(); expect(await runOfficialPlanLocalCommand('recover', [c.driver])).toEqual({ transferred: true }); expect(c.control.exchangeCount).toBe(1);
  });
  it('recovers a lost acknowledgment through authenticated status without another exchange or import', async () => {
    const { envelope } = await suspended(); await c.receiver.receive(envelope); await expect(c.receiver.receive(envelope)).rejects.toMatchObject({ status: 409 });
    const restarted = new OfficialPlanLocalCompanion(new CompanionPrivateStore(c.root), c.pairing, c.io);
    expect(await restarted.status()).toEqual({ state: 'suspended' }); const ack = await c.receiver.recover(await restarted.recoveryRequest()); expect(await restarted.acknowledge(ack)).toEqual({ transferred: true });
    expect(c.control.exchangeCount).toBe(1); expect(await readFile(join(c.root, 'journal.json'), 'utf8')).not.toContain(c.control.refresh);
  });
  it('does not install an account if pairing authority or app session changes during provider I/O', async () => {
    const { envelope } = await suspended(); c.control.catalogHook = async () => { c.control.approved = false; };
    await expect(c.receiver.receive(envelope)).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('fences an app session change in the final transaction after the model catalog response', async () => {
    const { envelope } = await suspended(); c.control.catalogHook = async () => { await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'alice')); };
    await expect(c.receiver.receive(envelope)).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('rejects approval shortening during provider I/O rather than persisting an older, longer authority expiry', async () => {
    const { envelope } = await suspended(); c.control.catalogHook = async () => { c.approved.approvedUntil = Date.now() + 60000; };
    await expect(c.receiver.receive(envelope)).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('leaves destination refresh as the one rotating owner after source acknowledgment', async () => {
    const { envelope } = await suspended(); await c.local.acknowledge(await c.receiver.receive(envelope)); const prior = (await db.select().from(schema.officialPlanConnections))[0];
    const services = { fetch: c.io, verifier: c.receiver.services.verifier, transports: [] };
    const results = await Promise.allSettled([operateOfficialPlanAuth(c.control.principal, 'refresh', services), operateOfficialPlanAuth(c.control.principal, 'refresh', services)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); await expect(c.local.refresh()).rejects.toMatchObject({ status: 409 });
    const row = (await db.select().from(schema.officialPlanConnections))[0]; expect(row.revision).toBe(prior.revision + 1); expect(row.provenance).toEqual(prior.provenance); expect(openOfficialPlanSecret(row).refresh).toBe(c.control.refresh);
  });
  it('rejects an expired ticket before decrypting or importing a suspended packet', async () => {
    const { ticket, envelope } = await suspended(); vi.spyOn(Date, 'now').mockReturnValue(ticket.body.expiresAt + 1);
    await expect(c.receiver.receive(envelope)).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('transfers when the laptop clock trails the VM within the shared skew window', async () => {
    await c.local.signIn(c.browser); const ticket = await c.receiver.challenge(await c.local.offer());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(ticket.body.createdAt - 2000); const envelope = await c.local.suspend(ticket); clock.mockRestore();
    expect(await c.local.acknowledge(await c.receiver.receive(envelope))).toEqual({ transferred: true }); expect(await db.select().from(schema.officialPlanConnections)).toHaveLength(1);
  });
  it('serializes source refresh and rejects suspension against a stale pre-refresh snapshot', async () => {
    await c.local.signIn(c.browser); const ticket = await c.receiver.challenge(await c.local.offer());
    const result = await Promise.allSettled([c.local.refresh(), c.local.refresh()]); expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(c.local.suspend(ticket)).rejects.toMatchObject({ status: 409 }); expect(await c.local.status()).toEqual({ state: 'active' }); expect(c.control.exchangeCount).toBe(2);
  });
  it('leaves an interrupted refresh paused after restart, without reusing a rotating token', async () => {
    await c.local.signIn(c.browser); c.control.tokenHook = async () => { throw new Error(`synthetic-upstream-${c.control.refresh}`); };
    await expect(c.local.refresh()).rejects.toMatchObject({ status: 409 }); const restarted = new OfficialPlanLocalCompanion(c.source, c.pairing, c.io);
    await expect(restarted.refresh()).rejects.toMatchObject({ status: 409 }); expect(await restarted.status()).toEqual({ state: 'needs_attention' }); expect(c.control.exchangeCount).toBe(2);
  });
  it('retains the callback-issued registration after an uncertain first exchange and uses fresh PKCE instead of registering again', async () => {
    c.control.tokenHook = async () => { throw new Error('Synthetic invalid_grant'); };
    await expect(c.local.signIn(c.browser)).rejects.toMatchObject({ status: 409 }); c.control.tokenHook = null;
    await c.local.signIn(c.browser); const url = new URL(c.control.browserUrl); expect(url.searchParams.get('client_id')).toBe(c.clientId); expect(url.searchParams.has('agent_name_hint')).toBe(false); expect(c.control.exchangeCount).toBe(2);
  });
  it('keeps a hard-crash lock fenced and does not infer that a missing process is safe to replace', async () => {
    await c.local.signIn(c.browser); await writeFile(join(c.root, 'operation.lock'), 'synthetic-crash', { mode: 0o600 });
    const restarted = new OfficialPlanLocalCompanion(c.source, c.pairing, c.io); expect(await restarted.status()).toEqual({ state: 'needs_attention' }); await expect(restarted.refresh()).rejects.toMatchObject({ status: 409 });
  });
  it('does not trust altered local journals, unsafe permissions or symlink storage', async () => {
    await c.local.signIn(c.browser); const path = join(c.root, 'journal.json'), raw = JSON.parse(await readFile(path, 'utf8')); raw.body.file.refresh_token = 'synthetic-mixed'; await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
    await expect(c.local.offer()).rejects.toMatchObject({ status: 409 });
    const link = join(c.root, 'unsafe.json'); await symlink(path, link); await expect(c.source.read('unsafe.json')).rejects.toMatchObject({ status: 409 });
    await chmod(path, 0o644); expect(await c.local.status()).toEqual({ state: 'needs_attention' });
  });
  it('rejects missing granted permission and nonce mismatch before replacing the selected local record', async () => {
    c.control.tokenMutation = tokens => { tokens.scope = 'openid'; };
    await expect(c.local.signIn(c.browser)).rejects.toMatchObject({ status: 409 }); expect(await c.local.status()).toEqual({ state: 'needs_attention' }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('validates the original nonce in the freshly signed ID token', async () => {
    c.control.tokenHook = async () => { c.control.nonce = 'synthetic-foreign-nonce'; };
    await expect(c.local.signIn(c.browser)).rejects.toMatchObject({ status: 409 }); expect(await c.local.status()).toEqual({ state: 'needs_attention' });
  });
  it('rejects a wrong-state callback and a duplicate return without repeating the local exchange', async () => {
    await c.local.signIn(async url => {
      const auth = new URL(url), wrong = new URL(auth.searchParams.get('redirect_uri')!); wrong.searchParams.set('state', 'synthetic-wrong'); wrong.searchParams.set('code', 'synthetic-local-code');
      expect((await fetch(wrong)).status).toBe(400); expect(c.control.exchangeCount).toBe(0); await c.browser(url);
      wrong.searchParams.set('state', auth.searchParams.get('state')!); wrong.searchParams.set('client_id', c.clientId); expect((await fetch(wrong)).status).toBe(400);
    }); expect(c.control.exchangeCount).toBe(1);
  });
  it('times out a never-resolving browser launcher and releases its listener and lock', async () => {
    await expect(c.local.signIn(async () => new Promise<void>(() => {}), false, undefined, 20)).rejects.toMatchObject({ status: 409 });
    expect(await c.source.isLocked()).toBe(false); expect(await c.local.status()).toEqual({ state: 'needs_attention' }); expect(c.control.exchangeCount).toBe(0);
  });
  it('fences a delayed OAuth completion after cancellation instead of storing a fresh active grant', async () => {
    const controller = new AbortController(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; }); c.control.tokenHook = async () => { entered(); await wait; };
    const pending = c.local.signIn(c.browser, false, controller.signal); await started; controller.abort(); release(); await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(await c.local.status()).toEqual({ state: 'needs_attention' }); expect(await c.source.isLocked()).toBe(false); await expect(c.local.offer()).rejects.toMatchObject({ status: 409 });
  });
  it('keeps a receiver staging crash uncertain, cancels recovery and never resumes the source grant', async () => {
    const { ticket } = await suspended(), request = await c.local.recoveryRequest();
    const stage = join(c.vmRoot, sha256Hex('alice'), ticket.body.transferId); await writeFile(join(stage, 'delivery.json'), JSON.stringify({ custodyDigest: request.body.custodyDigest }), { mode: 0o600 });
    const ack = await c.receiver.recover(request); expect(ack.body.state).toBe('needs_attention'); expect(await c.local.acknowledge(ack)).toEqual({ transferred: false, state: 'needs_attention' });
    await expect(c.local.refresh()).rejects.toMatchObject({ status: 409 }); expect(await db.select().from(schema.officialPlanConnections)).toEqual([]);
  });
  it('cleans only the staged credential file and preserves local history through reconnect', async () => {
    await writeFile(join(c.root, 'history.json'), JSON.stringify({ retained: 'synthetic-private-conversation' }), { mode: 0o600 });
    const { ticket, envelope } = await suspended(); await c.local.acknowledge(await c.receiver.receive(envelope));
    const credentialPath = join(c.vmRoot, sha256Hex('alice'), ticket.body.transferId, 'credentials.json'); await expect(readFile(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await c.local.signIn(c.browser, true); expect(new URL(c.control.browserUrl).searchParams.get('client_id')).toBe(c.clientId); expect(c.control.browserUrl).not.toContain(c.control.idToken);
    expect(await readFile(join(c.root, 'history.json'), 'utf8')).toContain('synthetic-private-conversation');
  });
  it('binds acknowledgment to the exact ticket and custody revision', async () => {
    const { ticket, envelope } = await suspended(), ack = await c.receiver.receive(envelope);
    await expect(c.local.acknowledge({ ...ack, body: { ...ack.body, custodyDigest: transcriptDigest(randomUUID()) } })).rejects.toMatchObject({ status: 409 });
    expect(ack.body.ticketDigest).toBe(transcriptDigest(ticket.body)); expect(await c.local.status()).toEqual({ state: 'suspended' });
  });
});
