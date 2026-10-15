import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
const f = vi.hoisted(() => ({ base: '' }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));
import { db, pool } from '@/db';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { DashboardClient, type DashboardSecrets } from '@/lib/remote-hermes/client';
import { DashboardSocket } from '@/lib/remote-hermes/socket';
import { nativeHub } from '@/lib/remote-hermes/hub';
import { nativeControl, submitNativePrompt } from '@/lib/remote-hermes/sessions';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';
const enabled = process.env.REMOTE_HERMES_NATIVE_DATABASE_CONFORMANCE === '1';
const owner = newId(), connection = newId();
let processFixture: Awaited<ReturnType<typeof startPinnedDashboard>>, bootstrapSocket: DashboardSocket;
let secrets: DashboardSecrets, auth: DashboardClient;
const row = async (id: string) => (await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, id)))[0];
async function control(body: unknown) {
  const response = await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Synthetic control failed');
}
async function metrics() { return (await fetch(f.base + '/api/__fixture/metrics', { headers: { Authorization: `Bearer ${secrets.accessToken}` } })).json(); }
async function session() {
  const created = await bootstrapSocket.call('session.create', { profile: 'default', close_on_disconnect: false });
  const id = newId();
  await db.insert(remoteHermesSessions).values({ id, connectionId: connection, profile: 'default', storedId: String(created.stored_session_id) });
  return id;
}
describe.skipIf(!enabled)('actual pinned dashboard plus disposable PostgreSQL admission/reservations', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
    if (url?.pathname !== '/hermes_fixture' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Named disposable loopback hermes_fixture database required');
    processFixture = await startPinnedDashboard(); f.base = processFixture.base;
    const bootstrap = new DashboardClient(f.base, fetch);
    await vi.waitFor(async () => expect((await bootstrap.status()).version).toBe('0.21.5'));
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
    await processFixture?.stop(); await pool.end();
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
    await vi.waitFor(async () => expect((await hub.refresh(await row(id))).running).toBe(false));
    expect((await row(id)).queueRequestId).toBeNull();
  }, 20000);
  it('retains a durable no-replay receipt after real native acceptance loses its acknowledgement', async () => {
    const id = await session(), requestId = randomUUID(), before = (await metrics()).agent_turns;
    await control({ drop_next_ack: true });
    await expect(submitNativePrompt(owner, connection, id, requestId, 'fixture-lost-ack')).rejects.toThrow('may have been accepted');
    expect(await submitNativePrompt(owner, connection, id, requestId, 'fixture-lost-ack')).toEqual({ accepted: true, duplicate: true });
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, id))).toHaveLength(1);
    await vi.waitFor(async () => expect((await metrics()).agent_turns).toBe(before + 1));
    expect((await metrics()).external_attempts).toBe(0);
  }, 20000);
});
