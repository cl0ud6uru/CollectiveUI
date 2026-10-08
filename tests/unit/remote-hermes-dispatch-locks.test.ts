import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import type { DB } from '@/db';
import * as schema from '@/db/schema';
import { remoteHermesSessions, settings } from '@/db/schema';

// Opt-in ONLY to the named disposable database; never fall back to DATABASE_URL.
const url = process.env.REMOTE_HERMES_LOCK_TEST_URL;
const run = url ? it : it.skip;
const f = vi.hoisted(() => ({ db: null as unknown as DB, pausePolicy: undefined as (() => Promise<void>) | undefined }));
vi.mock('@/db', () => ({ get db() { return f.db; } }));
vi.mock('@/lib/settings', async original => {
  const actual = await original<typeof import('@/lib/settings')>();
  return { ...actual, getSetting: async (...args: Parameters<typeof actual.getSetting>) => {
    const pause = f.pausePolicy; f.pausePolicy = undefined;
    const policy = await actual.getSetting(...args);
    await pause?.();
    return policy;
  } };
});
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardFetch: () => vi.fn(), dashboardAddress: async () => ({ address: '127.0.0.1', family: 4 }) }));
vi.mock('@/lib/remote-hermes/client', async original => {
  const actual = await original<typeof import('@/lib/remote-hermes/client')>();
  return { ...actual, DashboardClient: class { status = async () => ({ version: 'fixture' }); profiles = async () => [{ name: 'default' }]; } };
});
// Simulate replacement in another application process: its post-commit local
// invalidator cannot see/close the reader's socket or erase its warm cache.
vi.mock('@/lib/remote-hermes/lifecycle', () => ({ registerNativeConnection: () => () => {}, retireNativeConnection: () => {} }));
import { connectRemoteHermes } from '@/lib/remote-hermes/store';
import { NativeHub } from '@/lib/remote-hermes/hub';
import { sessionView } from '@/lib/remote-hermes/view';
import { setSetting } from '@/lib/settings';

