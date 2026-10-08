import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { remoteHermesSessions } from '@/db/schema';

const f = vi.hoisted(() => ({ base: '', exists: true, enabled: true, approved: true, status: 'running', rows: [] as Record<string, unknown>[] }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled, privateGateways: f.approved ? [f.base] : [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => ({ baseUrl: f.base, policy: { enabled: f.enabled, privateGateways: f.approved ? [f.base] : [] }, secrets: { mode: 'sessionToken', sessionToken: 'synthetic' } }) }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardAddress: async () => {
  if (!f.approved) throw new Error('Private destination revoked');
  return { address: '127.0.0.1', family: 4 };
} }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: (table: Record<symbol, unknown>) => ({ where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const { params } = new PgDialect().sqlToQuery(condition);
  if (table[Symbol.for('drizzle:Name')] === 'remote_hermes_connections') return Promise.resolve(f.exists && params.includes('owner') && params.includes('connection') ? [{ id: 'connection', userId: 'owner', baseUrl: f.base }] : []);
  return Promise.resolve(f.rows.map(row => ({ ...row, status: f.status })));
} }) }) } }));
import { NativeHub } from '@/lib/remote-hermes/hub';
import { retireNativeConnection } from '@/lib/remote-hermes/lifecycle';
import { promptView, sessionView } from '@/lib/remote-hermes/view';

const resources: (() => void)[] = [];
afterEach(() => resources.splice(0).reverse().forEach(close => close()));
beforeEach(() => { f.exists = true; f.enabled = true; f.approved = true; f.status = 'running'; f.rows = []; });
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
      if (input.method) ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { server_requests: ['approval'], session_id: 'runtime-a' } }));
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
