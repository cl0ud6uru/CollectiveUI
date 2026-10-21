import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('ws', () => {
  class SyntheticWebSocket {
    static OPEN = 1;
    readyState = SyntheticWebSocket.OPEN;
    private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    constructor(...args: unknown[]) {
      (globalThis as typeof globalThis & { __hermesWsArgs?: unknown[][] }).__hermesWsArgs?.push(args);
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }))));
    }
    on(event: string, callback: (...args: unknown[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]); return this; }
    private emit(event: string, ...args: unknown[]) { for (const callback of this.listeners.get(event) ?? []) callback(...args); }
    send(raw: string, callback?: (error?: Error) => void) {
      const input = JSON.parse(raw) as { id: number };
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { server_requests: ['approval'] } }))));
      callback?.();
    }
    terminate() { this.readyState = 3; this.emit('close', 1000); }
    ping() {}
  }
  return { default: SyntheticWebSocket };
});

import { DashboardSocket } from '@/lib/remote-hermes/socket';

const handshake = () => (globalThis as typeof globalThis & { __hermesWsArgs?: unknown[][] }).__hermesWsArgs ?? [];
afterEach(() => { (globalThis as typeof globalThis & { __hermesWsArgs?: unknown[][] }).__hermesWsArgs = []; });

describe('native Hermes WebSocket auth transport', () => {
  it('passes the pinned OAuth ticket subprotocol to ws without adding it to the URL', async () => {
    const url = new URL('wss://hermes.example/api/ws');
    const protocols = ['hermes-gateway-v1', 'hermes-gateway-ticket.synthetic-private-ticket'];
    (globalThis as typeof globalThis & { __hermesWsArgs?: unknown[][] }).__hermesWsArgs = [];
    const socket = new DashboardSocket(async () => ({ url, options: {}, protocols }), () => {});
    try {
      await socket.connect();
      expect(handshake()).toHaveLength(1);
      expect(handshake()[0][0]).toBe(url);
      expect(handshake()[0][1]).toEqual(protocols);
      expect(handshake()[0][2]).toMatchObject({ followRedirects: false, perMessageDeflate: false });
      expect(String(handshake()[0][0])).not.toMatch(/ticket|synthetic-private-ticket/);
    } finally {
      socket.close();
    }
  });
});
