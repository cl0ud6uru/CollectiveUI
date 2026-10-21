import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesHubOwners, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import type { DashboardSecrets } from '@/lib/remote-hermes/client';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';
import { assertDisposableHermesDatabase } from '../fixtures/remote-hermes-disposable-database';

const f = vi.hoisted(() => ({ base: '' }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));
const enabled = process.env.REMOTE_HERMES_OWNER_CONFORMANCE === '1';
let owner = '', connection = '';
let db: typeof import('@/db').db, pool: typeof import('@/db').pool;
let DashboardClient: typeof import('@/lib/remote-hermes/client').DashboardClient;
let DashboardSocket: typeof import('@/lib/remote-hermes/socket').DashboardSocket;
let NativeHub: typeof import('@/lib/remote-hermes/hub').NativeHub;
let nativeHub: typeof import('@/lib/remote-hermes/hub').nativeHub;
let openNativeSession: typeof import('@/lib/remote-hermes/sessions').openNativeSession;
let submitNativePrompt: typeof import('@/lib/remote-hermes/sessions').submitNativePrompt;
let inspectNative: typeof import('@/lib/remote-hermes/operations').inspectNative;
let fixture: Awaited<ReturnType<typeof startPinnedDashboard>>, secrets: DashboardSecrets;
const successors: InstanceType<typeof import('@/lib/remote-hermes/hub').NativeHub>[] = [];
const extraSockets: InstanceType<typeof import('@/lib/remote-hermes/socket').DashboardSocket>[] = [];
const row = async (id: string) => (await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, id)))[0];
const lease = async () => (await db.select().from(remoteHermesHubOwners).where(eq(remoteHermesHubOwners.connectionId, connection)))[0];
async function metrics() {
  return (await fetch(f.base + '/api/__fixture/metrics', { headers: { Authorization: `Bearer ${secrets.accessToken}` } })).json();
}
async function claimElsewhere(profile: string) {
  const auth = new DashboardClient(f.base, fetch, secrets);
  const socket = new DashboardSocket(async () => ({ url: new URL(`${f.base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await auth.websocketTicket())}`), options: {} }), () => {});
  extraSockets.push(socket);
  await socket.connect();
  const current = await socket.call('collective.hub_owner.current', { profile });
  await socket.call('collective.hub_owner.claim', { profile, phase: 'full', portal_connection_id: randomUUID(), portal_instance_id: randomUUID(),
    portal_generation: 1, portal_socket_epoch: 1, expected_native_generation: current.native_generation });
  return socket;
}

