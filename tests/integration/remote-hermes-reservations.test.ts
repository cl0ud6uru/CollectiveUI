import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
const f = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: vi.fn() }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardAddress: async () => ({ address: '93.184.216.34', family: 4 }) }));
vi.mock('@/lib/remote-hermes/socket', async original => {
  const actual = await original<typeof import('@/lib/remote-hermes/socket')>();
  return { ...actual, DashboardSocket: class { state = 'connected'; call = f.call; callWithEpoch = async (...args: unknown[]) => ({ result: await f.call(...args), epoch: 1 }); close() {} } };
});
import { db, pool } from '@/db';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { newId } from '@/lib/ids';
import { nativeHub } from '@/lib/remote-hermes/hub';
import { nativeControl, nativeSnapshot } from '@/lib/remote-hermes/sessions';
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const enabled = process.env.REMOTE_HERMES_INTEGRATION === '1' && url?.pathname === '/hermes_fixture';
const id1 = '9fd64d53-084f-4898-96e0-59ea8fdc623f', id2 = 'af63e18c-0581-44c5-8654-8f226b2660a8';
const idle = { session_id: 'runtime', stored_session_id: 'stored', running: false, info: { title: 'Synthetic' }, messages: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let owner: string, connection: string, session: string;
const row = async () => (await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, session)))[0];
describe.skipIf(!enabled)('native Hermes reservations with real PostgreSQL locks', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); owner = newId(); connection = newId(); session = newId();
    await db.insert(users).values({ id: owner, upn: `fixture-${owner}`, name: 'Synthetic fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Fixture', baseUrl: `https://${connection}.example.com`, authMode: 'sessionToken', secretEnc: 'synthetic' });
    await db.insert(remoteHermesSessions).values({ id: session, connectionId: connection, profile: 'default', storedId: 'stored', status: 'running' });
    f.call.mockImplementation(async (method: string) => method === 'session.resume' ? { ...idle, running: true } : { status: 'queued' });
  });
  afterEach(async () => { nativeHub(owner, connection).close(); await db.delete(users).where(eq(users.id, owner)); });
  afterAll(async () => { await pool.end(); });
  it('initializes reservation columns and rejects inconsistent queue states', async () => {
    expect(await row()).toMatchObject({ revision: 0, admissionRequestId: null, queueRequestId: null, queueStatus: null });
    await expect(db.update(remoteHermesSessions).set({ queueStatus: 'queued' }).where(eq(remoteHermesSessions.id, session))).rejects.toThrow();
    await expect(db.update(remoteHermesSessions).set({ queueRequestId: id1 }).where(eq(remoteHermesSessions.id, session))).rejects.toThrow();
  });
  it('dispatches only one of two queue requests whose acknowledgements are withheld', async () => {
    const ack = deferred<unknown>(); f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve({ ...idle, running: true }) : ack.promise);
    const attempt = (id: string, text: string) => nativeControl(owner, connection, session, 'queue', { requestId: id, text })
      .then(() => ({ id, error: null }), error => ({ id, error: error as { status: number } }));
    const first = attempt(id1, 'Queue A'), second = attempt(id2, 'Queue B');
    try {
      await vi.waitFor(() => expect(f.call.mock.calls.filter(c => c[0] === 'prompt.submit')).toHaveLength(1));
      // Either transaction can acquire the row lock first; the loser must finish before the winner's acknowledgement.
      let observed: Awaited<typeof first> | undefined;
      const outcome = Promise.race([first, second]).then(result => { observed = result; return result; });
      await vi.waitFor(() => expect(observed?.error?.status).toBe(409));
      const loser = await outcome;
      expect(loser.error?.status).toBe(409);
      const reserved = await row();
      expect(reserved).toMatchObject({ queueRequestId: loser.id === id1 ? id2 : id1, queueStatus: 'admitting' });
      const submitted = f.call.mock.calls.find(c => c[0] === 'prompt.submit');
      expect(submitted?.[1].text).toBe(reserved.queueRequestId === id1 ? 'Queue A' : 'Queue B');
      expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, session))).toHaveLength(1);
    } finally {
      ack.resolve({ status: 'queued' });
      await Promise.all([first, second]);
    }
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.error === null)).toHaveLength(1);
    expect(results.filter(result => result.error?.status === 409)).toHaveLength(1);
    expect((await row()).queueStatus).toBe('queued');
  });
  it('preserves a newer process admission when an older idle snapshot completes', async () => {
    await db.update(remoteHermesSessions).set({ status: 'idle' }).where(eq(remoteHermesSessions.id, session));
    f.call.mockResolvedValue(idle); const hub = nativeHub(owner, connection); await hub.refresh(await row());
    const snapshot = deferred<unknown>(); f.call.mockReturnValueOnce(snapshot.promise);
    const refresh = hub.refresh(await row()); await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(2));
    await db.update(remoteHermesSessions).set({ status: 'admitting', admissionRequestId: id1, revision: sql`${remoteHermesSessions.revision} + 1` }).where(eq(remoteHermesSessions.id, session));
    snapshot.resolve(idle); expect((await refresh).uncertain).toBe(true);
    expect(await row()).toMatchObject({ status: 'admitting', admissionRequestId: id1 });
  });
  it('retains unknown queue outcomes after the hub cache is discarded', async () => {
    f.call.mockImplementation(async (method: string) => { if (method === 'session.resume') return { ...idle, running: true }; throw new Error('Synthetic lost acknowledgement'); });
    await expect(nativeControl(owner, connection, session, 'queue', { requestId: id1, text: 'Queue A' })).rejects.toThrow('lost acknowledgement');
    nativeHub(owner, connection).close(); f.call.mockResolvedValue(idle);
    expect(await nativeSnapshot(owner, connection, session)).toMatchObject({ uncertain: true, queuePending: true });
    await expect(nativeControl(owner, connection, session, 'queue', { requestId: id2, text: 'Queue B' })).rejects.toThrow('unfinished');
    expect(f.call.mock.calls.filter(c => c[0] === 'prompt.submit')).toHaveLength(1);
  });
  it('ignores a late queue acknowledgement after native recovery admits a different queue', async () => {
    const ackA = deferred<unknown>(), ackB = deferred<unknown>(); let count = 0;
    f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve({ ...idle, running: true }) : ++count === 1 ? ackA.promise : ackB.promise);
    const a = nativeControl(owner, connection, session, 'queue', { requestId: id1, text: 'Queue A' });
    await vi.waitFor(() => expect(count).toBe(1)); const hub = nativeHub(owner, connection);
    f.call.mockImplementation(async () => ({ ...idle, running: true, queued: { user: 'Queue A' } })); await hub.refresh(await row());
    f.call.mockImplementation((method: string) => method === 'session.resume' ? Promise.resolve({ ...idle, running: true }) : ackB.promise);
    await hub.refresh(await row());
    const b = nativeControl(owner, connection, session, 'queue', { requestId: id2, text: 'Queue B' });
    await vi.waitFor(async () => expect((await row()).queueRequestId).toBe(id2));
    ackA.resolve({ status: 'queued' }); await a;
    expect(await row()).toMatchObject({ queueRequestId: id2, queueStatus: 'admitting' });
    expect(hub.sessions.get(session)!.view.queued).not.toBe('Queue A');
    ackB.resolve({ status: 'queued' }); await b; expect(hub.sessions.get(session)!.view.queued).toBe('Queue B');
  });
});
