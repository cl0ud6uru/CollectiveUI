import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { remoteHermesRecoveries } from '@/db/remote-hermes-recovery-schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import type { DashboardSecrets } from '@/lib/remote-hermes/client';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';
import { assertDisposableHermesDatabase } from '../fixtures/remote-hermes-disposable-database';
const f = vi.hoisted(() => ({ base: '' }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));
const enabled = process.env.REMOTE_HERMES_PORTAL_RECOVERY_CONFORMANCE === '1';
let owner = '', connection = '';
const extraConnections = new Map<string, string>();
let db: typeof import('@/db').db, pool: typeof import('@/db').pool;
let DashboardClient: typeof import('@/lib/remote-hermes/client').DashboardClient;
let DashboardSocket: typeof import('@/lib/remote-hermes/socket').DashboardSocket;
let nativeHub: typeof import('@/lib/remote-hermes/hub').nativeHub;
let openNativeSession: typeof import('@/lib/remote-hermes/sessions').openNativeSession;
let nativeHistory: typeof import('@/lib/remote-hermes/sessions').nativeHistory;
let submitNativePrompt: typeof import('@/lib/remote-hermes/sessions').submitNativePrompt;
let nativeRecovery: typeof import('@/lib/remote-hermes/recovery').nativeRecovery;
let fixture: Awaited<ReturnType<typeof startPinnedDashboard>>, secrets: DashboardSecrets;
const row = async (id: string) => (await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, id)))[0];
async function metrics() {
  return (await fetch(f.base + '/api/__fixture/metrics', { headers: { Authorization: `Bearer ${secrets.accessToken}` } })).json();
}
describe.skipIf(!enabled)('exact-pin composed ownership/drain adapters and production portal recovery', () => {
  beforeAll(async () => {
    // Reject driver overrides BEFORE any module that constructs a PostgreSQL pool is imported.
    assertDisposableHermesDatabase(process.env.DATABASE_URL);
    ({ db, pool } = await import('@/db'));
    ({ DashboardClient } = await import('@/lib/remote-hermes/client'));
    ({ DashboardSocket } = await import('@/lib/remote-hermes/socket'));
    ({ nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ openNativeSession, nativeHistory, submitNativePrompt } = await import('@/lib/remote-hermes/sessions'));
    ({ nativeRecovery } = await import('@/lib/remote-hermes/recovery'));
  });
  beforeEach(async () => {
    owner = newId(); connection = newId();
    fixture = await startPinnedDashboard({ recoveryAdapters: true }); f.base = fixture.base;
    secrets = await new DashboardClient(f.base, fetch).passwordLogin('synthetic', 'synthetic-password');
    await db.insert(users).values({ id: owner, upn: `recovery-conformance-${owner}`, name: 'Synthetic fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic recovery dashboard', baseUrl: f.base, authMode: 'password',
      secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(connection, owner)) });
  }, 45000);
  afterEach(async () => {
    if (f.base) nativeHub(owner, connection).close();
    for (const [id, otherOwner] of extraConnections) { nativeHub(otherOwner, id).close(); await db.delete(users).where(eq(users.id, otherOwner)); }
    extraConnections.clear();
    if (f.base) await db.delete(users).where(eq(users.id, owner));
    await fixture?.stop(); f.base = '';
  });
  afterAll(async () => { await pool?.end(); });
  it('recovers actual accepted/completed work after a lost acknowledgement using terminal proof, retains history and never replays the old turn', async () => {
    const session = await openNativeSession(owner, connection, 'default');
    const requestId = randomUUID(), text = 'fixture-recovery-original', before = (await metrics()).agent_turns;
    const control = await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ drop_next_ack: true }) });
    expect(control.ok).toBe(true);
    await expect(submitNativePrompt(owner, connection, session.id, requestId, text)).rejects.toThrow('may have been accepted');
    await vi.waitFor(async () => expect((await nativeHistory(owner, connection, session.id, 0)).messages.some(message => message.role === 'assistant')).toBe(true), { timeout: 10_000 });
    expect((await row(session.id)).admissionRequestId).toBe(requestId);
    const old = await row(session.id);
    let intent = await nativeRecovery(owner, connection, { operation: 'prepare', sessionId: session.id });
    expect(intent.state).toBe('prepared');
    // Preparation must retain the unknown reservation; only explicit confirmation cancels it.
    expect((await row(session.id)).admissionRequestId).toBe(requestId);
    intent = await nativeRecovery(owner, connection, { operation: 'confirm', sessionId: session.id, intentId: intent.intentId, confirmed: true });
    await vi.waitFor(async () => {
      if (intent.state !== 'applied') intent = await nativeRecovery(owner, connection, { operation: 'check', sessionId: session.id, intentId: intent.intentId });
      expect(intent.state).toBe('applied');
    }, { timeout: 10_000 });
    const recovered = await row(session.id);
    expect(recovered).toMatchObject({ status: 'idle', runtimeId: null, admissionRequestId: null, queueRequestId: null });
    const generation = (await db.execute(sql`SELECT ownership_generation FROM remote_hermes_sessions WHERE id = ${session.id}`)).rows[0];
    expect(Number(generation.ownership_generation)).toBeGreaterThan(0);
    const [proof] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.intentId));
    expect(proof.receipt).toMatchObject({ protocol: 'collective.cancel-drain.v1', state: 'drained', reason: 'drained', session_id: proof.binding.ownership.runtimeId,
      stored_session_id: old.storedId, reservation_ids: [requestId] });
    expect(proof.claimedOwnership?.nativeFence?.nativeGeneration).toBeGreaterThan(0);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, session.id))).toHaveLength(1);
    expect(await submitNativePrompt(owner, connection, session.id, requestId, text)).toEqual({ accepted: true, duplicate: true });
    expect((await metrics()).agent_turns).toBe(before + 1);
    expect((await nativeHistory(owner, connection, session.id, 0)).messages.some(message => message.text.includes(text))).toBe(true);
    await submitNativePrompt(owner, connection, session.id, randomUUID(), 'fixture-recovery-new-turn');
    await vi.waitFor(async () => expect((await metrics()).agent_turns).toBe(before + 2), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await nativeHub(owner, connection).refresh(await row(session.id))).running).toBe(false), { timeout: 10_000 });
    expect((await metrics()).external_attempts).toBe(0);
  }, 45000);
  it('fences old admissions while an interrupt-ignoring worker remains live, then promotes ownership only after its exact drain', async () => {
    const session = await openNativeSession(owner, connection, 'default'), requestId = randomUUID(), text = 'fixture-drain-hold';
    const headers = { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' };
    // Real idle session pollers must exit for the fenced profile, without stopping another profile.
    const idle = await openNativeSession(owner, connection, 'default');
    const otherConnection = newId(), otherOwner = newId(); extraConnections.set(otherConnection, otherOwner);
    await db.insert(users).values({ id: otherOwner, upn: `recovery-conformance-${otherOwner}`, name: 'Other synthetic fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: otherConnection, userId: otherOwner, name: 'Other synthetic profile', baseUrl: f.base, authMode: 'password',
      secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(otherConnection, otherOwner)) });
    try { await openNativeSession(otherOwner, otherConnection, 'fixture-other'); } catch (error) { throw new Error(`Other native profile setup failed (${(error as { code?: number }).code ?? 'local'}).`); }
    const pollers = async () => (await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ profile_pollers: true }) })).json();
    await vi.waitFor(async () => {
      const state = await pollers(); expect(state.default.alive).toBeGreaterThanOrEqual(2); expect(state['fixture-other'].alive).toBe(1);
    }, { timeout: 10_000 });
    expect((await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ drop_next_ack: true }) })).ok).toBe(true);
    await expect(submitNativePrompt(owner, connection, session.id, requestId, text)).rejects.toThrow('may have been accepted');
    let intent = await nativeRecovery(owner, connection, { operation: 'prepare', sessionId: session.id });
    expect(intent.state).toBe('prepared');
    intent = await nativeRecovery(owner, connection, { operation: 'confirm', sessionId: session.id, intentId: intent.intentId, confirmed: true });
    expect(intent.state).toBe('pending');
    expect((await row(session.id)).admissionRequestId).toBe(requestId);
    const [pending] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.intentId));
    expect(pending.claimedOwnership?.nativeFence?.phase).toBe('recovery'); expect(pending.completedOwnership).toBeNull();
    expect(pending.receipt).toMatchObject({ state: 'pending', reason: 'workers_pending' });
    const aliasAuth = new DashboardClient(f.base, fetch, secrets);
    const alias = new DashboardSocket(async () => ({ url: new URL(`${f.base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await aliasAuth.websocketTicket())}`), options: {} }), () => {});
    try {
      await alias.connect();
      const aliasOwner = await alias.call('collective.hub_owner.current', { profile: 'Default' });
      expect(aliasOwner).toMatchObject({ native_generation: pending.claimedOwnership!.nativeFence!.nativeGeneration, phase: 'recovery', recovery_id: intent.intentId });
      await expect(alias.call('collective.hub_owner.claim', { profile: 'Default', portal_connection_id: newId(), portal_instance_id: randomUUID(), portal_generation: 1,
        portal_socket_epoch: 1, expected_native_generation: aliasOwner.native_generation, phase: 'full' })).rejects.toThrow();
      await expect(alias.call('config.set', { profile: 'Default', session_id: pending.binding.ownership.runtimeId, key: 'model', value: 'synthetic-alias-rejected' })).rejects.toThrow();
    } finally { alias.close(); }

    const delayedWorker = async () => (await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ probe_recovery_worker: true }) })).json();
    expect(await delayedWorker()).toEqual({ target_called: false, auxiliary_called: false, auxiliary_tracked: false });
    await vi.waitFor(async () => {
      const state = await pollers(); expect(state.default.alive).toBe(0); expect(state.default.stopped).toBeGreaterThanOrEqual(2);
      expect(state['fixture-other']).toMatchObject({ count: 1, stopped: 0, alive: 1 });
    }, { timeout: 10_000 });
    await expect(nativeHub(owner, connection).socket.call('session.create', { profile: 'default' })).rejects.toThrow();
    expect((await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ release_recovery_worker: true }) })).ok).toBe(true);
    await vi.waitFor(async () => {
      intent = await nativeRecovery(owner, connection, { operation: 'check', sessionId: session.id, intentId: intent.intentId });
      expect(intent.state).toBe('applied');
    }, { timeout: 10_000 });
    const [finished] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.intentId));
    expect(finished.receipt).toMatchObject({ state: 'drained', reason: 'drained', reservation_ids: [requestId] });
    expect(finished.completedOwnership?.nativeFence?.phase).toBe('full');
    expect(await delayedWorker()).toEqual({ target_called: true, auxiliary_called: false, auxiliary_tracked: false }); // Unscoped HTTP never gains the owner's RPC context.
    expect(await nativeHub(owner, connection).socket.call('fixture.owner_auxiliary', { profile: 'default', session_id: (await row(idle.id)).runtimeId })).toEqual({ scheduled: true });
    await vi.waitFor(async () => expect(await metrics()).toMatchObject({ auxiliary_calls: 1, auxiliary_tracked: 1 }), { timeout: 5000 });
    expect(finished.completedOwnership?.nativeFence?.nativeGeneration).toBe(finished.claimedOwnership!.nativeFence!.nativeGeneration + 1);
    expect(await submitNativePrompt(owner, connection, session.id, requestId, text)).toEqual({ accepted: true, duplicate: true });
    expect((await nativeHistory(owner, connection, session.id, 0)).messages.some(message => message.text.includes(text))).toBe(true);
    expect((await metrics()).external_attempts).toBe(0);
  }, 45000);
  it('rejects unclaimed WebSocket and stdio dispatch/answers while the full owner alone resolves its native protected request', async () => {
    const session = await openNativeSession(owner, connection, 'default'), hub = nativeHub(owner, connection);
    const auth = new DashboardClient(f.base, fetch, secrets);
    const unclaimed = new DashboardSocket(async () => ({ url: new URL(`${f.base.replace('http:', 'ws:')}/api/ws?ticket=${encodeURIComponent(await auth.websocketTicket())}`), options: {} }), () => {});
    try {
      await unclaimed.connect();
      await expect(unclaimed.call('session.create', { profile: 'default' })).rejects.toThrow();
      await submitNativePrompt(owner, connection, session.id, randomUUID(), 'fixture-protected');
      await vi.waitFor(() => expect(hub.sessions.get(session.id)?.pending.size).toBe(1), { timeout: 10_000 });
      const pending = [...hub.sessions.get(session.id)!.pending.values()][0];
      await unclaimed.answer(pending.nativeId, { value: 'synthetic-unclaimed-rejected' });
      await unclaimed.call('ping'); // FIFO barrier after the unclaimed response frame.
      await expect(unclaimed.call('request.answer', { id: String(pending.nativeId), result: { value: 'synthetic-unclaimed-rejected' } })).rejects.toThrow();
      const probe = await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ probe_unowned_stdio: true, request_id: String(pending.nativeId) }) });
      expect(await probe.json()).toEqual({ create_rejected: true, answer_rejected: true, response_resolved: false, orphan_response_resolved: false });
      expect((await metrics()).protected_answers).toBe(0);
      await expect(hub.socket.call('request.answer', { id: 'srq-synthetic-missing', result: { value: 'synthetic-missing-rejected' } })).rejects.toThrow();
      expect(await hub.socket.call('request.answer', { id: String(pending.nativeId), result: { value: 'synthetic-owner-only' }, profile: 'default' })).toMatchObject({ status: 'ok' });
      await vi.waitFor(async () => expect((await metrics()).protected_answers).toBe(1), { timeout: 10_000 });
      await expect(hub.socket.call('request.answer', { id: String(pending.nativeId), result: { value: 'synthetic-stale-rejected' } })).rejects.toThrow();
      expect((await metrics()).protected_answers).toBe(1);
      const history = JSON.stringify(await nativeHistory(owner, connection, session.id, 0));
      expect(history).not.toContain('synthetic-unclaimed-rejected'); expect(history).not.toContain('synthetic-stdio-rejected'); expect(history).not.toContain('synthetic-owner-only');
    } finally { unclaimed.close(); }
  }, 45000);
});