describe.skipIf(!enabled)('actual native owner adapter with PostgreSQL portal ownership', () => {
  beforeAll(async () => {
    assertDisposableHermesDatabase(process.env.DATABASE_URL);
    ({ db, pool } = await import('@/db'));
    ({ DashboardClient } = await import('@/lib/remote-hermes/client'));
    ({ DashboardSocket } = await import('@/lib/remote-hermes/socket'));
    ({ NativeHub, nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ openNativeSession, submitNativePrompt } = await import('@/lib/remote-hermes/sessions'));
    ({ inspectNative } = await import('@/lib/remote-hermes/operations'));
  });
  beforeEach(async () => {
    owner = newId(); connection = newId();
    fixture = await startPinnedDashboard({ recoveryAdapters: true }); f.base = fixture.base;
    secrets = await new DashboardClient(f.base, fetch).passwordLogin('synthetic', 'synthetic-password');
    await db.insert(users).values({ id: owner, upn: `owner-conformance-${owner}`, name: 'Synthetic owner fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic owner dashboard', baseUrl: f.base, authMode: 'password',
      secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(connection, owner)) });
  }, 45000);
  afterEach(async () => {
    for (const socket of extraSockets.splice(0)) socket.close();
    for (const hub of successors.splice(0)) hub.close();
    if (f.base) { nativeHub(owner, connection).close(); await db.delete(users).where(eq(users.id, owner)); }
    await fixture?.stop(); f.base = '';
  });
  afterAll(async () => { await pool?.end(); });

  it.each(['refresh', 'view'] as const)('takes over an expired foreign lease on direct cold %s without replaying a completed turn', async operation => {
    const session = await openNativeSession(owner, connection, 'default'), oldHub = nativeHub(owner, connection);
    const text = `fixture-ordinary-${operation}`, requestId = randomUUID();
    await submitNativePrompt(owner, connection, session.id, requestId, text);
    await vi.waitFor(async () => expect((await oldHub.refresh(await row(session.id))).running).toBe(false), { timeout: 10_000 });
    const saved = await row(session.id), oldLease = await lease();
    const native = await oldHub.socket.call('collective.hub_owner.current', { profile: 'default' });
    await expect(oldHub.socket.call('session.close', { profile: saved.profile, session_id: saved.runtimeId })).resolves.toMatchObject({ closed: true });
    // Native close signals pollers to stop, but their tracked threads can outlive
    // its reply. This idle-takeover proof must first establish actual quiescence.
    await vi.waitFor(async () => {
      const workers = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
        headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_workers: true }) });
      expect(workers.ok).toBe(true);
      expect(await workers.json()).toMatchObject({ default: 0 });
    }, { timeout: 10_000 });
    oldHub.close();
    const blocked = new NativeHub(owner, connection, randomUUID()); successors.push(blocked);
    // Negotiation must never steal a live lease or dispatch a native resume.
    await expect(blocked[operation](saved)).rejects.toMatchObject({ status: 409 });
    expect(await lease()).toMatchObject({ ownerInstanceId: oldHub.instanceId, generation: oldLease.generation });
    blocked.close();
    await db.update(remoteHermesHubOwners).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(remoteHermesHubOwners.connectionId, connection));
    const successor = new NativeHub(owner, connection, randomUUID()); successors.push(successor);
    expect(successor.socket.connectionEpoch).toBe(0);
    await expect(successor[operation](saved)).resolves.toMatchObject({ id: saved.id, profile: saved.profile, running: false });
    expect(await lease()).toMatchObject({ ownerInstanceId: successor.instanceId, generation: Number(oldLease.generation) + 1 });
    expect(await successor.socket.call('collective.hub_owner.current', { profile: saved.profile })).toMatchObject({
      portal_instance_id: successor.instanceId, native_generation: Number(native.native_generation) + 1, phase: 'full', transport_bound: true,
    });
    const history = await new DashboardClient(f.base, fetch, secrets).history(saved.profile, saved.storedId, 0);
    expect(history.messages.some(message => message.text.includes(text))).toBe(true);
    expect(history.messages.some(message => message.role === 'assistant')).toBe(true);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, saved.id))).toHaveLength(1);
    expect(await metrics()).toMatchObject({ agent_turns: 1, external_attempts: 0 });
  }, 30000);

  it('lets a new portal instance prepare recovery after the old lease expires without claiming native ownership', async () => {
    const session = await openNativeSession(owner, connection, 'default'), oldHub = nativeHub(owner, connection);
    const saved = await row(session.id), oldLease = await lease();
    const native = await oldHub.socket.call('collective.hub_owner.current', { profile: 'default' });
    oldHub.close();
    const successor = new NativeHub(owner, connection, randomUUID()); successors.push(successor);
    await expect(successor.prepareRecoveryOwnership(saved)).rejects.toMatchObject({ status: 409 });
    expect(await lease()).toMatchObject({ ownerInstanceId: oldHub.instanceId, generation: oldLease.generation });
    await db.update(remoteHermesHubOwners).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(remoteHermesHubOwners.connectionId, connection));
    const candidate = await successor.prepareRecoveryOwnership(saved);
    expect(candidate).toMatchObject({ instanceId: successor.instanceId, leaseGeneration: Number(oldLease.generation) + 1, nativeFence: null });
    expect(await successor.socket.call('collective.hub_owner.current', { profile: 'default' })).toMatchObject({ native_generation: native.native_generation, portal_instance_id: oldHub.instanceId });
    expect((await metrics()).agent_turns).toBe(0);
  }, 15000);

  it('retains both profile bindings when one saved connection opens a second native profile', async () => {
    (await claimElsewhere('fixture-other')).close();
    const first = await openNativeSession(owner, connection, 'default'), hub = nativeHub(owner, connection);
    const before = await hub.socket.call('collective.hub_owner.current', { profile: 'default' });
    const second = await openNativeSession(owner, connection, 'fixture-other');
    expect(await hub.refresh(await row(first.id))).toMatchObject({ id: first.id, profile: 'default' });
    expect(await hub.refresh(await row(second.id))).toMatchObject({ id: second.id, profile: 'fixture-other' });
    expect(await hub.socket.call('collective.hub_owner.current', { profile: 'default' })).toMatchObject({ native_generation: before.native_generation, transport_bound: true });
    expect(await hub.socket.call('collective.hub_owner.current', { profile: 'fixture-other' })).toMatchObject({ transport_bound: true, native_generation: 2 });
    const snapshot = await hub.captureOwnership(await row(first.id));
    expect(snapshot.nativeFence!.nativeGeneration).toBe(1);
    expect((await lease()).nativeGeneration).toBe(2);
    await db.transaction(async tx => { await hub.lockBoundary(tx); await hub.assertCurrentOwnership(tx, snapshot); });
    expect((await metrics()).agent_turns).toBe(0);
  }, 15000);

  it('rejects a stale profile claim without borrowing another current profile on the same socket', async () => {
    await inspectNative(owner, connection, { profile: 'default', panel: 'projects' });
    await inspectNative(owner, connection, { profile: 'fixture-other', panel: 'projects' });
    const successor = await claimElsewhere('default');
    await expect(inspectNative(owner, connection, { profile: 'default', panel: 'projects' })).rejects.toMatchObject({ status: 502, code: 4091 });
    expect(await inspectNative(owner, connection, { profile: 'fixture-other', panel: 'projects' })).toHaveProperty('projects');
    await expect(successor.call('session.create', { profile: 'fixture-other' })).rejects.toMatchObject({ code: 4091 });
    expect((await metrics()).agent_turns).toBe(0);
  }, 15000);

  it.each(['projects', 'schedules', 'plugins'] as const)('prepares native ownership for cold profile-only %s inspection', async panel => {
    const result = await inspectNative(owner, connection, { profile: 'default', panel });
    expect(result).toHaveProperty(panel);
    expect(await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.connectionId, connection))).toHaveLength(0);
    expect(await nativeHub(owner, connection).socket.call('collective.hub_owner.current', { profile: 'default' })).toMatchObject({ phase: 'full', transport_bound: true });
    expect((await metrics()).agent_turns).toBe(0);
  }, 15000);
});
