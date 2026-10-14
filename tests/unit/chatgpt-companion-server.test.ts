import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const fixture = vi.hoisted(() => ({
  client: null as PGlite | null,
  control: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  admin: null as Principal | null,
  ownerLocked: false, validation: vi.fn(),
  identity: { subject: 'siwc-subject', email: 'alice@test.invalid', clientId: 'issued-client-id', expiresAt: new Date(Date.now() + 3_600_000) },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/hermes-team/official-plan-signatures', () => ({ createOfficialPlanVerifier: () => ({
  verifyIdToken: async (_token: string, options: { clientId: string; subject?: string; nonce?: string }) => {
    if (options.clientId !== 'issued-client-id' || options.subject && options.subject !== fixture.identity.subject) throw new Error('incorrect binding');
    return { subject: fixture.identity.subject };
  },
  verifyAccessToken: async () => ({ subject: fixture.identity.subject, clientId: fixture.identity.clientId, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }),
}) }));
vi.mock('@/lib/session', () => ({ requireAdmin: async () => fixture.admin }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ origin: 'https://portal.test.invalid' }) }));
vi.mock('@/lib/sandbox/lifecycle', () => ({ onUserDisabledLocked: vi.fn(), onUserEnabledLocked: vi.fn() }));
vi.mock('@/lib/workspaces/locks', () => ({ withWorkspaceUserLock: async (_owner: string, run: (q: unknown) => Promise<unknown>) => {
  const { db } = await import('@/db');
  fixture.ownerLocked = true;
  try { return await run(db); } finally { fixture.ownerLocked = false; }
} }));
vi.mock('@/personal-codex/control', async importOriginal => ({
  ...await importOriginal<typeof import('@/personal-codex/control')>(), personalControl: fixture.control,
}));
vi.mock('@/lib/llm/chatgpt/oauth', () => ({ revokeTokens: vi.fn(async () => undefined), refreshTokens: vi.fn() }));
vi.mock('@/lib/llm/chatgpt/siwc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm/chatgpt/siwc')>('@/lib/llm/chatgpt/siwc');
  return {
    ...actual,
    validateSIWCCredential: fixture.validation,
    refreshSIWCTokens: fixture.refresh,
    revokeSIWCTokens: fixture.revoke,
  };
});
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { deleteAllChatGPTConnections, openCredentialSecret } from '@/lib/llm/chatgpt/store';
import { importSIWCProfile, unifiedAccountView } from '@/lib/llm/chatgpt/account';
import { setUserDisabled } from '@/app/admin/actions';

const HOST_ID = 'urn:uuid:123e4567-e89b-42d3-a456-426614174000';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PROFILE = {
  version: 1, kind: 'siwc', clientId: 'issued-client-id', accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token',
  idToken: 'synthetic-id-token', expiresIn: 3600, scope: SCOPE, hostId: HOST_ID, createdAt: new Date().toISOString(),
};
let alice: Awaited<ReturnType<typeof loadPrincipal>>;


async function permitChatGPT(overrides: Record<string, unknown> = {}) {
  const value = {
    enabled: true, access: 'everyone', allowedGroupIds: [], allowedUpns: [], allowedWorkspaceIds: [],
    allowPersonalPlans: true, allowBackground: false, ...overrides,
  };
  await db.insert(schema.settings).values({ key: 'chatgpt', value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

async function savedCredential(userId = 'alice') {
  return (await db.select().from(schema.userCredentials).where(eq(schema.userCredentials.userId, userId)))[0];
}

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(name => name.endsWith('.sql')).sort()) {
    const migration = readFileSync(`src/db/migrations/${file}`, 'utf8')
      .replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]');
    await fixture.client!.exec(migration);
  }
}, 45000);

