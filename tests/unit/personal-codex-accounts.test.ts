import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, status: null as BrokerStatus | null, control: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/personal-codex/control', () => ({
  personalControl: fixture.control,
}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { connectionAction, nativeAccount, type BrokerStatus } from '@/personal-codex/contracts';
import { changeConnection, connectionView } from '@/personal-codex/accounts';

const OWNER_ACCOUNT = {
  account: { type: 'chatgpt' as const, email: 'alice@test.invalid', planType: 'business' },
  workspaceRouting: { chatgptAccountId: 'workspace-alice', backendOrigin: 'https://chatgpt.test.invalid', accountRoutingOverride: 'us' as const },
};
const running = (account = OWNER_ACCOUNT): BrokerStatus => ({ state: 'running', account });
let alice: Awaited<ReturnType<typeof loadPrincipal>>;
let bob: Awaited<ReturnType<typeof loadPrincipal>>;

async function account(userId = 'alice') {
  return (await db.select().from(schema.personalCodexAccounts).where(eq(schema.personalCodexAccounts.userId, userId)))[0];
}

async function permitChatGPT(overrides: Record<string, unknown> = {}) {
  const value = {
    enabled: true, access: 'everyone', allowedGroupIds: [], allowedUpns: [], allowedWorkspaceIds: [],
    allowPersonalPlans: true, allowBackground: false, ...overrides,
  };
  await db.insert(schema.settings).values({ key: 'chatgpt', value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

async function insertRun(phase: 'reserved' | 'ready' | 'dispatching' | 'running' | 'terminal' | 'stop_unconfirmed') {
  await db.insert(schema.codexRuns).values({
    runId: `run-${phase}`, userId: 'alice', runtimeId: 'alice-runtime', binding: 'fixture-binding',
    funding: 'chatgpt_subscription', phase,
  });
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
  vi.stubEnv('PERSONAL_CODEX_SOCKET', '/tmp/personal-codex-test.sock');
  fixture.status = running();
  fixture.control.mockReset().mockImplementation(async (_owner: string, action: string) => {
    if (!process.env.PERSONAL_CODEX_SOCKET) {
      const { HttpError } = await import('@/lib/authz');
      throw new HttpError(503, 'Personal Codex is not installed.');
    }
    return action === 'status' || action === 'connect' || action === 'confirm' ? fixture.status! : { state: 'stopped' };
  });
  await fixture.client!.exec('TRUNCATE users, settings, codex_runs CASCADE');
  await db.insert(schema.users).values([
    { id: 'alice', upn: 'alice@test.invalid', email: 'alice@test.invalid', name: 'Alice', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', upn: 'bob@test.invalid', email: 'bob@test.invalid', name: 'Bob', authSource: 'local', identityRealm: 'local' },
  ]);
  alice = await loadPrincipal('alice'); bob = await loadPrincipal('bob');
  await permitChatGPT();
});

afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('Personal Codex account binding', () => {
  it('confirms only real signed-in ChatGPT routing and caller email facts', async () => {
    fixture.status = running({ ...OWNER_ACCOUNT, account: { ...OWNER_ACCOUNT.account, email: 'ALICE@Test.Invalid' } });
    const view = await changeConnection(alice!, 'confirm');
    expect(view).toEqual({ state: 'connected', email: 'ALICE@Test.Invalid', workspaceId: 'workspace-alice', planType: 'business' });
    expect(await account()).toMatchObject({
      userId: 'alice', email: 'alice@test.invalid', workspaceId: 'workspace-alice', planType: 'business', connected: true,
    });
    expect((await db.select().from(schema.personalCodexAccounts))).toHaveLength(1);
    expect(fixture.control).toHaveBeenCalledWith('alice', 'status');
  });

  it.each([
    ['another caller email', { ...OWNER_ACCOUNT, account: { ...OWNER_ACCOUNT.account, email: 'bob@test.invalid' } }],
    ['missing ChatGPT account facts', { account: null, workspaceRouting: OWNER_ACCOUNT.workspaceRouting }],
    ['missing workspace routing', { ...OWNER_ACCOUNT, workspaceRouting: null }],
  ])('rejects confirmation with %s', async (_why, statusAccount) => {
    fixture.status = running(statusAccount as typeof OWNER_ACCOUNT);
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.personalCodexAccounts)).toHaveLength(0);
  });

  it('rejects duplicate normalized ChatGPT email across callers', async () => {
    await changeConnection(alice!, 'confirm');
    await db.update(schema.users).set({ email: 'alice@test.invalid' }).where(eq(schema.users.id, 'bob'));
    bob = await loadPrincipal('bob');
    fixture.status = running({ ...OWNER_ACCOUNT, account: { ...OWNER_ACCOUNT.account, email: 'ALICE@TEST.INVALID' } });
    await expect(changeConnection(bob!, 'confirm')).rejects.toMatchObject({ status: 409 });
    expect(await account('alice')).toMatchObject({ email: 'alice@test.invalid', connected: true });
    expect(await account('bob')).toBeUndefined();
  });

  it('matches confirmation against the locked current email after identity sync without a session rotation', async () => {
    await db.update(schema.users).set({ upn: 'alice@directory.test.invalid' }).where(eq(schema.users.id, 'alice'));
    alice = await loadPrincipal('alice');
    await db.update(schema.users).set({ email: 'renamed@test.invalid' }).where(eq(schema.users.id, 'alice'));
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });
    expect(await account()).toBeUndefined();
  });

  it('accepts only the action discriminant from browser input and strips no claimed actor metadata', () => {
    expect(connectionAction.parse({ action: 'confirm' })).toEqual({ action: 'confirm' });
    for (const claimed of [
      { action: 'confirm', userId: 'bob' }, { action: 'confirm', owner: 'bob' },
      { action: 'confirm', email: 'bob@test.invalid' }, { action: 'confirm', workspaceId: 'workspace-bob' },
    ]) expect(() => connectionAction.parse(claimed)).toThrow();
    expect(() => connectionAction.parse({ action: 'confirm', metadata: { account: OWNER_ACCOUNT } })).toThrow();
  });

  it('preserves credential generation on same-account reconfirmation', async () => {
    await changeConnection(alice!, 'confirm');
    const generation = (await account()).credentialBinding;
    await changeConnection(alice!, 'confirm');
    expect((await account()).credentialBinding).toBe(generation);
  });

  it('rotates credential generation on disconnect and a subsequent new connection', async () => {
    await changeConnection(alice!, 'confirm');
    const initial = (await account()).credentialBinding;
    await changeConnection(alice!, 'disconnect');
    const disconnected = await account();
    expect(disconnected.connected).toBe(false);
    expect(disconnected.credentialBinding).not.toBe(initial);

    fixture.status = running();
    expect((await changeConnection(alice!, 'connect')).state).toBe('confirm');
    await changeConnection(alice!, 'confirm');
    const reconnected = await account();
    expect(reconnected.connected).toBe(true);
    expect(reconnected.credentialBinding).not.toBe(disconnected.credentialBinding);
  });

  it.each(['reserved', 'ready', 'dispatching', 'running', 'stop_unconfirmed'] as const)(
    'blocks account mutation while Codex work is %s but permits retained start', async phase => {
      await insertRun(phase);
      for (const action of ['connect', 'confirm', 'disconnect'] as const)
        await expect(changeConnection(alice!, action)).rejects.toMatchObject({ status: 409 });
      expect(fixture.control).not.toHaveBeenCalled();
      expect(await account()).toBeUndefined();
      await expect(changeConnection(alice!, 'start')).resolves.toMatchObject({ state: 'stopped' });
      expect(fixture.control).toHaveBeenCalledWith('alice', 'start');
      expect(await account()).toBeUndefined();
    },
  );

  it('allows account mutation after Codex work is terminal', async () => {
    await insertRun('terminal');
    await changeConnection(alice!, 'confirm');
    expect(await account()).toMatchObject({ connected: true, email: 'alice@test.invalid' });
  });

  it('denies disabled policy, stale sessions, and disabled users', async () => {
    await db.update(schema.settings).set({ value: { enabled: false, access: 'everyone' } }).where(eq(schema.settings.key, 'chatgpt'));
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });
    await permitChatGPT();

    await db.update(schema.users).set({ sessionVersion: 2 }).where(eq(schema.users.id, 'alice'));
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });
    alice = await loadPrincipal('alice');
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'alice'));
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });
    expect(await account()).toBeUndefined();
  });

  it('lets a valid caller cancel or disconnect retained credentials after policy is disabled', async () => {
    await changeConnection(alice!, 'confirm');
    const originalBinding = (await account()).credentialBinding;
    await db.update(schema.settings).set({ value: { enabled: false, access: 'everyone' } }).where(eq(schema.settings.key, 'chatgpt'));
    await expect(changeConnection(alice!, 'connect')).rejects.toMatchObject({ status: 403 });
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });

    await expect(changeConnection(alice!, 'cancel')).resolves.toMatchObject({ state: 'stopped' });
    expect(fixture.control).toHaveBeenCalledWith('alice', 'cancel');
    await expect(changeConnection(alice!, 'disconnect')).resolves.toMatchObject({ state: 'stopped' });
    expect(fixture.control).toHaveBeenCalledWith('alice', 'disconnect');
    expect(await account()).toMatchObject({ connected: false });
    expect((await account()).credentialBinding).not.toBe(originalBinding);
  });

  it('shows a valid caller retained metadata when policy is disabled and marks connection unavailable', async () => {
    await changeConnection(alice!, 'confirm');
    await db.update(schema.settings).set({ value: { enabled: false, access: 'everyone' } }).where(eq(schema.settings.key, 'chatgpt'));
    await expect(connectionView(alice!)).resolves.toEqual({
      state: 'connected', email: 'alice@test.invalid', workspaceId: 'workspace-alice', planType: 'business', canConnect: false,
    });
  });

  it('returns unavailable without a socket and never calls the broker', async () => {
    vi.stubEnv('PERSONAL_CODEX_SOCKET', '');
    await expect(connectionView(alice!)).resolves.toEqual({ state: 'unavailable' });
    expect(fixture.control).not.toHaveBeenCalled();
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 503 });
  });

  it('retains saved connection metadata after native sign-out so the owner can disconnect it', async () => {
    await changeConnection(alice!, 'confirm');
    fixture.status = { state: 'running', account: { account: null, workspaceRouting: null } };
    await expect(connectionView(alice!)).resolves.toEqual({
      state: 'signed_out', email: 'alice@test.invalid', workspaceId: 'workspace-alice', planType: 'business',
    });
    await changeConnection(alice!, 'disconnect');
    expect(await account()).toMatchObject({ connected: false });
  });

  it('exposes only browser-safe account facts and never stores native tokens or routing origin', async () => {
    fixture.status = running({
      ...OWNER_ACCOUNT,
      account: { ...OWNER_ACCOUNT.account, accessToken: 'fixture-only-token', idToken: 'fixture-only-id-token' } as typeof OWNER_ACCOUNT.account,
      workspaceRouting: { ...OWNER_ACCOUNT.workspaceRouting, backendOrigin: 'https://private-routing.test.invalid' },
    });
    const view = await connectionView(alice!);
    expect(view).toEqual({ state: 'confirm', email: 'alice@test.invalid', workspaceId: 'workspace-alice', planType: 'business' });
    expect(JSON.stringify(view)).not.toMatch(/fixture-only|backendOrigin|private-routing|credentialBinding|accessToken|idToken/);
    await changeConnection(alice!, 'confirm');
    const stored = await account();
    expect(JSON.stringify(stored)).not.toMatch(/fixture-only|private-routing|accessToken|idToken/);
    expect(stored).not.toHaveProperty('backendOrigin');
  });

  it('requires actual workspace and plan policy approval', async () => {
    await db.update(schema.settings).set({ value: {
      enabled: true, access: 'everyone', allowedGroupIds: [], allowedUpns: [], allowedWorkspaceIds: ['workspace-approved'],
      allowPersonalPlans: false, allowBackground: false,
    } }).where(eq(schema.settings.key, 'chatgpt'));
    await expect(changeConnection(alice!, 'confirm')).rejects.toMatchObject({ status: 403 });
    expect(await account()).toBeUndefined();
  });

  it('validates broker facts as ChatGPT account plus workspace routing', () => {
    expect(nativeAccount.parse(OWNER_ACCOUNT)).toEqual(OWNER_ACCOUNT);
    expect(() => nativeAccount.parse({ ...OWNER_ACCOUNT, account: { type: 'apiKey', email: 'alice@test.invalid', planType: 'business' } })).toThrow();
    expect(() => nativeAccount.parse({ ...OWNER_ACCOUNT, workspaceRouting: { ...OWNER_ACCOUNT.workspaceRouting, accountRoutingOverride: 'host' } })).toThrow();
  });
});