let pool: Pool;
const cleanup: (() => void)[] = [];
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
beforeAll(async () => {
  if (!url) return;
  const target = new URL(url);
  if (target.pathname !== '/collective_remote_lifecycle_test' || !['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('Named disposable loopback PostgreSQL fixture required');
  pool = new Pool({ connectionString: url, max: 4 }); f.db = drizzle(pool, { schema });
  await pool.query('DROP TABLE IF EXISTS remote_hermes_turns, remote_hermes_sessions, remote_hermes_connections, settings, users CASCADE');
  await pool.query("CREATE TABLE users (id text PRIMARY KEY); CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO users VALUES ('owner');");
  for (const tag of ['0030_remote_hermes_connections', '0031_remote_hermes_sessions', '0032_remote_hermes_reservations']) await pool.query(readFileSync(`src/db/migrations/${tag}.sql`, 'utf8'));
});
beforeEach(async () => { if (url) { f.pausePolicy = undefined; await pool.query('TRUNCATE remote_hermes_connections CASCADE; TRUNCATE settings'); } });
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));
afterAll(async () => { await pool?.end(); });
async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => { server.clients.forEach(ws => ws.terminate()); server.close(); });
  const address = server.address(); if (!address || typeof address !== 'object') throw new Error('Missing fixture address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await setSetting('remoteHermes', { enabled: true, privateGateways: [baseUrl] });
  const input = { name: 'Account A', baseUrl, mode: 'sessionToken' as const, sessionToken: 'synthetic-a' };
  const { connection } = await connectRemoteHermes('owner', input);
  const [row] = await f.db.insert(remoteHermesSessions).values({ id: 'local', connectionId: connection.id, profile: 'default', storedId: 'stored', runtimeId: 'runtime', status: 'running' }).returning();
  const received: string[] = [];
  server.on('connection', ws => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }));
    ws.on('message', raw => {
      const frame = JSON.parse(String(raw)); received.push(frame.method);
      // New work's acknowledgement is intentionally withheld.
      if (frame.method !== 'projects.list') ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { server_requests: ['approval'] } }));
    });
  });
  const hub = new NativeHub('owner', connection.id); cleanup.push(() => hub.close());
  hub.sessions.set(row.id, { row, view: sessionView(row.id, row.profile, { session_id: 'runtime', running: true }, 'connected'), pending: new Map(), refreshedAt: Date.now(), eventRevision: 0, socketEpoch: 1 });
  await hub.socket.connect();
  return { hub, row, input, baseUrl, received };
}
run.each(['dispatch', 'cached view'] as const)('PostgreSQL fences replacement during policy await before %s linearizes', async operation => {
  const { hub, row, input, received } = await fixture();
  const entered = gate(); const resume = gate();
  f.pausePolicy = async () => { entered.release(); await resume.promise; };
  const pending = operation === 'dispatch' ? hub.socket.call('projects.list', { profile: 'default' }) : hub.view(row);
  const outcome = pending.catch(error => error);
  await entered.promise;
  let committed = false;
  const replacement = connectRemoteHermes('owner', { ...input, name: 'Account B', sessionToken: 'synthetic-b' }).then(value => { committed = true; return value; });
  try {
    // Wait for either a demonstrably blocked writer or the forbidden commit.
    await vi.waitFor(async () => {
      const { rows } = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      expect(committed || rows.length > 0).toBe(true);
    });
    expect(committed).toBe(false);
  } finally { resume.release(); }
  const accountB = await replacement;
  expect(accountB.connection.id).not.toBe(row.connectionId);
  if (operation === 'dispatch') {
    await vi.waitFor(() => expect(received).toContain('projects.list'));
    // Replacement committed even though Hermes has not acknowledged the send.
    hub.close(); await outcome;
  } else { expect(await outcome).toMatchObject({ id: row.id }); }
  await expect(hub.view(row)).rejects.toThrow('replaced');
  expect(await f.db.select().from(remoteHermesSessions)).toEqual([]);
}, 15_000);
run('PostgreSQL serializes policy revocation through send, then denies new work but allows active recovery', async () => {
  const { hub, row, baseUrl, received } = await fixture();
  const entered = gate(); const resume = gate();
  f.pausePolicy = async () => { entered.release(); await resume.promise; };
  const dispatch = hub.socket.call('projects.list', { profile: 'default' }).catch(error => error);
  await entered.promise;
  let committed = false;
  const revoke = setSetting('remoteHermes', { enabled: true, privateGateways: [] }).then(() => { committed = true; });
  try {
    await vi.waitFor(async () => {
      const { rows } = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      expect(committed || rows.length > 0).toBe(true);
    });
    expect(committed).toBe(false);
  } finally { resume.release(); }
  await revoke;
  await vi.waitFor(() => expect(received).toContain('projects.list'));
  expect((await f.db.select().from(settings).where(eq(settings.key, 'remoteHermes')))[0].value).toEqual({ enabled: true, privateGateways: [] });
  await expect(hub.socket.call('projects.list', { profile: 'default' })).rejects.toThrow('revoked');
  await hub.socket.call('session.interrupt', { session_id: row.runtimeId, profile: row.profile });
  expect(received.filter(method => method === 'projects.list')).toHaveLength(1);
  expect(received).toContain('session.interrupt');
  expect(baseUrl).toContain('127.0.0.1');
  hub.close(); await dispatch;
}, 15_000);
run('reuses a caller transaction in lock order and releases its session/identity locks before acknowledgement', async () => {
  const { hub, row, input, received } = await fixture();
  const { reply } = await f.db.transaction(async tx => {
    await hub.lockBoundary(tx);
    await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
    return hub.socket.dispatchConnected('projects.list', { profile: row.profile }, hub.socket.connectionEpoch, 30_000, tx);
  });
  const outcome = reply.catch(error => error);
  await vi.waitFor(() => expect(received).toContain('projects.list'));
  // A replacement needs both the connection UPDATE lock and cascade's session
  // lock. It must commit while the remote acknowledgement is still withheld.
  await connectRemoteHermes('owner', { ...input, sessionToken: 'synthetic-b' });
  expect(await f.db.select().from(remoteHermesSessions)).toEqual([]);
  await expect(hub.socket.call('projects.list')).rejects.toThrow('replaced');
  hub.close(); await outcome;
}, 15_000);
