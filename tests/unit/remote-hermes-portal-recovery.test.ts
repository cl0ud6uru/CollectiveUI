import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
const f = vi.hoisted(() => ({ client: null as PGlite | null, socketEpoch: 2, portalSocketEpoch: 5, nativeFence: true, nativeGeneration: 11, phase: 'none', recoveryId: '', failCompletionOnce: false, claimOverride: {} as Record<string, unknown>, completionOverride: {} as Record<string, unknown>, claims: vi.fn(), completions: vi.fn(), call: vi.fn(), invalidated: vi.fn(), prepareRefresh: vi.fn() }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'); const { drizzle } = await import('drizzle-orm/pglite');
  f.client = new PGlite(); return { db: drizzle(f.client) };
});
vi.mock('@/lib/remote-hermes/sessions', async () => ({ ownedNativeSession: async (owner: string, connection: string, session: string) => {
  const { db } = await import('@/db'); const { remoteHermesSessions, remoteHermesConnections } = await import('@/db/schema');
  const [row] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, session));
  const [c] = await db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, connection));
  if (!row || row.connectionId !== connection || c?.userId !== owner) throw new Error('not owned'); return row;
} }));
vi.mock('@/lib/remote-hermes/hub', async () => {
  const { db } = await import('@/db'); const { remoteHermesConnections } = await import('@/db/schema');
  const connection = async (q: typeof db) => (await q.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, 'connection')))[0];
  const snapshot = async (q = db) => {
    const row = (await q.execute(sql`SELECT * FROM remote_hermes_sessions WHERE id = 'session'`)).rows[0];
    return { protocol: 'collective.portal-hub-ownership.v1', ownerId: 'owner', connectionId: 'connection', instanceId: 'process', leaseGeneration: 3,
      sessionId: 'session', profile: row.profile, storedId: row.stored_id, runtimeId: row.runtime_id, sessionRevision: row.revision, ownershipGeneration: row.ownership_generation,
      socketEpoch: f.socketEpoch, portalSocketEpoch: f.portalSocketEpoch, nativeFence: f.phase !== 'none' ? { protocol: 'collective.native-hub-owner.v1', generation: 3, socketEpoch: f.portalSocketEpoch, nativeGeneration: f.nativeGeneration, phase: f.phase, recoveryId: f.recoveryId, recoverySessionId: 'runtime', recoveryStoredSessionId: 'stored' } : null };
  };
  const hub = {
    refresh: f.prepareRefresh, lockBoundary: connection,
    prepareRecoveryOwnership: async () => { if (!f.nativeFence) throw new Error('exclusive recovery ownership unavailable'); return snapshot(); },
    claimRecoveryOwnership: async (candidate: { sessionRevision: number }, recoveryId: string) => {
      const [intent] = (await db.execute(sql`SELECT state, confirmed_at FROM remote_hermes_recoveries WHERE id = ${recoveryId}`)).rows;
      expect(intent.state).toMatch(/pending|uncertain/); expect(intent.confirmed_at).not.toBeNull();
      if ((await snapshot()).sessionRevision !== candidate.sessionRevision) throw new Error('candidate changed');
      f.claims(); if (!f.nativeFence) throw new Error('native ownership unavailable');
      f.phase = 'recovery'; f.recoveryId = recoveryId; const value = await snapshot(); return { ...value, nativeFence: { ...value.nativeFence, ...f.claimOverride } };
    },
    completeRecoveryOwnership: async () => {
      const [intent] = (await db.execute(sql`SELECT receipt FROM remote_hermes_recoveries WHERE id = ${f.recoveryId}`)).rows;
      expect(intent.receipt).toMatchObject({ state: 'drained', reason: 'drained' });
      f.completions(); if (!f.nativeFence) throw new Error('native ownership unavailable');
      if (f.phase !== 'full') { f.phase = 'full'; f.nativeGeneration++; }
      if (f.failCompletionOnce) { f.failCompletionOnce = false; throw new Error('full claim reply lost'); }
      const value = await snapshot(); return { ...value, nativeFence: { ...value.nativeFence, ...f.completionOverride } };
    },
    assertCurrentOwnership: async (tx: typeof db, expected: unknown) => { const { nativeFence: _actual, ...actual } = await snapshot(tx); const { nativeFence: _expected, ...wanted } = expected as Awaited<ReturnType<typeof snapshot>>; void _actual; void _expected; if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error('ownership changed'); },
    assertNativeOwnership: async (expected: { nativeFence: unknown; socketEpoch: number }) => { if (!f.nativeFence || !expected.nativeFence || expected.socketEpoch !== f.socketEpoch || JSON.stringify(expected.nativeFence) !== JSON.stringify({ protocol: 'collective.native-hub-owner.v1', generation: 3, socketEpoch: f.portalSocketEpoch, nativeGeneration: f.nativeGeneration, phase: f.phase, recoveryId: f.recoveryId, recoverySessionId: 'runtime', recoveryStoredSessionId: 'stored' })) throw new Error('native owner changed'); },
    invalidateRecoveredSession: f.invalidated,
    sessions: new Map([['session', { row: { runtimeId: 'runtime' }, view: { nativeProfile: 'default', profile: 'default' }, socketEpoch: 2 }]]),
    socket: { state: 'connected', get connectionEpoch() { return f.socketEpoch; }, dispatchConnected: async (method: string, params: unknown) => ({ reply: f.call(method, params) }) },
  };
  return { nativeHub: () => hub };
});
import { db } from '@/db';
import { remoteHermesRecoveries, remoteRecoveryFenceActive } from '@/db/remote-hermes-recovery-schema';
import { nativeRecovery } from '@/lib/remote-hermes/recovery';
const read = async () => (await db.execute(sql`SELECT * FROM remote_hermes_sessions WHERE id = 'session'`)).rows[0];
let nativeBinding: Record<string, unknown>;
beforeAll(async () => {
  await f.client!.exec(`CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE remote_hermes_connections (id text PRIMARY KEY,user_id text,name text,base_url text,auth_mode text,secret_enc text,version text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE remote_hermes_sessions (id text PRIMARY KEY,connection_id text,profile text,stored_id text,runtime_id text,title text,status text,admission_at timestamptz,admission_request_id text,revision integer,ownership_generation bigint DEFAULT 0,queue_request_id text,queue_status text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE remote_hermes_turns (id text PRIMARY KEY,session_id text,request_id text,digest text,created_at timestamptz DEFAULT now());`);
  await f.client!.exec(readFileSync('src/db/migrations/0063_remote_hermes_recovery.sql', 'utf8').replaceAll('--> statement-breakpoint', ''));
});
beforeEach(async () => {
  await f.client!.exec(`TRUNCATE remote_hermes_recoveries, remote_hermes_turns, remote_hermes_sessions, remote_hermes_connections, users CASCADE;
    INSERT INTO users VALUES ('owner');
    INSERT INTO remote_hermes_connections(id,user_id,name,base_url,auth_mode,secret_enc) VALUES ('connection','owner','Synthetic','https://synthetic.invalid','sessionToken','ciphertext');
    INSERT INTO remote_hermes_sessions(id,connection_id,profile,stored_id,runtime_id,title,status,admission_request_id,revision,ownership_generation,queue_request_id,queue_status)
      VALUES ('session','connection','default','stored','runtime','Synthetic','uncertain','request-a',7,4,'request-q','uncertain');
    INSERT INTO remote_hermes_turns(id,session_id,request_id,digest) VALUES ('receipt','session','request-a','digest');`);
  vi.clearAllMocks(); f.prepareRefresh.mockReset(); f.socketEpoch = 2; f.portalSocketEpoch = 5; f.nativeFence = true; f.nativeGeneration = 11; f.phase = 'none'; f.recoveryId = ''; f.failCompletionOnce = false; f.claimOverride = {}; f.completionOverride = {}; nativeBinding = {};
  f.call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'collective.recovery.capabilities') return { protocol: 'collective.cancel-drain.v1', scope: 'inline_prompt_runtime', durable: true };
    if (method === 'collective.recovery.cancel_and_drain') nativeBinding = params;
    const { profile: _profile, ...binding } = nativeBinding; void _profile;
    return { ...binding, protocol: 'collective.cancel-drain.v1', state: 'drained', reason: 'drained' };
  });
});
afterAll(async () => { await f.client?.close(); });
const prepare = () => nativeRecovery('owner', 'connection', { operation: 'prepare', sessionId: 'session' });
const confirm = (intentId: string) => nativeRecovery('owner', 'connection', { operation: 'confirm', sessionId: 'session', intentId, confirmed: true });
const check = (intentId: string) => nativeRecovery('owner', 'connection', { operation: 'check', sessionId: 'session', intentId });
it('persists confirmation before cancel, releases both exact reservations only on drained proof, retains turn receipts', async () => {
  const intent = await prepare();
  expect(f.claims).not.toHaveBeenCalled(); expect(f.completions).not.toHaveBeenCalled();
  expect((await read()).status).toBe('uncertain'); expect(await remoteRecoveryFenceActive(db, 'session')).toBe(false);
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, params) => {
    if (method === 'collective.recovery.cancel_and_drain') {
      expect(await remoteRecoveryFenceActive(db, 'session')).toBe(true);
      expect((await db.select().from(remoteHermesRecoveries))[0].confirmedAt).not.toBeNull();
    }
    return original(method, params);
  });
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'applied' });
  expect(await read()).toMatchObject({ runtime_id: null, status: 'idle', revision: 8, ownership_generation: 5, admission_request_id: null, queue_request_id: null });
  expect((await db.execute(sql`SELECT * FROM remote_hermes_turns`)).rows).toHaveLength(1);
  expect(f.invalidated).toHaveBeenCalledOnce(); expect(await remoteRecoveryFenceActive(db, 'session')).toBe(false);
  await confirm(intent.intentId); expect(f.call.mock.calls.filter(([method]) => method === 'collective.recovery.cancel_and_drain')).toHaveLength(1);
});
it('lost cancellation reply reads same native identity and never submits cancellation or prompts again', async () => {
  const intent = await prepare(); const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, params) => { const receipt = await original(method, params); if (method === 'collective.recovery.cancel_and_drain') throw new Error('lost'); return receipt; });
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect((await read()).admission_request_id).toBe('request-a');
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'applied' });
  expect(f.call.mock.calls.filter(([method]) => method === 'collective.recovery.cancel_and_drain')).toHaveLength(1);
  expect(f.call.mock.calls.filter(([method]) => method === 'collective.recovery.status')).toEqual([['collective.recovery.status', { recovery_id: intent.intentId }]]);
});
it.each(['revision', 'ownership_generation', 'runtime_id', 'stored_id', 'profile', 'queue_request_id', 'admission_request_id'])('rejects changed %s before cancellation', async column => {
  const intent = await prepare(); const value = ['revision', 'ownership_generation'].includes(column) ? '99' : "'changed'";
  await f.client!.exec(`UPDATE remote_hermes_sessions SET ${column} = ${value}`);
  await expect(confirm(intent.intentId)).rejects.toThrow();
  expect(f.call.mock.calls.some(([method]) => method === 'collective.recovery.cancel_and_drain')).toBe(false);
  expect((await read()).status).toBe('uncertain');
});
it.each(['socket', 'portal socket', 'credential'])('rejects changed %s binding', async change => {
  const intent = await prepare(); if (change === 'socket') f.socketEpoch++; else if (change === 'portal socket') f.portalSocketEpoch++;
  else await f.client!.exec("UPDATE remote_hermes_connections SET secret_enc = 'replacement'");
  await expect(confirm(intent.intentId)).rejects.toThrow(); expect((await read()).admission_request_id).toBe('request-a');
});
it('fails closed without native ownership capability', async () => { f.nativeFence = false; await expect(prepare()).rejects.toThrow('exclusive recovery ownership'); expect(await db.select().from(remoteHermesRecoveries)).toHaveLength(0); });
it('requires owner and explicit confirmation and cannot check an unconfirmed intent', async () => {
  const intent = await prepare(); await expect(nativeRecovery('other', 'connection', { operation: 'prepare', sessionId: 'session' })).rejects.toThrow('not owned');
  await expect(nativeRecovery('owner', 'connection', { operation: 'confirm', sessionId: 'session', intentId: intent.intentId })).rejects.toThrow();
  await expect(check(intent.intentId)).rejects.toThrow('confirm recovery');
});
it('retains pending and mismatched receipt reservations and preserves a verified receipt when final CAS changes', async () => {
  const intent = await prepare(); const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, params) => {
    const result = await original(method, params); if (method === 'collective.recovery.cancel_and_drain') return { ...result, session_id: 'wrong' }; return result;
  });
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect((await read()).runtime_id).toBe('runtime');
  f.call.mockImplementation(async (method, params) => {
    const result = await original(method, params); if (method === 'collective.recovery.status') await f.client!.exec('UPDATE remote_hermes_sessions SET revision = 8'); return result;
  });
  expect(await check(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect((await db.select().from(remoteHermesRecoveries))[0].receipt).toMatchObject({ state: 'drained' });
  expect((await read()).runtime_id).toBe('runtime'); expect(f.invalidated).not.toHaveBeenCalled();
});
it('pending evidence cannot release and repeated prepare reuses the confirmed native fence', async () => {
  const intent = await prepare(); const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, params) => { const result = await original(method, params); return method === 'collective.recovery.capabilities' ? result : { ...result, state: 'pending', reason: 'workers_pending' }; });
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'pending' });
  f.prepareRefresh.mockRejectedValueOnce(new Error('must not resume a fenced runtime'));
  expect(await prepare()).toMatchObject({ intentId: intent.intentId, state: 'pending' });
  expect(f.prepareRefresh).not.toHaveBeenCalled();
  f.prepareRefresh.mockReset(); expect((await read()).status).toBe('uncertain');
});

