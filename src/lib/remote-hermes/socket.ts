import WebSocket, { type ClientOptions } from 'ws';
import { HttpError } from '@/lib/authz';

export type RpcRecord = Record<string, unknown>;
export type NativeFrame = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: RpcRecord; result?: RpcRecord; error?: { code?: number } };
export const record = (v: unknown): RpcRecord => v && typeof v === 'object' && !Array.isArray(v) ? v as RpcRecord : {};
export type SocketState = 'connecting' | 'connected' | 'reconnecting' | 'auth_required' | 'disconnected';
/** A remote JSON-RPC rejection is distinct from a lost transport acknowledgement. */
export class NativeRpcError extends HttpError {
  constructor(readonly code: number | undefined) {
    super(code === -32601 ? 501 : 502, code === -32601 ? 'This Hermes version does not support that feature.' : 'Hermes refused this operation. Check its native settings.');
  }
}

/** One server-owned native socket. RPCs are never resent after an uncertain transport failure. */
export class DashboardSocket {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private ready = false;
  private transportReady = false;
  private wanted = false;
  private everConnected = false;
  private sequence = 0;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private pending = new Map<number, { resolve: (v: RpcRecord) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  state: SocketState = 'disconnected';
  serverRequests: string[] = [];
  constructor(private target: () => Promise<{ url: URL; options: ClientOptions }>, private frame: (f: NativeFrame) => void,
    private changed: (state: SocketState) => void = () => {}, private reconnected: () => Promise<void> = async () => {}) {}
  private setState(state: SocketState) { this.state = state; this.changed(state); }
  async connect(): Promise<void> {
    this.wanted = true;
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async open() {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.setState(this.everConnected ? 'reconnecting' : 'connecting');
    try {
      const target = await this.target();
      if (!this.wanted) throw new HttpError(409, 'Hermes connection was closed.');
      const ws = new WebSocket(target.url, { ...target.options, followRedirects: false, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 15_000 });
      this.ws = ws;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new HttpError(504, 'Hermes did not announce socket readiness.')); ws.terminate(); }, 15_000);
        ws.on('error', () => { clearTimeout(timeout); reject(new HttpError(502, 'The Hermes socket could not connect. Check the dashboard URL and proxy WebSocket support.')); });
        ws.on('close', code => {
          clearTimeout(timeout);
          reject(new HttpError(code === 4401 ? 401 : 502, code === 4401 ? 'Sign into Hermes again.' : 'The Hermes socket disconnected.'));
          if (this.ws !== ws) return;
          this.ready = false; this.transportReady = false; this.ws = undefined; clearInterval(this.heartbeat);
          this.rejectPending();
          if (code === 4401 || code === 4403) { this.wanted = false; this.setState('auth_required'); }
          else { this.setState(this.wanted ? 'reconnecting' : 'disconnected'); this.schedule(); }
        });
        ws.on('message', data => {
          if (this.ws !== ws) return;
          let f: NativeFrame;
          try { f = JSON.parse(data.toString()); } catch { ws.terminate(); return; }
          if (!f || f.jsonrpc !== '2.0') { ws.terminate(); return; }
          if (f.method === 'event' && f.params?.type === 'gateway.ready') {
            clearTimeout(timeout); this.transportReady = true; resolve(); return;
          }
          if (f.method) { this.frame(f); return; }
          if (typeof f.id !== 'number') return;
          const pending = this.pending.get(f.id);
          if (!pending) return;
          this.pending.delete(f.id); clearTimeout(pending.timer);
          if (f.error) pending.reject(new NativeRpcError(f.error.code));
          else pending.resolve(record(f.result));
        });
      });
      const capabilities = await this.send('client.capabilities', { server_requests: true }, 30_000);
      this.serverRequests = Array.isArray(capabilities.server_requests) ? capabilities.server_requests.filter((v): v is string => typeof v === 'string') : [];
      if (!this.serverRequests.includes('approval')) throw new HttpError(501, 'This Hermes version does not support native approval prompts. Update Hermes before chatting.');
      this.ready = true;
      const wasReconnect = this.everConnected;
      this.everConnected = true; this.attempt = 0; this.setState('connected');
      this.heartbeat = setInterval(() => { void this.call('ping', {}, 10_000).catch(() => ws.terminate()); }, 20_000);
      this.heartbeat.unref();
      // Recovery may join a refresh already waiting on this connect(). Do not make
      // completion of the connection depend on completion of that same refresh.
      if (wasReconnect) void this.reconnected().catch(() => {});
    } catch (e) {
      this.ready = false; this.transportReady = false; this.ws?.terminate();
      if (e instanceof HttpError && [401, 403, 501].includes(e.status)) { this.wanted = false; this.setState(e.status === 501 ? 'disconnected' : 'auth_required'); }
      else this.schedule();
      throw e;
    }
  }
  private schedule() {
    if (!this.wanted || this.retry) return;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt++, 5)) * (0.8 + Math.random() * 0.4);
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect().catch(() => {}); }, delay);
    this.retry.unref();
  }
  async call(method: string, params: RpcRecord = {}, timeoutMs = 30_000): Promise<RpcRecord> {
    await this.connect();
    if (!this.ws || !this.ready) throw new HttpError(502, 'Reconnect to Hermes before continuing.');
    return this.send(method, params, timeoutMs);
  }
  private send(method: string, params: RpcRecord, timeoutMs: number): Promise<RpcRecord> {
    if (!this.ws || !this.transportReady || this.ws.readyState !== WebSocket.OPEN) throw new HttpError(502, 'Reconnect to Hermes before continuing.');
    if (this.pending.size >= 64) throw new HttpError(429, 'Too many Hermes operations are pending.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HttpError(504, 'Hermes did not confirm this operation. Refresh the native session before trying again.')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new HttpError(502, 'Hermes disconnected before confirming this operation. Refresh the session.')); }
      });
    });
  }
  /** Only server-verified pending requests are answered; values are never logged or retained. */
  answer(id: string | number, result?: RpcRecord) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) throw new HttpError(409, 'Reconnect and reload the pending prompt before answering.');
    this.ws.send(JSON.stringify(result ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported interaction' } }));
  }
  private rejectPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(502, 'Hermes disconnected. The operation may have been accepted; refresh instead of resending it.')); }
    this.pending.clear();
  }
  close() { this.wanted = false; clearTimeout(this.retry); this.retry = undefined; clearInterval(this.heartbeat); this.rejectPending(); this.ready = false; this.transportReady = false; this.ws?.terminate(); this.setState('disconnected'); }
}
