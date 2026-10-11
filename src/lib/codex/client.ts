import 'server-only';
import WebSocket from 'ws';
import { z } from 'zod';
import { CODEX_VERSION } from './config';
import { runtimeToken, type CodexRuntime } from './runtime';

const envelope = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(),
  params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough();
export type CodexNotification = { method: string; params: unknown };
const failure = () => new Error('The Codex app-server connection failed. The request will not be replayed automatically.');

/** Bounded JSON-RPC transport. Exactly one connection; never reconnect or replay a mutating request. */
export class CodexClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: CodexNotification) => void>();
  private failureListeners = new Set<(error: Error) => void>();
  private failed = false;
  private heartbeat: ReturnType<typeof setInterval>;
  private pong = true;
  private constructor(private ws: WebSocket) {
    ws.on('message', data => {
      try {
        const m = envelope.parse(JSON.parse(data.toString()));
        if (m.method && m.id !== undefined) {
          // No approval is ever auto-accepted. Unknown requests fail closed and stop this turn.
          ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Interactive approvals and tools are unavailable in this client.' } }));
          this.fail(new Error('Codex requested an unsupported approval or interactive tool. The turn was stopped.'));
        } else if (m.method) {
          for (const fn of this.listeners) fn({ method: m.method, params: m.params });
        } else if (typeof m.id === 'number') {
          const p = this.pending.get(m.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(m.id); if (m.error !== undefined) p.reject(failure()); else p.resolve(m.result); }
        } else throw failure();
      } catch { this.fail(failure()); }
    });
    ws.on('close', () => this.fail(failure()));
    ws.on('error', () => this.fail(failure()));
    ws.on('pong', () => { this.pong = true; });
    this.heartbeat = setInterval(() => {
      if (!this.pong) { this.fail(failure()); ws.terminate(); return; }
      this.pong = false; if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15000);
    this.heartbeat.unref();
  }
  static async connect(runtime: CodexRuntime) {
    const ws = new WebSocket(runtime.endpoint, { headers: { Authorization: `Bearer ${await runtimeToken(runtime)}` },
      followRedirects: false, perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: 8000 });
    const client = new CodexClient(ws);
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(failure())); ws.once('close', () => reject(failure())); });
      const result = z.object({ userAgent: z.string() }).parse(await client.request('initialize', {
        clientInfo: { name: 'collective_ui', title: 'CollectiveUI', version: '0.1.0' }, capabilities: { experimentalApi: false },
      }));
      if (!result.userAgent.split(/[ /()]+/).includes(CODEX_VERSION)) throw new Error('The Codex runtime version is unsupported.');
      client.notify('initialized', {});
      return client;
    } catch (err) { client.close(); throw err; }
  }
  onNotification(fn: (event: CodexNotification) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onFailure(fn: (error: Error) => void) { this.failureListeners.add(fn); if (this.failed) fn(failure()); return () => this.failureListeners.delete(fn); }
  request(method: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
    if (this.failed || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(failure());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure()); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), err => { if (err) this.fail(failure()); });
    });
  }
  private notify(method: string, params: unknown) { this.ws.send(JSON.stringify({ method, params })); }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true; clearInterval(this.heartbeat);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
    for (const fn of this.failureListeners) fn(error);
  }
  close() { this.fail(failure()); this.ws.terminate(); }
}