it('expired prepared intent cannot cancel or release reservations', async () => {
  const intent = await prepare();
  await db.update(remoteHermesRecoveries).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(remoteHermesRecoveries.id, intent.intentId));
  await expect(confirm(intent.intentId)).rejects.toThrow('confirmation expired');
  expect(f.call.mock.calls.some(([method]) => method === 'collective.recovery.cancel_and_drain')).toBe(false);
  expect((await read()).admission_request_id).toBe('request-a');
});
it('overlapping confirmations send one cancellation and increment the released generation once', async () => {
  const intent = await prepare(); const original = f.call.getMockImplementation()!;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let admitted!: () => void; const acceptance = new Promise<void>(resolve => { admitted = resolve; });
  f.call.mockImplementation(async (method, params) => {
    const receipt = await original(method, params);
    if (method === 'collective.recovery.cancel_and_drain') { admitted(); await barrier; }
    return receipt;
  });
  const first = confirm(intent.intentId); await acceptance;
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'applied' });
  release(); expect(await first).toMatchObject({ state: 'applied' });
  expect(f.call.mock.calls.filter(([method]) => method === 'collective.recovery.cancel_and_drain')).toHaveLength(1);
  expect(await read()).toMatchObject({ revision: 8, ownership_generation: 5 });
});