beforeEach(async () => {
  vi.stubEnv('CHATGPT_SIWC_HOST_ID', HOST_ID);
  vi.stubEnv('AUTH_URL', 'https://portal.test.invalid');
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '');
  vi.stubEnv('PERSONAL_CODEX_SOCKET', '/tmp/unified-chatgpt-test.sock');
  fixture.identity = { subject: 'siwc-subject', email: 'alice@test.invalid', clientId: 'issued-client-id', expiresAt: new Date(Date.now() + 3_600_000) };
  fixture.control.mockReset().mockImplementation(async (_owner: string, action: string) => {
    if (action === 'status') return { state: 'stopped', siwc: { available: true } };
    if (action === 'readiness') return { state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' };
    if (action === 'prepare') return { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' };
    return { state: 'stopped' };
  });
  fixture.validation.mockReset().mockImplementation(async () => fixture.identity);
  vi.stubEnv('CHATGPT_COMPANION_ENABLED', 'true');
  vi.stubEnv('CHATGPT_COMPANION_DOWNLOAD_URL', 'https://portal.test.invalid/download/companion');
  fixture.refresh.mockReset();
  fixture.revoke.mockReset().mockResolvedValue(false);
  await fixture.client!.exec('TRUNCATE users, settings, codex_runs, user_credentials CASCADE');
  await db.insert(schema.users).values([
    { id: 'alice', upn: 'alice@test.invalid', email: 'alice@test.invalid', name: 'Alice', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', upn: 'bob@test.invalid', email: 'bob@test.invalid', name: 'Bob', authSource: 'local', identityRealm: 'local' },
    { id: 'admin', upn: 'admin@test.invalid', email: 'admin@test.invalid', name: 'Admin', authSource: 'ldap', identityRealm: 'directory', isAdmin: true },
  ]);
  alice = await loadPrincipal('alice');
  fixture.admin = await loadPrincipal('admin');
  await permitChatGPT();
});

afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

import { beginCompanionSignIn, cancelCompanionSignIn, redeemCompanion, challengeCompanion, receiveCompanion, recoverCompanion, cancelNativeCompanion, companionNativeStatus } from '@/lib/llm/chatgpt/companion';
import { credentialDigest, sealCompanionPayload, signTranscript, transcriptDigest, verifyTranscript, type SourceSnapshot } from '@/lib/hermes-team/official-plan-companion-protocol';
import { POST as nativePost } from '@/app/api/chatgpt/companion/route';
import { runCompanion } from '@/chatgpt-companion/client';
import type { LocalCompanionStore } from '@/lib/hermes-team/official-plan-local-companion';
class MemoryStore implements LocalCompanionStore {
  values = new Map<string, unknown>(); busy = false;
  async read(name: string) { return this.values.get(name) ?? null; }
  async write(name: string, value: unknown) { this.values.set(name, value); }
  async isLocked() { return this.busy; }
  async locked<T>(run: () => Promise<T>) { if (this.busy) throw new Error('locked'); this.busy = true; try { return await run(); } finally { this.busy = false; } }
}

async function transfer(enableCodex = false) {
  const launch = new URL((await beginCompanionSignIn(alice!, { accepted: true, consentVersion: 1, enableCodex })).launchUrl);
  const attemptId = launch.searchParams.get('attempt')!, launchToken = launch.searchParams.get('ticket')!;
  const keys = generateKeyPairSync('ed25519'), sourceHostId = `urn:uuid:${randomUUID()}`;
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const proof = { attemptId, launchToken, sourceHostId, sourceSigningPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const request = { action: 'redeem', ...proof, signature: signTranscript(proof, privateKey).signature };
  const paired = await redeemCompanion(request), authorization = `Companion ${paired.returnToken}`;
  const file = { version: 1 as const, client_id: 'issued-client-id', subject: 'siwc-subject', source_host_id: sourceHostId,
    access_token: PROFILE.accessToken, refresh_token: PROFILE.refreshToken, id_token: PROFILE.idToken };
  const snapshot = signTranscript<SourceSnapshot>({ version: 1, pairingId: attemptId, sourceHostId, clientId: file.client_id, subject: file.subject,
    exchangeId: randomUUID(), credentialDigest: credentialDigest(file), receivedAt: Date.now(), expiresAt: Date.now() + 3600000,
    scopes: SCOPE.split(' '), validation: 'authorization_code' }, privateKey);
  const ticket = await challengeCompanion(attemptId, authorization, snapshot);
  const custody = signTranscript({ version: 1 as const, ticketDigest: transcriptDigest(ticket.body), snapshotDigest: transcriptDigest(snapshot),
    credentialDigest: credentialDigest(file), journalRevision: 1, suspendedAt: Date.now(), refreshOwner: 'collective_vm' as const }, privateKey);
  const envelope = sealCompanionPayload({ file, snapshot, custody }, ticket.body, paired.pairing.receiverEncryptionPublicKey, privateKey);
  const recovery = signTranscript({ ticket, custodyDigest: transcriptDigest(custody) }, privateKey);
  return { attemptId, authorization, paired, request, snapshot, ticket, envelope, recovery, privateKey };
}
const attempt = async (id: string) => (await db.select().from(schema.chatgptCompanionAttempts).where(eq(schema.chatgptCompanionAttempts.id, id)))[0];

describe('owner-bound native companion activation', () => {
  it('composes the real client, local callback, encrypted transfer, HTTP receiver and unified store', async () => {
    const actual = await vi.importActual<typeof import('@/lib/llm/chatgpt/siwc')>('@/lib/llm/chatgpt/siwc');
    fixture.validation.mockImplementation(actual.validateSIWCCredential);
    const globalStore = new MemoryStore(), store = new MemoryStore(), returnToApp = vi.fn(async () => {});
    let oauth = 0, received = 0, nonce: string | null = null;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url) === 'https://auth.openai.com/api/accounts/oauth/token') {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('authorization_code'); expect(form.get('code_verifier')).toHaveLength(43);
        expect(form.get('client_id')).toBe('issued-client-id');
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'siwc-subject', email: 'alice@test.invalid', nonce })).toString('base64url')}.synthetic`;
        return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', id_token: token,
          token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
      }
      expect(String(url)).toBe('https://portal.test.invalid/api/chatgpt/companion');
      expect(init?.credentials).toBe('omit'); expect(init?.redirect).toBe('error');
      if (JSON.parse(String(init?.body)).action === 'receive') received++;
      return nativePost(new Request(url, init));
    };
    const launch = await beginCompanionSignIn(alice!, { accepted: true, consentVersion: 1, enableCodex: false });
    expect(await runCompanion(launch.launchUrl, { globalStore, attemptStore: () => store, approvedOrigins: ['https://portal.test.invalid'],
      confirm: async (origin, email) => { expect(origin).toBe('https://portal.test.invalid'); expect(email).toBe('alice@test.invalid'); return true; },
      openBrowser: async url => {
        oauth++; const authorization = new URL(url); nonce = authorization.searchParams.get('nonce');
        expect(nonce).toHaveLength(43); expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        expect(callback.hostname).toBe('127.0.0.1'); callback.searchParams.set('state', authorization.searchParams.get('state')!);
        callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('client_id', 'issued-client-id');
        expect((await fetch(callback)).status).toBe(200);
      }, returnToApp, fetcher, pollMs: 5 })).toEqual({ connected: true });
    expect(oauth).toBe(1); expect(received).toBe(1); expect(await savedCredential()).toBeDefined();
    expect(JSON.stringify(store.values.get('journal.json'))).not.toContain('synthetic-refresh-token');
    expect(returnToApp).toHaveBeenCalledWith('https://portal.test.invalid/settings?tab=connected-accounts');
  });
  it('commits encrypted credentials to the unified account and returns a verifiable custody receipt', async () => {
    const f = await transfer();
    const ack = await receiveCompanion(f.attemptId, f.authorization, f.envelope);
    expect(verifyTranscript(ack, f.paired.pairing.receiverSigningPublicKey)).toMatchObject({ state: 'complete', custodyDigest: f.recovery.body.custodyDigest });
    const stored = await savedCredential();
    expect(stored).toMatchObject({ userId: 'alice', externalSubject: 'siwc-subject', accountId: 'siwc:issued-client-id' });
    expect(stored.secretEnc).not.toContain(PROFILE.refreshToken);
    expect(openCredentialSecret(stored).siwc?.hostId).toBe(HOST_ID);
    expect(await savedCredential('bob')).toBeUndefined();
    expect(fixture.control.mock.calls.filter(c => c[1] === 'sync-token')).toHaveLength(0);
    expect(await unifiedAccountView(alice!)).toMatchObject({ backends: { native: { state: 'connected' } }, signIn: { state: 'complete' } });
  });
  it('recovers a lost completion reply without resending or revalidating credentials', async () => {
    const f = await transfer(); await receiveCompanion(f.attemptId, f.authorization, f.envelope);
    expect((await recoverCompanion(f.attemptId, f.authorization, f.recovery)).body.state).toBe('complete');
    expect(fixture.validation).toHaveBeenCalledTimes(1);
    await expect(receiveCompanion(f.attemptId, f.authorization, f.envelope)).rejects.toThrow();
    expect(fixture.validation).toHaveBeenCalledTimes(1);
  });
  it('keeps native account success when the explicitly requested Codex synchronization fails', async () => {
    const f = await transfer(true);
    fixture.control.mockImplementation(async (_owner: string, action: string) => { if (action === 'sync-token') throw new Error('unavailable'); return { state: 'stopped' }; });
    expect((await receiveCompanion(f.attemptId, f.authorization, f.envelope)).body.state).toBe('complete');
    expect(await savedCredential()).toBeDefined(); expect((await attempt(f.attemptId)).state).toBe('complete');
    expect(fixture.control.mock.calls.some(c => c[1] === 'sync-token')).toBe(true);
  });
  it('redemption is idempotent only for the same locally retained signing key', async () => {
    const f = await transfer(); expect((await redeemCompanion(f.request)).returnToken).toBe(f.paired.returnToken);
    const keys = generateKeyPairSync('ed25519');
    const proof = { attemptId: f.attemptId, launchToken: f.request.launchToken, sourceHostId: f.request.sourceHostId, sourceSigningPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    await expect(redeemCompanion({ action: 'redeem', ...proof, signature: signTranscript(proof, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).signature })).rejects.toThrow();
  });
  it('requires native capability, strict proofs, unchanged snapshot, and an authentic envelope', async () => {
    const f = await transfer();
    await expect(companionNativeStatus(f.attemptId, `Companion ${'x'.repeat(43)}`)).rejects.toThrow();
    await expect(redeemCompanion({ ...f.request, userId: 'bob' })).rejects.toThrow();
    await expect(challengeCompanion(f.attemptId, f.authorization, { ...f.snapshot, body: { ...f.snapshot.body, subject: 'other' } })).rejects.toThrow();
    await expect(receiveCompanion(f.attemptId, f.authorization, { ...f.envelope, ciphertext: f.envelope.ciphertext.slice(1) })).rejects.toThrow();
    expect((await attempt(f.attemptId)).state).toBe('paired'); expect(await savedCredential()).toBeUndefined();
  });
  it('a scoped native Cancel closes the attempt before custody; browser Cancel fences a late receive', async () => {
    const f = await transfer(); expect(await cancelNativeCompanion(f.attemptId, f.authorization)).toEqual({ cancelled: true });
    expect(await cancelNativeCompanion(f.attemptId, f.authorization)).toEqual({ cancelled: true });
    await expect(receiveCompanion(f.attemptId, f.authorization, f.envelope)).rejects.toThrow();
    const next = await transfer(); await cancelCompanionSignIn(alice!);
    await expect(receiveCompanion(next.attemptId, next.authorization, next.envelope)).rejects.toThrow();
    expect(await savedCredential()).toBeUndefined();
  });
  it.each(['disabled', 'session', 'policy', 'binding', 'expiry'])('rejects activation after fresh %s changes', async kind => {
    const f = await transfer();
    if (kind === 'disabled') await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'alice'));
    if (kind === 'session') await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'alice'));
    if (kind === 'policy') await permitChatGPT({ enabled: false });
    if (kind === 'binding') await importSIWCProfile(alice!, PROFILE);
    if (kind === 'expiry') await db.update(schema.chatgptCompanionAttempts).set({ createdAt: new Date(Date.now() - 700000), expiresAt: new Date(Date.now() - 100000), recoveryUntil: new Date(Date.now() + 10000) }).where(eq(schema.chatgptCompanionAttempts.id, f.attemptId));
    await expect(receiveCompanion(f.attemptId, f.authorization, f.envelope)).rejects.toThrow();
    expect(fixture.validation).toHaveBeenCalledTimes(kind === 'binding' ? 1 : 0);
  });
  it('rechecks signed email before committing and never stores another account', async () => {
    const f = await transfer(); fixture.identity.email = 'bob@test.invalid';
    await expect(receiveCompanion(f.attemptId, f.authorization, f.envelope)).rejects.toThrow();
    expect(await savedCredential()).toBeUndefined(); expect((await attempt(f.attemptId)).state).toBe('needs_attention');
  });
  it('bulk disconnect and user disable fence pending attempts even without a stored credential', async () => {
    const f = await transfer(); await deleteAllChatGPTConnections(); expect((await attempt(f.attemptId)).state).toBe('cancelled');
    await expect(receiveCompanion(f.attemptId, f.authorization, f.envelope)).rejects.toThrow();
    const next = await transfer(); await setUserDisabled('alice', true);
    expect((await attempt(next.attemptId)).state).toBe('cancelled');
    await expect(receiveCompanion(next.attemptId, next.authorization, next.envelope)).rejects.toThrow();
  });
  it('preserves the prior credential when clearing its runtime token cannot be confirmed', async () => {
    await importSIWCProfile(alice!, PROFILE); const before = await savedCredential(), f = await transfer();
    fixture.control.mockRejectedValue(new Error('broker clear failed'));
    await expect(receiveCompanion(f.attemptId, f.authorization, f.envelope)).rejects.toThrow();
    expect((await savedCredential()).secretEnc).toBe(before.secretEnc); expect((await attempt(f.attemptId)).state).toBe('needs_attention');
  });
  it('fences a delayed receive atomically before acknowledging failed recovery', async () => {
    const f = await transfer(); let finish!: () => void, validated!: () => void;
    const waiting = new Promise<void>(resolve => { validated = resolve; });
    fixture.validation.mockImplementationOnce(async () => { validated(); await new Promise<void>(resolve => { finish = resolve; }); return fixture.identity; });
    const receiving = receiveCompanion(f.attemptId, f.authorization, f.envelope);
    const result = receiving.catch(error => error);
    await waiting;
    await expect(cancelNativeCompanion(f.attemptId, f.authorization)).rejects.toThrow();
    const ack = await recoverCompanion(f.attemptId, f.authorization, f.recovery);
    expect(ack.body.state).toBe('needs_attention'); expect((await attempt(f.attemptId)).state).toBe('needs_attention');
    finish(); expect(await result).toBeInstanceOf(Error); expect(await savedCredential()).toBeUndefined();
  });
});
