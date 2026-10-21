import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { DashboardSocket } from '@/lib/remote-hermes/socket';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()));

it.each(['config.set', 'approval.respond', 'session.resume'])('never moves %s to a replacement socket during ownership preparation', async method => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => { server.clients.forEach(client => client.terminate()); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  let active: WebSocket | undefined;
  const methods: string[] = [];
  server.on('connection', ws => {
    active = ws;
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }));
    ws.on('message', raw => {
      const input = JSON.parse(String(raw)); methods.push(input.method);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { server_requests: ['approval'] } }));
    });
  });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const socket = new DashboardSocket(async () => ({ url: new URL(`ws://127.0.0.1:${address.port}`), options: {} }),
    () => {}, undefined, undefined, undefined, undefined, async operation => {
      if (operation === method) { enter(); await held; }
    });
  cleanup.push(() => { release(); socket.close(); });
  await socket.connect();
  const epoch = socket.connectionEpoch;
  const pending = (method === 'session.resume' ? socket.callWithEpoch(method, {}) : socket.callConnected(method, {}, epoch))
    .then(value => ({ value }), error => ({ error }));
  await entered;
  active!.terminate();
  await vi.waitFor(() => expect(socket.state).toBe('reconnecting'));
  await socket.connect();
  expect(socket.connectionEpoch).toBeGreaterThan(epoch);
  release();
  await expect(pending).resolves.toMatchObject({ error: { status: 409 } });
  expect(methods).toEqual(['client.capabilities', 'client.capabilities']);
});