it('lost full-claim reply resumes only the same terminal ownership transition before local release', async () => {
  const intent = await prepare(); f.failCompletionOnce = true;
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect(await read()).toMatchObject({ status: 'uncertain', admission_request_id: 'request-a' });
  expect((await db.select().from(remoteHermesRecoveries))[0].receipt).toMatchObject({ state: 'drained' });
  expect(await check(intent.intentId)).toMatchObject({ state: 'applied' });
  expect(f.claims).toHaveBeenCalledOnce(); expect(f.completions).toHaveBeenCalledTimes(2);
  expect(f.call.mock.calls.filter(([method]) => method === 'collective.recovery.cancel_and_drain')).toHaveLength(1);
  expect(await read()).toMatchObject({ ownership_generation: 5 });
});
it('changed claimed native generation cannot cancel, complete ownership or release', async () => {
  const intent = await prepare(); const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (method, params) => { const result = await original(method, params); return method === 'collective.recovery.capabilities' ? result : { ...result, state: 'pending', reason: 'workers_pending' }; });
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'pending' }); f.nativeGeneration++;
  expect(await check(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect(f.completions).not.toHaveBeenCalled(); expect((await read()).admission_request_id).toBe('request-a');
});

it('receipt persistence cannot update another session recovery with pending proof', async () => {
  const intent = await prepare();
  await f.client!.exec("INSERT INTO remote_hermes_sessions SELECT 'other',connection_id,profile,'other-stored','other-runtime',title,status,admission_at,admission_request_id,revision,ownership_generation,queue_request_id,queue_status,created_at,updated_at FROM remote_hermes_sessions WHERE id = 'session'");
  const [original] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.intentId));
  const foreignId = 'a2cfa48c-7cbf-4453-859d-7f1b0b81c425';
  const foreignReceipt = { protocol: 'collective.cancel-drain.v1' as const, recovery_id: foreignId, session_id: 'other-runtime', stored_session_id: 'other-stored', reservation_ids: ['other-request'], state: 'pending' as const, reason: 'workers_pending' as const };
  await db.insert(remoteHermesRecoveries).values({ ...original, id: foreignId, sessionId: 'other', receipt: foreignReceipt, state: 'pending', confirmedAt: new Date() });
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'applied' });
  expect((await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, foreignId)))[0].receipt).toEqual(foreignReceipt);
});
it('database refuses applied state without terminal receipt and full ownership proof', async () => {
  const intent = await prepare();
  await expect(db.update(remoteHermesRecoveries).set({ state: 'applied' }).where(eq(remoteHermesRecoveries.id, intent.intentId))).rejects.toMatchObject({ cause: { constraint: 'remote_hermes_recovery_terminal_check' } });
  expect((await read()).status).toBe('uncertain');
});

