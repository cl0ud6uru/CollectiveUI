import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
import { eq } from 'drizzle-orm';

const fixture = vi.hoisted(() => ({
  client: null as PGlite | null,
  control: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  admin: null as Principal | null,
  ownerLocked: false,
  identity: { subject: 'siwc-subject', email: 'alice@test.invalid', clientId: 'issued-client-id', expiresAt: new Date(Date.now() + 3_600_000) },
}));
vi.mock('server-only', () => ({}));
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
    validateSIWCCredential: vi.fn(async () => fixture.identity),
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
import { deleteAllChatGPTConnections, getChatGPTAuth, openCredentialSecret, sealCredentialSecret } from '@/lib/llm/chatgpt/store';
import { changeUnifiedAccount, importSIWCProfile, unifiedAccountView } from '@/lib/llm/chatgpt/account';
import { assertCurrentSIWCConnection } from '@/lib/llm/chatgpt/invalidation';
import { tokenFingerprint } from '@/personal-codex/contracts';
import { PersonalControlError } from '@/personal-codex/control';
import { disconnectAllChatGPT, setUserDisabled } from '@/app/admin/actions';
import { validateSIWCCredential } from '@/lib/llm/chatgpt/siwc';

const HOST_ID = 'urn:uuid:123e4567-e89b-42d3-a456-426614174000';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PROFILE = {
  version: 1, kind: 'siwc', clientId: 'issued-client-id', accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token',
  idToken: 'synthetic-id-token', expiresIn: 3600, scope: SCOPE, hostId: HOST_ID, createdAt: new Date().toISOString(),
};
let alice: Awaited<ReturnType<typeof loadPrincipal>>;
let bob: Awaited<ReturnType<typeof loadPrincipal>>;

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

async function importOwnProfile() {
  fixture.identity = { ...fixture.identity, subject: 'siwc-subject', email: 'alice@test.invalid', clientId: 'issued-client-id' };
  return importSIWCProfile(alice!, PROFILE);
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
    return { state: 'stopped' };
  });
  fixture.refresh.mockReset();
  fixture.revoke.mockReset().mockResolvedValue(false);
  await fixture.client!.exec('TRUNCATE users, settings, codex_runs, user_credentials CASCADE');
  await db.insert(schema.users).values([
    { id: 'alice', upn: 'alice@test.invalid', email: 'alice@test.invalid', name: 'Alice', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', upn: 'bob@test.invalid', email: 'bob@test.invalid', name: 'Bob', authSource: 'local', identityRealm: 'local' },
    { id: 'admin', upn: 'admin@test.invalid', email: 'admin@test.invalid', name: 'Admin', authSource: 'ldap', identityRealm: 'directory', isAdmin: true },
  ]);
  alice = await loadPrincipal('alice'); bob = await loadPrincipal('bob');
  fixture.admin = await loadPrincipal('admin');
  await permitChatGPT();
});

afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('unified ChatGPT account', () => {
  it('starts with default account facts and shows a usable onboarding path for an allowed member', async () => {
    await db.delete(schema.settings).where(eq(schema.settings.key, 'chatgpt'));
    await expect(unifiedAccountView(alice!)).resolves.toMatchObject({
      allowed: false, credential: null, backends: { native: { state: 'disabled' } }, onboarding: { state: 'ready' },
    });
    await permitChatGPT();
    await expect(unifiedAccountView(alice!)).resolves.toMatchObject({
      allowed: true, reason: null, credential: null,
      backends: { native: { state: 'not_connected' }, codex: { state: 'stopped' } },
      onboarding: { state: 'ready' },
    });
    await expect(changeUnifiedAccount(alice!, 'start')).resolves.toMatchObject({ hostId: HOST_ID, userId: 'alice', instructions: expect.any(String) });
  });

  it('allows admins while denying an unlisted member and preserves unavailable broker status as backend-only', async () => {
    await permitChatGPT({ access: 'selected' });
    const admin = await loadPrincipal('admin');
    await expect(unifiedAccountView(admin!)).resolves.toMatchObject({ allowed: true, backends: { native: { state: 'not_connected' } } });
    await expect(unifiedAccountView(bob!)).resolves.toMatchObject({ allowed: false, backends: { native: { state: 'disabled' }, codex: { state: 'disabled' } } });

    fixture.control.mockRejectedValue(new Error('broker is offline'));
    await expect(unifiedAccountView(admin!)).resolves.toMatchObject({
      allowed: true, backends: { native: { state: 'not_connected' }, codex: { state: 'backend_error', reason: expect.any(String) } },
    });
  });

  it('requires an explicit session refresh after session rotation', async () => {
    await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'alice'));
    await expect(changeUnifiedAccount(alice!, 'start')).rejects.toMatchObject({ status: 403 });
    expect(fixture.control).not.toHaveBeenCalled();
  });

  it('imports only a signed identity matching the caller email and saves the issued binding', async () => {
    fixture.identity = { ...fixture.identity, email: 'bob@test.invalid' };
    await expect(importSIWCProfile(alice!, PROFILE)).rejects.toMatchObject({ status: 403 });
    expect(await savedCredential()).toBeUndefined();

    fixture.identity = { ...fixture.identity, email: 'ALICE@test.invalid' };
    await expect(importSIWCProfile(alice!, PROFILE)).resolves.toMatchObject({ email: 'alice@test.invalid', status: 'active' });
    const stored = await savedCredential();
    expect(stored).toMatchObject({ accountId: 'siwc:issued-client-id', externalSubject: 'siwc-subject', email: 'alice@test.invalid', planType: null });
    expect(stored.secretEnc).not.toContain('synthetic-access-token');
    await expect(unifiedAccountView(alice!)).resolves.toMatchObject({ backends: { native: { state: 'connected' } } });
  });

  it('accepts a transferred profile from its source host and binds it to this installation', async () => {
    const sourceHost = 'urn:uuid:123e4567-e89b-42d3-b456-426614174000';
    const transferred = { ...PROFILE, hostId: sourceHost };
    await expect(importSIWCProfile(alice!, transferred)).resolves.toMatchObject({ email: 'alice@test.invalid' });
    expect(validateSIWCCredential).toHaveBeenCalledWith(transferred, { hostId: sourceHost });
    const stored = await savedCredential();
    expect(openCredentialSecret(stored!).siwc).toMatchObject({ hostId: HOST_ID, clientId: 'issued-client-id' });
    const auth = await getChatGPTAuth('alice');
    expect(auth.accountId).toBe('siwc:issued-client-id');
  });

  it('rejects the same signed account and subject when another portal user imports it', async () => {
    await importOwnProfile();
    await db.update(schema.users).set({ email: 'alice@test.invalid' }).where(eq(schema.users.id, 'bob'));
    bob = await loadPrincipal('bob');
    await expect(importSIWCProfile(bob!, PROFILE)).rejects.toThrow(/already connected by someone else/i);
    expect(await savedCredential('alice')).toBeDefined();
    expect(await savedCredential('bob')).toBeUndefined();
  });

  it.each([
    ['a legacy workspace allowlist', { allowedWorkspaceIds: ['legacy-workspace'] }],
    ['personal plans disabled', { allowPersonalPlans: false }],
  ])('fails closed when importing opaque SIWC metadata under %s', async (_why, policy) => {
    await permitChatGPT(policy);
    await expect(importSIWCProfile(alice!, PROFILE)).rejects.toMatchObject({ status: 403 });
    expect(await savedCredential()).toBeUndefined();
  });

  it('marks legacy credentials for migration and refuses to use them as SIWC auth', async () => {
    const id = 'legacy-credential';
    await db.insert(schema.userCredentials).values({
      id, userId: 'alice', provider: 'chatgpt', accountId: 'legacy-account', email: 'alice@test.invalid',
      externalSubject: 'legacy-subject', secretEnc: sealCredentialSecret(id, { access: 'legacy-access-token', refresh: 'legacy-refresh-token' }),
      status: 'active', expiresAt: new Date(Date.now() + 3_600_000),
    });
    await expect(unifiedAccountView(alice!)).resolves.toMatchObject({ credential: { migrationRequired: true }, backends: { native: { state: 'migration_required' } } });
    await expect(getChatGPTAuth('alice')).rejects.toMatchObject({ status: 409 });
  });

  it('serializes concurrent refreshes with the issued client ID and keeps stock Codex account binding stable', async () => {
    fixture.identity = { ...fixture.identity, expiresAt: new Date(Date.now() + 1000) };
    await importOwnProfile();
    fixture.refresh.mockImplementation(async (refresh: string, clientId: string, _fetch: typeof fetch, subject?: string) => {
      expect(refresh).toBe('synthetic-refresh-token');
      return { ok: true, tokens: { accessToken: 'refreshed-access-token', refreshToken: 'rotated-refresh-token', expiresIn: 3600 } };
    });
    const [first, second] = await Promise.all([getChatGPTAuth('alice'), getChatGPTAuth('alice')]);
    expect(first.accessToken).toBe('refreshed-access-token');
    expect(second.accessToken).toBe('refreshed-access-token');
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).toHaveBeenCalledWith('synthetic-refresh-token', 'issued-client-id', undefined, 'siwc-subject');

    await changeUnifiedAccount(alice!, 'sync-token');
    const accountBefore = (await db.select().from(schema.personalCodexAccounts))[0];
    const firstSyncToken = fixture.control.mock.calls.find(call => call[1] === 'sync-token')?.[2];
    expect(firstSyncToken).toMatchObject({ accessToken: 'refreshed-access-token' });
    expect(accountBefore.credentialBinding).not.toBe(firstSyncToken.credentialBinding);

    await db.update(schema.userCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.userCredentials.userId, 'alice'));
    fixture.refresh.mockResolvedValue({ ok: true, tokens: { accessToken: 'rotated-access-token', refreshToken: 'new-refresh-token', expiresIn: 3600 } });
    await changeUnifiedAccount(alice!, 'sync-token');
    const accountAfter = (await db.select().from(schema.personalCodexAccounts))[0];
    const syncTokens = fixture.control.mock.calls.filter(call => call[1] === 'sync-token').map(call => call[2]);
    expect(syncTokens[1]).toMatchObject({ accessToken: 'rotated-access-token' });
    expect(syncTokens[1].credentialBinding).not.toBe(syncTokens[0].credentialBinding);
    expect(accountAfter.credentialBinding).toBe(accountBefore.credentialBinding);

    fixture.control.mockImplementation(async (_owner: string, action: string) => action === 'status'
      ? { state: 'running', siwc: { available: true, credentialBinding: syncTokens[0].credentialBinding } }
      : { state: 'stopped' });
    await expect(unifiedAccountView(alice!)).resolves.toMatchObject({ backends: { native: { state: 'connected' }, codex: { state: 'not_connected' } } });
    fixture.control.mockImplementation(async (_owner: string, action: string) => action === 'status'
      ? { state: 'running', siwc: { available: true, credentialBinding: syncTokens[1].credentialBinding } }
      : { state: 'stopped' });
    await expect(unifiedAccountView(alice!)).resolves.toMatchObject({ backends: { codex: { state: 'connected' } } });
  }, 15000);

  it('blocks disconnect during active Codex work, then removes credentials while retaining workspace rows', async () => {
    await importOwnProfile();
    await db.insert(schema.personalCodexAccounts).values({
      userId: 'alice', credentialBinding: 'old-binding', email: 'alice@test.invalid', workspaceId: 'retained-workspace', planType: 'unknown', connected: true,
    });
    await db.insert(schema.codexRuns).values({ runId: 'active-run', userId: 'alice', runtimeId: 'runtime', binding: 'binding', funding: 'chatgpt_subscription', phase: 'running' });
    await expect(changeUnifiedAccount(alice!, 'disconnect')).rejects.toMatchObject({ status: 409 });
    expect(await savedCredential()).toBeDefined();
    expect(fixture.control).not.toHaveBeenCalledWith('alice', 'disconnect');

    await db.update(schema.codexRuns).set({ phase: 'terminal' }).where(eq(schema.codexRuns.runId, 'active-run'));
    await expect(changeUnifiedAccount(alice!, 'disconnect')).resolves.toEqual({ disconnected: true, revocationConfirmed: false });
    expect(await savedCredential()).toBeUndefined();
    expect(await db.select().from(schema.personalCodexAccounts)).toMatchObject([{ connected: false, workspaceId: 'retained-workspace' }]);
    expect(fixture.control).toHaveBeenCalledWith('alice', 'disconnect');
    expect(fixture.revoke).toHaveBeenCalledWith({ refreshToken: 'synthetic-refresh-token', accessToken: 'synthetic-access-token', clientId: 'issued-client-id' }, undefined);
  }, 15000);

  async function retainedBinding(owner = 'alice') {
    await db.insert(schema.personalCodexAccounts).values({ userId: owner, credentialBinding: `old-${owner}-binding`,
      email: `${owner}@test.invalid`, workspaceId: owner === 'alice' ? 'siwc:issued-client-id' : 'retained-workspace', planType: 'unknown', connected: true });
  }

  it('admin bulk disconnect clears each broker, invalidates retained bindings even without credentials, and revokes after deletion', async () => {
    await importOwnProfile(); await retainedBinding(); await retainedBinding('bob');
    fixture.control.mockImplementation(async (owner: string, action: string) => {
      expect(action).toBe('disconnect');
      if (owner === 'alice') expect(fixture.revoke).not.toHaveBeenCalled();
      return { state: 'running', siwc: { available: true } };
    });
    fixture.revoke.mockImplementation(async () => { expect(await savedCredential()).toBeUndefined(); return true; });
    await expect(disconnectAllChatGPT()).resolves.toEqual({ disconnected: 1 });
    expect(fixture.control.mock.calls).toEqual([['alice', 'disconnect'], ['bob', 'disconnect']]);
    const accounts = await db.select().from(schema.personalCodexAccounts);
    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(account.connected).toBe(false);
      expect(account.credentialBinding).not.toBe(`old-${account.userId}-binding`);
    }
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
  });

  it('bulk disconnect fails explicitly on active or unconfirmed work and preserves the credential and binding', async () => {
    await importOwnProfile(); await retainedBinding();
    await db.insert(schema.codexRuns).values({ runId: 'unconfirmed-stop', userId: 'alice', runtimeId: 'runtime', binding: 'binding', funding: 'chatgpt_subscription', phase: 'stop_unconfirmed' });
    await expect(deleteAllChatGPTConnections()).rejects.toMatchObject({ status: 409 });
    expect(await savedCredential()).toBeDefined();
    expect((await db.select().from(schema.personalCodexAccounts))[0]).toMatchObject({ connected: true, credentialBinding: 'old-alice-binding' });
    expect(fixture.control).not.toHaveBeenCalled(); expect(fixture.revoke).not.toHaveBeenCalled();
  });

  it('admin disable clears runtime auth and rotates the binding on its lock connection, with revocation after lock release', async () => {
    await importOwnProfile(); await retainedBinding();
    fixture.control.mockImplementation(async () => {
      expect(fixture.ownerLocked).toBe(true);
      expect(fixture.revoke).not.toHaveBeenCalled();
      return { state: 'running', siwc: { available: true } };
    });
    fixture.revoke.mockImplementation(async () => { expect(fixture.ownerLocked).toBe(false); return true; });
    await setUserDisabled('alice', true);
    expect((await db.select().from(schema.users).where(eq(schema.users.id, 'alice')))[0]).toMatchObject({ disabled: true, sessionVersion: 1 });
    expect(await savedCredential()).toBeUndefined();
    expect((await db.select().from(schema.personalCodexAccounts))[0]).toMatchObject({ connected: false });
    expect(fixture.control).toHaveBeenCalledWith('alice', 'disconnect');
    expect(fixture.revoke).toHaveBeenCalledTimes(1);
  });

  it.each(['broker failure', 'active work'])('rolls back disabling and retains auth for retry after %s', async cause => {
    await importOwnProfile(); await retainedBinding();
    if (cause === 'broker failure') fixture.control.mockRejectedValue(new Error('broker token clear failed'));
    else await db.insert(schema.codexRuns).values({ runId: 'active-disable', userId: 'alice', runtimeId: 'runtime', binding: 'binding', funding: 'chatgpt_subscription', phase: 'running' });
    await expect(setUserDisabled('alice', true)).rejects.toThrow();
    expect((await db.select().from(schema.users).where(eq(schema.users.id, 'alice')))[0]).toMatchObject({ disabled: false, sessionVersion: 0 });
    expect(await savedCredential()).toBeDefined();
    expect((await db.select().from(schema.personalCodexAccounts))[0]).toMatchObject({ connected: true, credentialBinding: 'old-alice-binding' });
    expect(fixture.revoke).not.toHaveBeenCalled();
  });

  it('keeps owner and bulk credentials for retry when broker token clearing fails', async () => {
    await importOwnProfile(); await retainedBinding();
    fixture.control.mockRejectedValue(new Error('broker token clear failed'));
    await expect(changeUnifiedAccount(alice!, 'disconnect')).rejects.toThrow('broker token clear failed');
    await expect(disconnectAllChatGPT()).rejects.toThrow('broker token clear failed');
    expect(await savedCredential()).toBeDefined();
    expect((await db.select().from(schema.personalCodexAccounts))[0]).toMatchObject({ connected: true, credentialBinding: 'old-alice-binding' });
    expect(fixture.revoke).not.toHaveBeenCalled();
  });

  it('clears broker auth even without a portal binding and accepts only a confirmed unenrolled owner', async () => {
    await importOwnProfile();
    await changeUnifiedAccount(alice!, 'disconnect');
    expect(fixture.control).toHaveBeenCalledWith('alice', 'disconnect');
    await importOwnProfile();
    fixture.control.mockRejectedValue(new PersonalControlError(403, 'not enrolled', 'not_enrolled'));
    await expect(changeUnifiedAccount(alice!, 'disconnect')).resolves.toMatchObject({ disconnected: true });
    expect(await savedCredential()).toBeUndefined();
    await importOwnProfile(); await retainedBinding();
    await expect(changeUnifiedAccount(alice!, 'disconnect')).rejects.toMatchObject({ code: 'not_enrolled' });
    expect(await savedCredential()).toBeDefined();
  });

  it('retains auth when a retained personal account has lost its broker configuration', async () => {
    await importOwnProfile(); await retainedBinding();
    vi.stubEnv('PERSONAL_CODEX_SOCKET', '');
    await expect(changeUnifiedAccount(alice!, 'disconnect')).rejects.toMatchObject({ status: 503 });
    expect(await savedCredential()).toBeDefined();
    expect(fixture.control).not.toHaveBeenCalled(); expect(fixture.revoke).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'deleted credential', 'invalidated binding'])('rejects stale SIWC runtime readiness when the portal has %s', async cause => {
    await importOwnProfile(); await retainedBinding();
    const verify = () => assertCurrentSIWCConnection('alice', 'old-alice-binding', tokenFingerprint(PROFILE.accessToken));
    await expect(verify()).resolves.toBeUndefined();
    if (cause === 'disabled') await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'alice'));
    else if (cause === 'deleted credential') await db.delete(schema.userCredentials).where(eq(schema.userCredentials.userId, 'alice'));
    else await db.update(schema.personalCodexAccounts).set({ connected: false }).where(eq(schema.personalCodexAccounts.userId, 'alice'));
    await expect(verify()).rejects.toMatchObject({ status: 409 });
  });
});
