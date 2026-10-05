import { EventEmitter } from 'node:events';
import { HttpError } from '@/lib/authz';
import { db } from '@/db';
import { remoteHermesSessions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { ClientOptions } from 'ws';
import type { RequestOptions } from 'node:http';
import { getSetting } from '@/lib/settings';
import { remoteAccess } from './store';
import { dashboardAddress } from './transport';
import { DashboardSocket, record, type NativeFrame, type RpcRecord } from './socket';
import { promptView, sessionView, answerFor, type NativeSessionView, type NativePrompt } from './view';

type Session = typeof remoteHermesSessions.$inferSelect;
type Cached = { row: Session; view: NativeSessionView; pending: Map<string, { nativeId: string | number; prompt: NativePrompt; params: RpcRecord }>; refreshedAt: number; refreshing?: Promise<NativeSessionView> };
export class NativeHub {
  readonly changes = new EventEmitter();
  readonly socket: DashboardSocket;
  readonly sessions = new Map<string, Cached>();
  private idle?: NodeJS.Timeout;
  constructor(readonly ownerId: string, readonly connectionId: string) {
    this.socket = new DashboardSocket(async () => {
      const target = await remoteAccess(ownerId, connectionId, 'continuation');
      const address = await dashboardAddress(target.baseUrl, target.policy);
      const url = new URL(target.baseUrl + '/api/ws');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (target.secrets.mode === 'sessionToken') url.searchParams.set('token', target.secrets.sessionToken!);
      else url.searchParams.set('ticket', await target.client.websocketTicket());
      const options: ClientOptions & Pick<RequestOptions, 'lookup'> = { family: address.family, lookup: (_host, _opts, callback) => callback(null, address.address, address.family) };
      return { url, options };
    }, frame => this.onFrame(frame), state => {
      for (const cached of this.sessions.values()) { cached.view.connection = state; this.changes.emit(cached.row.id); }
    }, async () => {
      for (const cached of this.sessions.values()) {
        if (!(await getSetting('remoteHermes')).enabled && cached.row.status === 'idle') continue;
        try { await this.refresh(cached.row); } catch { cached.view.uncertain = true; }
      }
    });
  }
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if ([...this.sessions.values()].some(c => c.view.running || c.pending.size)) { this.touch(); return; }
      this.close(); hubs.delete(`${this.ownerId}:${this.connectionId}`);
    }, 5 * 60_000);
    this.idle.unref();
  }
  close() { clearTimeout(this.idle); this.socket.close(); this.sessions.clear(); }
  async refresh(row: Session): Promise<NativeSessionView> {
    this.touch();
    const previous = this.sessions.get(row.id);
    if (!previous && this.sessions.size >= 32) {
      const evict = [...this.sessions.values()].find(c => c.row.status === 'idle' && !c.view.running && !c.pending.size && !c.refreshing);
      if (!evict) throw new HttpError(429, 'Too many Hermes chats are active. Finish a turn before opening another.');
      this.sessions.delete(evict.row.id);
    }
    if (previous?.refreshing) return previous.refreshing;
    const operation = this.refreshInner(row);
    if (previous) previous.refreshing = operation;
    try { return await operation; } finally { const current = this.sessions.get(row.id); if (current) current.refreshing = undefined; }
  }
  private async refreshInner(row: Session) {
    const snapshot = await this.socket.call('session.resume', { session_id: row.storedId, profile: row.profile, cols: 80, inline_images: false, close_on_disconnect: false });
    const runtimeId = typeof snapshot.session_id === 'string' ? snapshot.session_id : '';
    const storedId = typeof snapshot.stored_session_id === 'string' ? snapshot.stored_session_id : row.storedId;
    if (!runtimeId) throw new HttpError(502, 'Hermes did not return a native session identity.');
    const view = sessionView(row.id, row.profile, snapshot, this.socket.state);
    view.uncertain = !view.running && (row.status === 'uncertain' || row.status === 'admitting');
    const pending = new Map<string, { nativeId: string | number; prompt: NativePrompt; params: RpcRecord }>();
    for (const raw of Array.isArray(snapshot.open_requests) ? snapshot.open_requests : []) {
      const request = record(raw);
      if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') continue;
      if (record(request.params).session_id !== runtimeId) continue;
      const prompt = promptView(request.id, request.method, request.params);
      if (prompt) pending.set(prompt.id, { nativeId: request.id, prompt, params: record(request.params) });
      else this.socket.answer(request.id);
    }
    const approval = record(snapshot.pending_approval);
    if (typeof approval.request_id === 'string' && ![...pending.values()].some(p => p.params.request_id === approval.request_id)) {
      const prompt = promptView(`approval-${approval.request_id}`, 'approval', approval)!;
      pending.set(prompt.id, { nativeId: prompt.id, prompt, params: { ...approval, fallbackApproval: true } });
    }
    view.prompts = [...pending.values()].map(p => p.prompt);
    // Preserve write-ahead uncertainty until the backend confirms a turn is actually running.
    const status = view.running ? pending.size ? 'waiting' : 'running'
      : ['admitting', 'uncertain'].includes(row.status) ? row.status : 'idle';
    await db.update(remoteHermesSessions).set({ runtimeId, storedId, title: view.title, status, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, row.id));
    const current = { ...row, runtimeId, storedId, title: view.title, status } as Session;
    this.sessions.set(row.id, { row: current, view, pending, refreshedAt: Date.now() });
    this.changes.emit(row.id);
    return view;
  }
  async view(row: Session) {
    this.touch();
    const cached = this.sessions.get(row.id);
    if (!cached || Date.now() - cached.refreshedAt > 5000) return this.refresh(row);
    return cached.view;
  }
  private onFrame(frame: NativeFrame) {
    const p = record(frame.params);
    const cached = [...this.sessions.values()].find(c => c.row.runtimeId === p.session_id);
    // A resume can emit a request before returning its runtime id. The snapshot replays that request.
    if (!cached) return;
    if (frame.id !== undefined && frame.method && frame.method !== 'event') {
      const prompt = promptView(frame.id, frame.method, p);
      if (!prompt) { try { this.socket.answer(frame.id); } catch {} return; }
      cached.pending.set(prompt.id, { nativeId: frame.id, prompt, params: p });
      cached.view.prompts = [...cached.pending.values()].map(v => v.prompt);
      cached.view.running = true;
      this.changes.emit(cached.row.id); return;
    }
    if (frame.method !== 'event') return;
    const payload = record(p.payload);
    switch (p.type) {
      case 'message.start':
        cached.view.running = true; cached.view.partial = ''; cached.row.status = 'running';
        cached.view.queued = '';
        void db.update(remoteHermesSessions).set({ status: 'running', updatedAt: new Date() }).where(eq(remoteHermesSessions.id, cached.row.id)).catch(() => { cached.view.uncertain = true; });
        break;
      case 'message.delta': if (typeof payload.text === 'string') cached.view.partial = (cached.view.partial + payload.text).slice(0, 128000); break;
      case 'tool.start': {
        const tool = { id: String(payload.tool_id), name: String(payload.name ?? 'Tool').slice(0, 200), detail: JSON.stringify(payload.args ?? payload.context ?? '').slice(0, 4000), done: false };
        cached.view.tools = [...cached.view.tools.slice(-99), tool]; break;
      }
      case 'tool.complete': {
        const tool = cached.view.tools.find(t => t.id === String(payload.tool_id));
        if (tool) { tool.done = true; tool.detail = JSON.stringify(payload.result ?? payload.summary ?? '').slice(0, 16000); } break;
      }
      case 'request.cancel': cached.pending.delete(String(payload.id)); cached.view.prompts = [...cached.pending.values()].map(v => v.prompt); break;
      case 'message.complete':
        cached.view.running = !!cached.view.queued; cached.view.uncertain = false;
        cached.pending.clear(); cached.view.prompts = [];
        // Terminal notification settles the admitted turn even if its acknowledgement was lost.
        cached.row.status = cached.view.queued ? 'running' : 'idle';
        void db.update(remoteHermesSessions).set({ status: cached.row.status, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, cached.row.id)).then(() => this.refresh(cached.row)).catch(() => { cached.view.uncertain = true; });
        break;
      case 'session.info':
        if (typeof payload.model === 'string') cached.view.model = payload.model;
        if (typeof payload.provider === 'string') cached.view.provider = payload.provider;
        if (typeof payload.stored_session_id === 'string' && payload.stored_session_id && payload.stored_session_id !== cached.row.storedId) {
          cached.row.storedId = payload.stored_session_id;
          void db.update(remoteHermesSessions).set({ storedId: payload.stored_session_id, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, cached.row.id)).catch(() => { cached.view.uncertain = true; });
        }
        break;
    }
    this.changes.emit(cached.row.id);
  }
  async answer(row: Session, requestId: string, input: unknown) {
    await this.refresh(row);
    const cached = this.sessions.get(row.id)!;
    const pending = cached.pending.get(requestId);
    if (!pending) throw new HttpError(409, 'This native prompt has expired or was answered elsewhere.');
    const result = answerFor(pending.prompt, input);
    if (pending.params.fallbackApproval) await this.socket.call('approval.respond', { session_id: cached.row.runtimeId, profile: row.profile, request_id: pending.params.request_id, choice: result.choice });
    else this.socket.answer(pending.nativeId, result);
    cached.pending.delete(requestId); cached.view.prompts = [...cached.pending.values()].map(p => p.prompt);
    return { answered: true };
  }
}
const globalHubs = globalThis as unknown as { collectiveRemoteHermesHubs?: Map<string, NativeHub> };
const hubs = globalHubs.collectiveRemoteHermesHubs ??= new Map();
export function nativeHub(ownerId: string, connectionId: string) {
  const key = `${ownerId}:${connectionId}`;
  let hub = hubs.get(key);
  if (!hub) {
    if (hubs.size >= 128 || [...hubs.values()].filter(h => h.ownerId === ownerId).length >= 8) throw new HttpError(429, 'Too many remote Hermes connections are open. Close an inactive connection first.');
    hub = new NativeHub(ownerId, connectionId); hubs.set(key, hub);
  }
  hub.touch(); return hub;
}
