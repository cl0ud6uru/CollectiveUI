import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
const f = vi.hoisted(() => ({ base: '' }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import type { DashboardSecrets } from '@/lib/remote-hermes/client';
import type { DashboardSocket as Socket } from '@/lib/remote-hermes/socket';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';
import { assertDisposableHermesDatabase } from '../fixtures/remote-hermes-disposable-database';
let db: typeof import('@/db').db, pool: typeof import('@/db').pool;
let DashboardClient: typeof import('@/lib/remote-hermes/client').DashboardClient;
let DashboardSocket: typeof import('@/lib/remote-hermes/socket').DashboardSocket;
let nativeHub: typeof import('@/lib/remote-hermes/hub').nativeHub;
let nativeControl: typeof import('@/lib/remote-hermes/sessions').nativeControl, submitNativePrompt: typeof import('@/lib/remote-hermes/sessions').submitNativePrompt;
let nativeAdministration: typeof import('@/lib/remote-hermes/administration').nativeAdministration;
// This conformance suite explicitly exercises the worst-case production pool slot budget.
const enabled = process.env.REMOTE_HERMES_NATIVE_DATABASE_CONFORMANCE === '1' && process.env.DATABASE_POOL_MAX === '1';
const owner = newId(), connection = newId();
let processFixture: Awaited<ReturnType<typeof startPinnedDashboard>>, bootstrapSocket: Socket;
let secrets: DashboardSecrets, auth: import('@/lib/remote-hermes/client').DashboardClient;
const row = async (id: string) => (await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, id)))[0];
async function control(body: unknown) {
  const response = await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Synthetic control failed');
}
async function metrics() { return (await fetch(f.base + '/api/__fixture/metrics', { headers: { Authorization: `Bearer ${secrets.accessToken}` } })).json(); }
async function session(profile = 'default') {
  const created = await bootstrapSocket.call('session.create', { profile, close_on_disconnect: false });
  const id = newId();
  await db.insert(remoteHermesSessions).values({ id, connectionId: connection, profile, storedId: String(created.stored_session_id) });
  return id;
}
describe.skipIf(!enabled)('actual pinned dashboard plus disposable PostgreSQL admission/reservations', () => {
  beforeAll(async () => {
    assertDisposableHermesDatabase(process.env.DATABASE_URL);
    ({ db, pool } = await import('@/db'));
    ({ DashboardClient } = await import('@/lib/remote-hermes/client'));
    ({ DashboardSocket } = await import('@/lib/remote-hermes/socket'));
    ({ nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ nativeControl, submitNativePrompt } = await import('@/lib/remote-hermes/sessions'));
    ({ nativeAdministration } = await import('@/lib/remote-hermes/administration'));
    processFixture = await startPinnedDashboard(); f.base = processFixture.base;
    const bootstrap = new DashboardClient(f.base, fetch);
    expect((await bootstrap.status()).version).toBe('0.21.5');
    secrets = await bootstrap.passwordLogin('synthetic', 'synthetic-password'); auth = new DashboardClient(f.base, fetch, secrets);
    await db.insert(users).values({ id: owner, upn: `native-conformance-${owner}`, name: 'Synthetic fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic pinned dashboard', baseUrl: f.base, authMode: 'password', secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(connection, owner)) });
    bootstrapSocket = new DashboardSocket(async () => ({ url: new URL(`${f.base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await auth.websocketTicket())}`), options: {} }), () => {});
    await bootstrapSocket.connect();
  }, 45000);
  afterAll(async () => {
    bootstrapSocket?.close();
    if (f.base) nativeHub(owner, connection).close();
    if (enabled && f.base) await db.delete(users).where(eq(users.id, owner));
    await processFixture?.stop(); await pool?.end();
  });
  it('dispatches only one contending queued receipt through actual native transport', async () => {
    const id = await session(), hub = nativeHub(owner, connection);
    await submitNativePrompt(owner, connection, id, randomUUID(), 'fixture-hold');
    const queue = (text: string) => nativeControl(owner, connection, id, 'queue', { requestId: randomUUID(), text }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    const outcomes = await Promise.all([queue('fixture-next-one'), queue('fixture-next-two')]);
    expect(outcomes.filter(outcome => outcome.error === null)).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.error?.status === 409)).toHaveLength(1);
    expect((await row(id)).queueStatus).toBe('queued');
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, id))).toHaveLength(2);
    await nativeControl(owner, connection, id, 'stop');
    await vi.waitFor(async () => expect((await hub.refresh(await row(id))).running).toBe(false), { timeout: 10_000 });
    expect((await row(id)).queueRequestId).toBeNull();
  }, 20000);
  it('retains a durable no-replay receipt after real native acceptance loses its acknowledgement', async () => {
    const id = await session(), requestId = randomUUID(), before = (await metrics()).agent_turns;
    await control({ drop_next_ack: true });
    await expect(submitNativePrompt(owner, connection, id, requestId, 'fixture-lost-ack')).rejects.toThrow('may have been accepted');
    expect(await submitNativePrompt(owner, connection, id, requestId, 'fixture-lost-ack')).toEqual({ accepted: true, duplicate: true });
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, id))).toHaveLength(1);
    await vi.waitFor(async () => expect((await metrics()).agent_turns).toBe(before + 1), { timeout: 10_000 });
    expect((await metrics()).external_attempts).toBe(0);
  }, 20000);
  it('completes concurrent custom-server writes with one pooled DB client across profiles', async () => {
    expect(pool.options.max).toBe(1);
    const profileName = `pool-one-${owner.slice(0, 8)}`;
    const createProfile = await fetch(f.base + '/api/profiles', { method: 'POST', headers: {
      Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ name: profileName, no_skills: true }) });
    expect(createProfile.ok).toBe(true);
    await createProfile.body?.cancel();
    expect((await auth.profiles()).some(profile => profile.name === profileName)).toBe(true);
    const defaultSession = await session('default');
    const secondSession = await session(profileName);
    const operation = (sessionId: string, name: string, token: string) => nativeAdministration(owner, connection, sessionId, {
      operation: 'customServer', requestId: randomUUID(), name,
      url: 'https://mcp.example.invalid/v1', bearerToken: token, confirmed: true,
    });
    let timer: NodeJS.Timeout | undefined;
    const outcomes = await Promise.race([
      Promise.all([
        operation(defaultSession, 'fixture-pool-default', 'synthetic-pool-default-key'),
        operation(secondSession, 'fixture-pool-second', 'synthetic-pool-second-key'),
      ]),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('pool-one MCP admin dispatch stalled')), 15_000); }),
    ]).finally(() => clearTimeout(timer));
    expect(outcomes).toEqual([
      expect.objectContaining({ accepted: true, added: true }),
      expect.objectContaining({ accepted: true, added: true }),
    ]);
    expect(pool.waitingCount).toBe(0);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, defaultSession))).toHaveLength(1);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, secondSession))).toHaveLength(1);
  }, 25000);
});
