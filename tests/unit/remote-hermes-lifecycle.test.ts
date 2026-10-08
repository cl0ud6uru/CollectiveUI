import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { remoteHermesSessions } from '@/db/schema';

const f = vi.hoisted(() => ({ base: '', exists: true, enabled: true, approved: true, status: 'running', rows: [] as Record<string, unknown>[], policyWait: undefined as (() => Promise<void>) | undefined, locks: 0, unlock: [] as (() => void)[], delayReply: false }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => { await f.policyWait?.(); return { enabled: f.enabled, privateGateways: f.approved ? [f.base] : [] }; } }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => ({ baseUrl: f.base, policy: { enabled: f.enabled, privateGateways: f.approved ? [f.base] : [] }, secrets: { mode: 'sessionToken', sessionToken: 'synthetic' } }) }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardAddress: async () => {
  if (!f.approved) throw new Error('Private destination revoked');
  return { address: '127.0.0.1', family: 4 };
} }));
vi.mock('@/db', () => {
  const query = () => ({ from: (table: Record<symbol, unknown>) => ({ where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const read = () => {
      const { params } = new PgDialect().sqlToQuery(condition);
      if (table[Symbol.for('drizzle:Name')] === 'settings') return [];
      if (table[Symbol.for('drizzle:Name')] === 'remote_hermes_connections') return f.exists && params.includes('owner') && params.includes('connection') ? [{ id: 'connection', userId: 'owner', baseUrl: f.base }] : [];
      return f.rows.map(row => ({ ...row, status: f.status }));
    };
    return { then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(read()).then(resolve), for: async () => { ++f.locks; return read(); } };
  } }) });
  const db = { select: query, transaction: async (run: (tx: { select: typeof query }) => Promise<unknown>) => {
    try { return await run({ select: query }); }
    finally { f.locks = 0; f.unlock.splice(0).forEach(resolve => resolve()); }
  } };
  return { db };
});
import { NativeHub } from '@/lib/remote-hermes/hub';
import { retireNativeConnection } from '@/lib/remote-hermes/lifecycle';
import { promptView, sessionView } from '@/lib/remote-hermes/view';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).reverse().forEach(close => close()));
beforeEach(() => { f.exists = true; f.enabled = true; f.approved = true; f.status = 'running'; f.rows = []; f.policyWait = undefined; f.locks = 0; f.unlock = []; f.delayReply = false; });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function replaceInOtherProcess() {
  if (f.locks) await new Promise<void>(resolve => f.unlock.push(resolve));
  f.exists = false; // No local retirement callback: the other process cannot close this socket.
}
it.each(['dispatch', 'cached view'] as const)('serializes replacement during policy authorization against %s', async operation => {
  const { hub, row, received } = await fixture();
  const entered = gate(); const resume = gate();
  f.policyWait = async () => { entered.release(); await resume.promise; };
  f.delayReply = true;
  const pending = operation === 'dispatch' ? hub.socket.call('projects.list', { profile: 'default' }) : hub.view(row);
  // Attach a handler before cleanup can reject an unacknowledged RPC.
  const outcome = pending.catch(error => error);
  await entered.promise;
  let committed = false;
  const replacement = replaceInOtherProcess().then(() => { committed = true; });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(committed).toBe(false);
  } finally { resume.release(); }
  await replacement;
  expect(committed).toBe(true);
  expect(f.locks).toBe(0); // Dispatch releases the fence without waiting for the native reply.
  if (operation === 'dispatch') {
    await vi.waitFor(() => expect(received.some(frame => frame.method === 'projects.list')).toBe(true));
    hub.close(); await outcome;
  } else { expect(await outcome).toMatchObject({ id: row.id }); }
  await expect(hub.view(row)).rejects.toThrow('replaced');
});
async function fixture() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  resources.push(() => { server.clients.forEach(ws => ws.terminate()); server.close(); });
  const address = server.address(); if (typeof address !== 'object' || !address) throw new Error('No fixture address');
  f.base = `http://127.0.0.1:${address.port}`;
  const received: Record<string, unknown>[] = [];
  server.on('connection', ws => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }));
    ws.on('message', raw => {
      const input = JSON.parse(String(raw)); received.push(input);
      if (input.method && !(f.delayReply && input.method === 'projects.list')) ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { server_requests: ['approval'], session_id: 'runtime-a' } }));
    });
  });
  const hub = new NativeHub('owner', 'connection'); resources.push(() => hub.close());
  const row = { id: 'local-a', connectionId: 'connection', profile: 'default', storedId: 'stored-a', runtimeId: 'runtime-a', status: 'running', queueRequestId: null } as typeof remoteHermesSessions.$inferSelect;
  f.rows = [row];
  hub.sessions.set(row.id, { row, view: sessionView(row.id, row.profile, { session_id: row.runtimeId, running: true }, 'connected'), pending: new Map([['native-ask-a', { nativeId: 'native-ask-a', prompt: promptView('native-ask-a', 'approval', { command: 'synthetic' })!, params: { session_id: row.runtimeId } }]]), refreshedAt: Date.now(), eventRevision: 0, socketEpoch: 1 });
  await hub.socket.call('session.resume', { session_id: row.storedId, profile: row.profile });
  return { hub, row, received, server };
}
it('fences ready sockets and cached account A identities when its connection is retired', async () => {
  const { hub, row, received } = await fixture();
  f.exists = false; // Account B's sign-in retired this connection, even with the same profile.
  await expect(hub.view(row)).rejects.toThrow();
  await expect(hub.socket.call('projects.list', { profile: 'default' })).rejects.toThrow();
  expect(hub.sessions.size).toBe(0);
  expect(received.map(frame => frame.method)).toEqual(['client.capabilities', 'session.resume']);
});
it('eagerly drops local caches and makes retired socket references permanently unusable', async () => {
  const { hub, row } = await fixture();
  retireNativeConnection('owner', 'connection');
  expect(hub.sessions.size).toBe(0);
  await expect(hub.socket.connect()).rejects.toThrow('retired');
  await expect(hub.view(row)).rejects.toThrow('replaced');
});
it('does not reconnect active recovery to a revoked private destination', async () => {
  const { hub, row, server, received } = await fixture();
  f.approved = false;
  server.clients.forEach(ws => ws.terminate());
  await vi.waitFor(() => expect(hub.socket.state).toBe('reconnecting'));
  await expect(hub.socket.call('session.resume', { session_id: row.storedId, profile: row.profile })).rejects.toThrow('revoked');
  expect(received.map(frame => frame.method)).toEqual(['client.capabilities', 'session.resume']);
});
it('preserves active stop recovery across a reconnect when only admission is disabled', async () => {
  const { hub, row, server, received } = await fixture();
  f.enabled = false;
  server.clients.forEach(ws => ws.terminate());
  await vi.waitFor(() => expect(hub.socket.state).toBe('reconnecting'));
  await hub.socket.call('session.interrupt', { session_id: row.runtimeId, profile: row.profile });
  await expect(hub.socket.call('session.steer', { session_id: row.runtimeId, profile: row.profile, text: 'new work' })).rejects.toThrow('disabled');
  expect(received.filter(frame => frame.method !== 'session.resume').map(frame => frame.method)).toEqual(['client.capabilities', 'client.capabilities', 'session.interrupt']);
});
it('revokes socket-only work but retains only owned active recovery on the existing socket', async () => {
  const { hub, row, received } = await fixture();
  f.approved = false;
  await expect(hub.socket.call('projects.list', { profile: 'default' })).rejects.toThrow();
  await expect(hub.socket.call('prompt.submit', { session_id: row.runtimeId, profile: row.profile, text: 'new work' })).rejects.toThrow();
  await expect(hub.socket.callConnected('config.set', { session_id: row.runtimeId, profile: row.profile }, hub.socket.connectionEpoch)).rejects.toThrow();
  await hub.socket.call('session.resume', { session_id: row.storedId, profile: row.profile });
  await hub.socket.call('session.interrupt', { session_id: row.runtimeId, profile: row.profile });
  await hub.socket.answer('native-ask-a', { choice: 'deny' });
  await expect(hub.socket.call('session.interrupt', { session_id: 'runtime-other', profile: 'default' })).rejects.toThrow();
  await expect(hub.socket.call('session.interrupt', { session_id: row.runtimeId, profile: 'other' })).rejects.toThrow();
  await expect(hub.socket.answer('unknown-request', { choice: 'once' })).rejects.toThrow();
  f.status = 'idle';
  await expect(hub.socket.call('session.interrupt', { session_id: row.runtimeId, profile: row.profile })).rejects.toThrow();
  await vi.waitFor(() => expect(received.map(frame => frame.method)).toEqual(['client.capabilities', 'session.resume', 'session.resume', 'session.interrupt', undefined]));
});
