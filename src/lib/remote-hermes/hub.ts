import { EventEmitter } from 'node:events';
import { HttpError } from '@/lib/authz';
import { db, type DbOrTx, type Tx } from '@/db';
import { remoteHermesConnections, remoteHermesSessions, settings } from '@/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { ClientOptions } from 'ws';
import type { RequestOptions } from 'node:http';
import { getSetting, type RemoteHermesSettings } from '@/lib/settings';
import { isPrivateAddress } from '@/lib/agent/tools/web';
import { registerNativeConnection } from './lifecycle';
import { remoteAccess } from './store';
import { dashboardAddress } from './transport';
import { DashboardSocket, record, type NativeFrame, type RpcRecord } from './socket';
import { promptView, sessionView, answerFor, type NativeSessionView, type NativePrompt } from './view';

type Session = typeof remoteHermesSessions.$inferSelect;
type Cached = { row: Session; view: NativeSessionView; pending: Map<string, { nativeId: string | number; prompt: NativePrompt; params: RpcRecord }>; refreshedAt: number; eventRevision: number; socketEpoch: number };
export class NativeHub {
  readonly changes = new EventEmitter();
  readonly socket: DashboardSocket;
  readonly sessions = new Map<string, Cached>();
  private refreshing = new Map<string, Promise<NativeSessionView>>();
  private idle?: NodeJS.Timeout;
  private pinned?: { baseUrl: string; address: string };
  private retired = false;
  private unregister: () => void;
  constructor(readonly ownerId: string, readonly connectionId: string) {
    this.unregister = registerNativeConnection(ownerId, connectionId, () => this.close());
    this.socket = new DashboardSocket(async () => {
      const target = await remoteAccess(ownerId, connectionId, 'continuation');
      const address = await dashboardAddress(target.baseUrl, target.policy);
      this.pinned = { baseUrl: target.baseUrl, address: address.address };
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
    }, async () => {}, (method, params, dispatch, tx) => this.dispatchBoundary(method, params, dispatch, tx));
  }
  async assertIdentity(q: DbOrTx = db, lock = false) {
    if (this.retired) throw new HttpError(409, 'This Hermes sign-in was replaced. Open a conversation from the new connection.');
    const query = q.select().from(remoteHermesConnections).where(and(eq(remoteHermesConnections.userId, this.ownerId), eq(remoteHermesConnections.id, this.connectionId)));
    const [connection] = await (lock ? query.for('share') : query);
    if (!connection || this.retired) {
      this.close();
      throw new HttpError(409, 'This Hermes sign-in was replaced. Open a conversation from the new connection.');
    }
    return connection;
  }
  /** Lock order matches replacement: policy -> connection -> session (if needed).
   * Callers with a transaction must acquire this before their session lock and
   * pass that transaction to the socket, never open a second pool transaction. */
  async lockBoundary(tx: Tx) {
    await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
    return this.assertIdentity(tx, true);
  }
  /** The synchronous send/cache selection is the linearization point. Returning
   * an envelope prevents transaction() from awaiting a remote acknowledgement. */
  private async dispatchBoundary<T>(method: string, params: RpcRecord, dispatch: () => T, tx?: Tx): Promise<{ value: T }> {
    const run = async (q: Tx) => {
      const connection = await this.lockBoundary(q);
      await this.authorize(method, params, connection, await getSetting('remoteHermes', q), q);
      if (this.retired) throw new HttpError(409, 'This Hermes sign-in was replaced.');
      return { value: dispatch() };
    };
    return tx ? run(tx) : db.transaction(run);
  }
  /** Check durable identity and current policy inside the dispatch boundary. */
  private async authorize(method: string, params: RpcRecord, connection: typeof remoteHermesConnections.$inferSelect, policy: RemoteHermesSettings, q: DbOrTx) {
    // A live socket remains pinned to its admitted address; new upgrades still
    // use dashboardAddress and cannot reconnect to a revoked private destination.
    const address = this.pinned?.baseUrl === connection.baseUrl ? this.pinned :
      { baseUrl: connection.baseUrl, ...(await dashboardAddress(connection.baseUrl, policy)) };
    const revoked = isPrivateAddress(address.address) && !policy.privateGateways.includes(connection.baseUrl);
    if (policy.enabled && !revoked) return;
    // Only an already admitted, durable binding can recover on the old socket.
    // No steering, uploads, queues, commands, setters or inspection are exempt.
    const rows = await q.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.connectionId, this.connectionId));
    const active = rows.filter(row => row.status !== 'idle' || row.queueRequestId);
    if ((method === 'ping' || (method === 'client.capabilities' && !revoked)) && active.length) return;
    const cached = method === '$answer' ? [...this.sessions.values()].find(c => [...c.pending.values()].some(p => p.nativeId === params.id)) : undefined;
    const binding = active.find(row => row.connectionId === this.connectionId && (cached ? row.id === cached.row.id :
      row.profile === params.profile && (method === 'session.resume' ? row.storedId === params.session_id : row.runtimeId === params.session_id)));
    if (binding && ['session.resume', 'session.interrupt', 'approval.respond', '$answer'].includes(method) && (!revoked || this.socket.state === 'connected')) {
      if (method !== 'approval.respond' || [...(this.sessions.get(binding.id)?.pending.values() ?? [])].some(p => p.params.request_id === params.request_id)) return;
    }
    throw new HttpError(403, revoked ? 'This private Hermes destination was revoked. Only active-turn recovery on its existing socket is allowed.' : 'Personal remote Hermes is disabled. Only active-turn recovery is allowed.');
  }
  async validate(row: Session) { await this.dispatchBoundary('session.resume', { session_id: row.storedId, profile: row.profile }, () => {}); }
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.refreshing.size || [...this.sessions.values()].some(c => c.row.status !== 'idle' || c.row.queueRequestId || c.view.running || c.pending.size)) { this.touch(); return; }
      this.close(); hubs.delete(`${this.ownerId}:${this.connectionId}`);
    }, 5 * 60_000);
    this.idle.unref();
  }
  close() { this.retired = true; this.unregister(); clearTimeout(this.idle); this.socket.close(); this.sessions.clear(); hubs.delete(`${this.ownerId}:${this.connectionId}`); }
  async refresh(row: Session): Promise<NativeSessionView> {
    await this.validate(row);
    this.touch();
    const inFlight = this.refreshing.get(row.id);
    if (inFlight) return inFlight;
    const previous = this.sessions.get(row.id);
    if (!previous && this.sessions.size >= 32) {
      const evict = [...this.sessions.values()].find(c => c.row.status === 'idle' && !c.row.queueRequestId && !c.view.running && !c.pending.size && !this.refreshing.has(c.row.id));
      if (!evict) throw new HttpError(429, 'Too many Hermes chats are active. Finish a turn before opening another.');
      this.sessions.delete(evict.row.id);
    }
    // Register before starting work: cold opens have no cached entry yet.
    const operation = Promise.resolve().then(() => this.refreshInner(row));
    this.refreshing.set(row.id, operation);
    try { return await operation; } finally { this.refreshing.delete(row.id); }
  }
  private async refreshInner(row: Session) {
    const [observed] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id));
    if (!observed) throw new HttpError(404, 'Native Hermes chat not found.');
    row = observed;
    const eventRevision = this.sessions.get(row.id)?.eventRevision ?? 0;
    const { result: snapshot, epoch: socketEpoch } = await this.socket.callWithEpoch('session.resume', { session_id: row.storedId, profile: row.profile, cols: 80, inline_images: false, close_on_disconnect: false });
    await this.assertIdentity();
    const runtimeId = typeof snapshot.session_id === 'string' ? snapshot.session_id : '';
    const storedId = typeof snapshot.stored_session_id === 'string' ? snapshot.stored_session_id : row.storedId;
    if (!runtimeId) throw new HttpError(502, 'Hermes did not return a native session identity.');
    const view = sessionView(row.id, row.profile, snapshot, this.socket.state);
    const pending = new Map<string, { nativeId: string | number; prompt: NativePrompt; params: RpcRecord }>();
    for (const raw of Array.isArray(snapshot.open_requests) ? snapshot.open_requests : []) {
      const request = record(raw);
      if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') continue;
      if (record(request.params).session_id !== runtimeId) continue;
      const prompt = promptView(request.id, request.method, request.params);
      if (prompt) pending.set(prompt.id, { nativeId: request.id, prompt, params: record(request.params) });
      else await this.socket.answer(request.id).catch(() => {});
    }
    const approval = record(snapshot.pending_approval);
    if (typeof approval.request_id === 'string' && ![...pending.values()].some(p => p.params.request_id === approval.request_id)) {
      const prompt = promptView(`approval-${approval.request_id}`, 'approval', approval)!;
      pending.set(prompt.id, { nativeId: prompt.id, prompt, params: { ...approval, fallbackApproval: true } });
    }
    view.prompts = [...pending.values()].map(p => p.prompt);
    const current = await db.transaction(async tx => {
      await this.lockBoundary(tx);
      const [latest] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
      if (!latest) throw new HttpError(404, 'Native Hermes chat not found.');
      // Only a snapshot started after the last mutation can settle that mutation.
      if (latest.revision !== row.revision || (this.sessions.get(row.id)?.eventRevision ?? 0) !== eventRevision) return latest;
      const status = view.running ? pending.size ? 'waiting' : 'running'
        : ['admitting', 'uncertain'].includes(latest.status) ? latest.status : 'idle';
      // Unacknowledged queues remain reserved even if an idle snapshot arrives.
      const queueStatus = view.queued && latest.queueRequestId ? 'queued' : latest.queueStatus;
      const clearQueue = latest.queueStatus === 'queued' && !view.queued;
      return (await tx.update(remoteHermesSessions).set({ runtimeId, storedId, title: view.title, status,
        admissionRequestId: status === 'idle' ? null : latest.admissionRequestId,
        queueRequestId: clearQueue ? null : latest.queueRequestId, queueStatus: clearQueue ? null : queueStatus,
        revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, row.id)).returning())[0];
    });
    return db.transaction(async tx => {
      await this.lockBoundary(tx);
      view.queuePending = !!current.queueRequestId;
      view.uncertain = current.status === 'admitting' || current.status === 'uncertain' || current.queueStatus === 'uncertain';
      view.running ||= current.status === 'running' || current.status === 'waiting' || !!current.queueRequestId;
      const cached = this.sessions.get(row.id);
      if (cached && cached.eventRevision !== eventRevision) {
        // Keep events received while the snapshot was being read (deltas and native requests too).
        if (current.revision >= cached.row.revision) cached.row = current;
        cached.view.queuePending = view.queuePending;
        cached.view.uncertain ||= view.uncertain;
        return cached.view;
      }
      this.sessions.set(row.id, { row: current, view, pending, refreshedAt: Date.now(), eventRevision, socketEpoch });
      this.changes.emit(row.id);
      return view;
    });
  }
  async view(row: Session) {
    const { value } = await this.dispatchBoundary('session.resume', { session_id: row.storedId, profile: row.profile }, () => {
      this.touch();
      const cached = this.sessions.get(row.id);
      return cached && Date.now() - cached.refreshedAt <= 5000 ? cached.view : undefined;
    });
    return value ?? this.refresh(row);
  }
  /** Disabled idle history remains retained, but never crosses a retired identity. */
  async retainedView(row: Session) {
    return db.transaction(async tx => {
      await this.lockBoundary(tx);
      const cached = this.sessions.get(row.id);
      if (!cached) throw new HttpError(403, 'Personal remote Hermes is disabled. Saved conversations are retained.');
      return { ...cached.view, admissionAllowed: false, yoloAllowed: false };
    });
  }
  private onFrame(frame: NativeFrame) {
    const p = record(frame.params);
    const cached = [...this.sessions.values()].find(c => c.row.runtimeId === p.session_id);
    // A resume can emit a request before returning its runtime id. The snapshot replays that request.
    if (!cached) return;
    cached.eventRevision++;
    if (frame.id !== undefined && frame.method && frame.method !== 'event') {
      const prompt = promptView(frame.id, frame.method, p);
      if (!prompt) { void this.socket.answer(frame.id).catch(() => {}); return; }
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
        // A start event can belong to the existing turn while a queue RPC is in flight.
        // Authoritative resume snapshots settle acknowledged queues.
        void db.update(remoteHermesSessions).set({ status: 'running', revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, cached.row.id)).catch(() => { cached.view.uncertain = true; });
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
        cached.view.running = !!cached.view.queued || !!cached.row.queueRequestId;
        cached.view.uncertain = cached.row.queueStatus === 'uncertain';
        cached.pending.clear(); cached.view.prompts = [];
        // Terminal notification settles the admitted turn even if its acknowledgement was lost.
        if (cached.row.status !== 'admitting') cached.row.status = cached.view.running ? 'running' : 'idle';
        void db.update(remoteHermesSessions).set({ status: sql`case when ${remoteHermesSessions.queueRequestId} is null then 'idle' else 'running' end`, admissionRequestId: null, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
          .where(and(eq(remoteHermesSessions.id, cached.row.id), ne(remoteHermesSessions.status, 'admitting')))
          .then(() => this.refresh(cached.row)).catch(() => { cached.view.uncertain = true; });
        break;
      case 'session.info':
        if (typeof payload.yolo === 'boolean') cached.view.yolo = payload.yolo;
        if (['manual', 'smart', 'off'].includes(String(payload.approval_mode))) cached.view.approvalMode = String(payload.approval_mode);
        if (typeof payload.model === 'string') cached.view.model = payload.model;
        if (typeof payload.provider === 'string') cached.view.provider = payload.provider;
        if (typeof payload.stored_session_id === 'string' && payload.stored_session_id && payload.stored_session_id !== cached.row.storedId) {
          cached.row.storedId = payload.stored_session_id;
          void db.update(remoteHermesSessions).set({ storedId: payload.stored_session_id, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, cached.row.id)).catch(() => { cached.view.uncertain = true; });
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
    else await this.socket.answer(pending.nativeId, result);
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