it.each([
  { phase: 'full' }, { recoveryId: '731f96d8-1350-4b70-9f76-e6e4e55c101a' }, { recoverySessionId: 'wrong' },
  { recoveryStoredSessionId: 'wrong' }, { generation: 99 }, { socketEpoch: 99 }, { nativeGeneration: 0 },
])('rejects incomplete/foreign recovery-only claim proof %j before cancel', async proof => {
  const intent = await prepare(); f.claimOverride = proof;
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect(f.call.mock.calls.some(([method]) => method === 'collective.recovery.cancel_and_drain')).toBe(false);
  expect(f.completions).not.toHaveBeenCalled(); expect((await read()).runtime_id).toBe('runtime');
});
it.each([{ phase: 'recovery' }, { nativeGeneration: 13 }, { recoverySessionId: 'wrong' }])('retains terminal receipt but rejects foreign/nonadjacent full claim proof %j', async proof => {
  const intent = await prepare(); f.completionOverride = proof;
  expect(await confirm(intent.intentId)).toMatchObject({ state: 'uncertain' });
  expect((await db.select().from(remoteHermesRecoveries))[0].receipt).toMatchObject({ state: 'drained' });
  expect((await read()).runtime_id).toBe('runtime'); expect(f.invalidated).not.toHaveBeenCalled();
});
