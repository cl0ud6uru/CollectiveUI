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
    // A terminal snapshot precedes thread cleanup. Require actual real-work
    // quiescence while preserving the live idle poller and native runtime.
    await vi.waitFor(async () => {
      const work = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
        headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_real_work: true }) });
      expect(await work.json()).toEqual({ default: false });
    }, { timeout: 10_000 });
    const saved = await row(session.id), oldLease = await lease();
    const native = await oldHub.socket.call('collective.hub_owner.current', { profile: 'default' });
    // Preserve the ordinary retained runtime and its live housekeeping poller.
    // Explicit session.close would hide a poller lifetime being mistaken for active work.
    const pollers = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
      headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_pollers: true }) });
    expect(await pollers.json()).toMatchObject({ default: { alive: 1 } });
    expect((await fetch(f.base + '/api/__fixture/control', { method: 'POST',
      headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_poller_claim: saved.runtimeId }) })).ok).toBe(true);
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
    expect((await row(saved.id)).runtimeId).toBe(saved.runtimeId);
    await vi.waitFor(async () => {
      const resumedPollers = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
        headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_pollers: true }) });
      expect(await resumedPollers.json()).toMatchObject({ default: { count: 1, alive: 1, stopped: 0, all_alive: 1 } });
    }, { timeout: 10_000 });
    const staleDrain = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
      headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe_stale_poller_drain: true }) });
    expect(await staleDrain.json()).toEqual({ consumed: 0, retained: 1 });
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

  it('reattaches an ordinary idle runtime after socket replacement without replaying its completed turn', async () => {
    const session = await openNativeSession(owner, connection, 'default'), hub = nativeHub(owner, connection);
    await submitNativePrompt(owner, connection, session.id, randomUUID(), 'fixture-idle-reconnect');
    await vi.waitFor(async () => expect((await hub.refresh(await row(session.id))).running).toBe(false), { timeout: 10_000 });
    const saved = await row(session.id), epoch = hub.socket.connectionEpoch;
    const headers = { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' };
    expect((await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ disconnect: true }) })).ok).toBe(true);
    await vi.waitFor(() => expect(hub.socket.state).toBe('reconnecting'));
    await hub.socket.connect();
    expect(hub.socket.connectionEpoch).toBeGreaterThan(epoch);
    // A terminal snapshot may precede the original worker's final cleanup. Keep
    // its active-work refusal, and retry only this read until that worker exits.
    await vi.waitFor(async () => {
      expect(await hub.refresh(await row(session.id))).toMatchObject({ id: saved.id, running: false });
    }, { timeout: 10_000 });
    expect((await row(saved.id)).runtimeId).toBe(saved.runtimeId);
    expect(await metrics()).toMatchObject({ agent_turns: 1, external_attempts: 0 });
  }, 30000);

  it('continues to reject a different full owner while a real native turn remains active', async () => {
    const session = await openNativeSession(owner, connection, 'default'), hub = nativeHub(owner, connection);
    const current = await hub.socket.call('collective.hub_owner.current', { profile: 'default' });
    await submitNativePrompt(owner, connection, session.id, randomUUID(), 'fixture-drain-hold');
    try {
      await vi.waitFor(async () => expect((await metrics()).agent_turns).toBe(1), { timeout: 10_000 });
      await expect(claimElsewhere('default')).rejects.toMatchObject({ code: 4091 });
      expect(await hub.socket.call('collective.hub_owner.current', { profile: 'default' })).toMatchObject({
        native_generation: current.native_generation, portal_instance_id: hub.instanceId, phase: 'full',
      });
    } finally {
      await fetch(f.base + '/api/__fixture/control', { method: 'POST',
        headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ release_recovery_worker: true }) });
    }
  }, 30000);

  it('keeps an accepted auxiliary worker fenced before its target wins the profile lock', async () => {
    const session = await openNativeSession(owner, connection, 'default');
    const saved = await row(session.id);
    const response = await fetch(f.base + '/api/__fixture/control', { method: 'POST',
      headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe_pending_auxiliary_claim: saved.runtimeId }) });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ claim_rejected: true, generation_unchanged: true, worker_executed: true });
    expect(await metrics()).toMatchObject({ agent_turns: 0, external_attempts: 0 });
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
