import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { remoteHermesRecoveries } from '@/db/remote-hermes-recovery-schema';
import { encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { DashboardClient, type DashboardSecrets } from '@/lib/remote-hermes/client';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';
import { assertDisposableHermesDatabase } from '../fixtures/remote-hermes-disposable-database';
const f = vi.hoisted(() => ({ base: '' }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [f.base] }) }));
const enabled = process.env.REMOTE_HERMES_PORTAL_RECOVERY_CONFORMANCE === '1';
const owner = newId(), connection = newId();
let db: typeof import('@/db').db, pool: typeof import('@/db').pool;
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
    ({ nativeHub } = await import('@/lib/remote-hermes/hub'));
    ({ openNativeSession, nativeHistory, submitNativePrompt } = await import('@/lib/remote-hermes/sessions'));
    ({ nativeRecovery } = await import('@/lib/remote-hermes/recovery'));
    fixture = await startPinnedDashboard({ recoveryAdapters: true }); f.base = fixture.base;
    secrets = await new DashboardClient(f.base, fetch).passwordLogin('synthetic', 'synthetic-password');
    await db.insert(users).values({ id: owner, upn: `recovery-conformance-${owner}`, name: 'Synthetic fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic recovery dashboard', baseUrl: f.base, authMode: 'password',
      secretEnc: encrypt(JSON.stringify(secrets), remoteConnectionAAD(connection, owner)) });
  }, 45000);
  afterAll(async () => {
    if (f.base) nativeHub(owner, connection).close();
    if (f.base) await db.delete(users).where(eq(users.id, owner));
    await fixture?.stop(); await pool?.end();
  });
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
    await expect(nativeHub(owner, connection).socket.call('session.create', { profile: 'default' })).rejects.toThrow();
    expect((await fetch(f.base + '/api/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ release_recovery_worker: true }) })).ok).toBe(true);
    await vi.waitFor(async () => {
      intent = await nativeRecovery(owner, connection, { operation: 'check', sessionId: session.id, intentId: intent.intentId });
      expect(intent.state).toBe('applied');
    }, { timeout: 10_000 });
    const [finished] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.intentId));
    expect(finished.receipt).toMatchObject({ state: 'drained', reason: 'drained', reservation_ids: [requestId] });
    expect(finished.completedOwnership?.nativeFence?.phase).toBe('full');
    expect(finished.completedOwnership?.nativeFence?.nativeGeneration).toBe(finished.claimedOwnership!.nativeFence!.nativeGeneration + 1);
    expect(await submitNativePrompt(owner, connection, session.id, requestId, text)).toEqual({ accepted: true, duplicate: true });
    expect((await nativeHistory(owner, connection, session.id, 0)).messages.some(message => message.text.includes(text))).toBe(true);
    expect((await metrics()).external_attempts).toBe(0);
  }, 45000);
});
