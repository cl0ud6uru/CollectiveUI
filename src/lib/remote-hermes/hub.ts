import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HttpError } from '@/lib/authz';
import { db, type DbOrTx, type Tx } from '@/db';
import { remoteHermesConnections, remoteHermesHubOwners, remoteHermesRecoveries, remoteHermesSessions, settings } from '@/db/schema';
import { remoteRecoveryFenceActive } from '@/db/remote-hermes-recovery-schema';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { ClientOptions } from 'ws';
import type { RequestOptions } from 'node:http';
import { getSetting, type RemoteHermesSettings } from '@/lib/settings';
import { isPrivateAddress } from '@/lib/agent/tools/web';
import { registerNativeConnection } from './lifecycle';
import { remoteAccess } from './store';
import { dashboardAddress, privateHttpTransportTrusted } from './transport';
import { websocketAuthentication } from './websocket-auth';
import { DashboardSocket, record, type NativeFrame, type RpcRecord } from './socket';
import { promptView, sessionView, answerFor, type NativeSessionView, type NativePrompt } from './view';
import { HUB_OWNER_LEASE_MS, NATIVE_HUB_OWNER_PROTOCOL, PORTAL_HUB_OWNERSHIP_PROTOCOL, type NativeHubFence, type RemoteHubOwnershipSnapshot } from './ownership';
import { recoveryBinding, recoveryOwnership } from './recovery-contract';

type Session = typeof remoteHermesSessions.$inferSelect;
type PendingPrompt = { nativeId: string | number; prompt: NativePrompt; params: RpcRecord; socketEpoch: number };
type Cached = { row: Session; view: NativeSessionView; pending: Map<string, PendingPrompt>; refreshedAt: number; eventRevision: number; socketEpoch: number; ownerInstanceId: string; leaseGeneration: number; ownerSocketEpoch: number };
const processInstanceId = randomUUID();
export class NativeHub {
  readonly changes = new EventEmitter();
  readonly socket: DashboardSocket;
  readonly sessions = new Map<string, Cached>();
  private refreshing = new Map<string, Promise<NativeSessionView>>();
  private idle?: NodeJS.Timeout;
  private pinned?: { baseUrl: string; address: string };
  private retired = false;
  private nativeCapability?: { socketEpoch: number; supported: boolean };
  private readonly nativeFences = new Map<string, NativeHubFence>();
  private ownershipSocketEpoch = 0;
  private unregister: () => void;
  constructor(readonly ownerId: string, readonly connectionId: string, readonly instanceId = processInstanceId) {
    this.unregister = registerNativeConnection(ownerId, connectionId, () => this.close());
    this.socket = new DashboardSocket(async () => {
      const target = await remoteAccess(ownerId, connectionId, 'continuation');
      const address = await dashboardAddress(target.baseUrl, target.policy);
      this.pinned = { baseUrl: target.baseUrl, address: address.address };
      const url = new URL(target.baseUrl + '/api/ws');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const auth = websocketAuthentication(url, target.secrets,
        target.secrets.mode === 'password' ? await target.client.websocketTicket() : undefined);
      const options: ClientOptions & Pick<RequestOptions, 'lookup'> = { family: address.family, lookup: (_host, _opts, callback) => callback(null, address.address, address.family) };
      return { ...auth, options };
    }, (frame, socketEpoch) => this.onFrame(frame, socketEpoch), state => {
      for (const cached of this.sessions.values()) { cached.view.connection = state; this.changes.emit(cached.row.id); }
    }, async () => {
      for (const cached of this.sessions.values()) {
        if (await remoteRecoveryFenceActive(db, cached.row.id)) { cached.view.uncertain = true; this.changes.emit(cached.row.id); continue; }
        if (!(await getSetting('remoteHermes')).enabled && cached.row.status === 'idle') continue;
        try { await this.refresh(cached.row); } catch { cached.view.uncertain = true; }
      }
    }, async () => {}, (method, params, dispatch, tx) => this.dispatchBoundary(method, params, dispatch, tx),
      (method, params, tx) => this.prepareOwnership(method, params, tx));
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
  async lockBoundary(tx: Tx, allowTakeover = false) {
    await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
    const connection = await this.assertIdentity(tx, true);
    await this.ensureLease(tx, allowTakeover);
    return connection;
  }
  /** The synchronous send/cache selection is the linearization point. Returning
   * an envelope prevents transaction() from awaiting a remote acknowledgement. */
  private async dispatchBoundary<T>(method: string, params: RpcRecord, dispatch: () => T, tx?: Tx): Promise<{ value: T }> {
    const run = async (q: Tx) => {
      // Authenticated, read-only negotiation must precede lease election. A new
      // process cannot prove native takeover support until this handshake ends.
      const discovery = method === 'client.capabilities' || method === 'collective.hub_owner.capabilities';
      if (discovery) await q.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
      const connection = discovery ? await this.assertIdentity(q, true) : await this.lockBoundary(q);
      if (method === 'collective.hub_owner.claim') await this.assertCurrentLease(q);
      if (method === 'session.resume') {
        const [session] = await q.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, this.connectionId),
          eq(remoteHermesSessions.profile, String(params.profile ?? '')), eq(remoteHermesSessions.storedId, String(params.session_id ?? '')))).for('share');
        if (session && await remoteRecoveryFenceActive(q, session.id)) {
          const cached = this.sessions.get(session.id);
          if (cached) cached.view.uncertain = true;
          throw new HttpError(409, 'Native recovery is in progress. Resume is fenced until its receipt is verified.');
        }
      }
      await this.assertNoPendingRecovery(q, method, params);
      if (method.startsWith('collective.recovery.') && method !== 'collective.recovery.capabilities')
        await this.assertRecoveryDispatch(q, method, params);
      await this.authorize(method, params, connection, await getSetting('remoteHermes', q), q);
      if (this.retired) throw new HttpError(409, 'This Hermes sign-in was replaced.');
      return { value: dispatch() };
    };
    return tx ? run(tx) : db.transaction(run);
  }
  private async assertNoPendingRecovery(q: Tx, method: string, params: RpcRecord) {
    if (method.startsWith('collective.') || ['ping', 'client.capabilities', '$answer'].includes(method)) {
      if (method !== '$answer') return;
    }
    if (method.startsWith('collective.recovery.')) return;
    let sessions: Session[] = [];
    if (method === 'session.create' && typeof params.profile === 'string') {
      sessions = await q.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, this.connectionId),
        eq(remoteHermesSessions.profile, params.profile))).for('share');
    } else if (method === '$answer') {
      const cached = [...this.sessions.values()].find(item => [...item.pending.values()].some(pending => pending.nativeId === params.id));
      if (cached) sessions = [cached.row];
    } else if (typeof params.profile === 'string' && typeof params.session_id === 'string') {
      const identity = method === 'session.resume' ? eq(remoteHermesSessions.storedId, params.session_id)
        : or(eq(remoteHermesSessions.runtimeId, params.session_id), eq(remoteHermesSessions.storedId, params.session_id));
      sessions = await q.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, this.connectionId),
        eq(remoteHermesSessions.profile, params.profile), identity)).for('share');
    }
    for (const session of sessions) if (await remoteRecoveryFenceActive(q, session.id)) {
      const cached = this.sessions.get(session.id);
      if (cached) cached.view.uncertain = true;
      throw new HttpError(409, 'Native recovery is in progress. Ordinary session operations are fenced until its receipt is verified.');
    }
  }
  private async assertRecoveryDispatch(q: Tx, method: string, params: RpcRecord) {
    const recoveryId = typeof params.recovery_id === 'string' ? params.recovery_id : '';
    const [intent] = recoveryId ? await q.select().from(remoteHermesRecoveries).where(and(eq(remoteHermesRecoveries.id, recoveryId),
      eq(remoteHermesRecoveries.ownerId, this.ownerId), eq(remoteHermesRecoveries.connectionId, this.connectionId),
      sql`${remoteHermesRecoveries.state} in ('pending','uncertain')`)).for('share') : [];
    if (!intent) throw new HttpError(409, 'No matching confirmed native recovery is active.');
    const binding = recoveryBinding.safeParse(intent.binding);
    const claimed = recoveryOwnership.safeParse(intent.claimedOwnership);
    if (!binding.success || !claimed.success || !claimed.data.nativeFence || claimed.data.nativeFence.phase !== 'recovery' ||
        claimed.data.nativeFence.recoveryId !== intent.id || claimed.data.connectionId !== this.connectionId || claimed.data.ownerId !== this.ownerId)
      throw new HttpError(409, 'The confirmed recovery has no exact native recovery ownership proof.');
    const ownership = claimed.data;
    const nativeFence = ownership.nativeFence!;
    const [session] = await q.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, intent.sessionId)).for('share');
    const lease = await this.assertCurrentLease(q);
    const fence = this.nativeFences.get(ownership.profile);
    if (!session || session.connectionId !== this.connectionId || session.profile !== ownership.profile ||
        lease.ownerInstanceId !== ownership.instanceId || Number(lease.generation) !== ownership.leaseGeneration ||
        Number(lease.socketEpoch) !== ownership.portalSocketEpoch || fence?.nativeGeneration !== nativeFence.nativeGeneration ||
        fence?.phase !== 'recovery' || fence.recoveryId !== intent.id || this.socket.connectionEpoch !== ownership.socketEpoch)
      throw new HttpError(409, 'The native recovery ownership changed. Read its receipt before continuing.');
    await this.assertNativeOwnership(ownership);
    if (method === 'collective.recovery.status') return;
    if (method !== 'collective.recovery.cancel_and_drain') throw new HttpError(403, 'This native recovery operation is not supported.');
    const expectedReservations = [binding.data.admissionRequestId, binding.data.queueRequestId].filter((value): value is string => !!value).sort();
    const actualReservations = Array.isArray(params.reservation_ids) && params.reservation_ids.every(v => typeof v === 'string')
      ? [...params.reservation_ids as string[]].sort() : [];
    if (params.profile !== ownership.profile || params.session_id !== ownership.runtimeId || params.stored_session_id !== ownership.storedId ||
        JSON.stringify(actualReservations) !== JSON.stringify(expectedReservations))
      throw new HttpError(409, 'The native recovery request does not match its confirmed session and reservations.');
  }
  private async ensureLease(q: Tx, allowTakeover: boolean) {
    const now = new Date();
    const expires = new Date(now.getTime() + HUB_OWNER_LEASE_MS);
    const [lease] = await q.select().from(remoteHermesHubOwners).where(eq(remoteHermesHubOwners.connectionId, this.connectionId)).for('update');
    if (!lease) {
      const [created] = await q.insert(remoteHermesHubOwners).values({ connectionId: this.connectionId, ownerInstanceId: this.instanceId,
        generation: 1, leaseExpiresAt: expires, socketEpoch: this.socket.connectionEpoch > 0 ? 1 : 0 }).returning();
      this.ownershipSocketEpoch = this.socket.connectionEpoch;
      return created;
    }
    if (lease.ownerInstanceId !== this.instanceId) {
      if (lease.leaseExpiresAt.getTime() > now.getTime() || !allowTakeover)
        throw new HttpError(409, 'Another portal instance owns this Hermes socket. Reconnect after its native owner fence is available.');
      const [claimed] = await q.update(remoteHermesHubOwners).set({ ownerInstanceId: this.instanceId, generation: sql`${remoteHermesHubOwners.generation} + 1`,
        leaseExpiresAt: expires, socketEpoch: sql`${remoteHermesHubOwners.socketEpoch} + 1`, nativeProtocol: null, nativeGeneration: null,
        nativeSocketEpoch: null, updatedAt: now }).where(and(eq(remoteHermesHubOwners.connectionId, this.connectionId), eq(remoteHermesHubOwners.ownerInstanceId, lease.ownerInstanceId), eq(remoteHermesHubOwners.generation, lease.generation))).returning();
      if (!claimed) throw new HttpError(409, 'Hermes ownership changed while reconnecting. Refresh before continuing.');
      this.ownershipSocketEpoch = this.socket.connectionEpoch;
      this.nativeFences.clear();
      return claimed;
    }
    const socketChanged = this.socket.connectionEpoch > 0 && this.ownershipSocketEpoch !== this.socket.connectionEpoch;
    const [renewed] = await q.update(remoteHermesHubOwners).set({ leaseExpiresAt: expires,
      ...(socketChanged ? { socketEpoch: sql`${remoteHermesHubOwners.socketEpoch} + 1`, nativeProtocol: null, nativeGeneration: null, nativeSocketEpoch: null } : {}),
      updatedAt: now }).where(and(eq(remoteHermesHubOwners.connectionId, this.connectionId), eq(remoteHermesHubOwners.ownerInstanceId, this.instanceId), eq(remoteHermesHubOwners.generation, lease.generation))).returning();
    if (!renewed) throw new HttpError(409, 'Hermes ownership changed. Refresh before continuing.');
    if (socketChanged) { this.ownershipSocketEpoch = this.socket.connectionEpoch; this.nativeFences.clear(); }
    return renewed;
  }
  private async assertCurrentLease(q: Tx) {
    const [lease] = await q.select().from(remoteHermesHubOwners).where(eq(remoteHermesHubOwners.connectionId, this.connectionId)).for('share');
    if (!lease || lease.ownerInstanceId !== this.instanceId || lease.leaseExpiresAt.getTime() <= Date.now())
      throw new HttpError(409, 'This Hermes socket no longer owns the native session. Refresh before continuing.');
    return lease;
  }
  private async prepareOwnership(method: string, params: RpcRecord, tx?: Tx) {
    if (['client.capabilities', 'ping', 'collective.hub_owner.capabilities', 'collective.hub_owner.current', 'collective.hub_owner.claim'].includes(method) ||
        method.startsWith('collective.recovery.')) return;
    const answerCached = method === '$answer' ? [...this.sessions.values()].find(c => [...c.pending.values()].some(p => p.nativeId === params.id)) : undefined;
    const profile = typeof params.profile === 'string' ? params.profile : answerCached?.row.profile;
    if (!profile) return;
    const stored = method === 'session.resume' ? params.session_id : undefined;
    const runtime = typeof params.session_id === 'string' ? params.session_id : undefined;
    const q = tx ?? db;
    const [bound] = answerCached ? [answerCached.row] : stored || runtime ? await q.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, this.connectionId), eq(remoteHermesSessions.profile, profile), stored ? eq(remoteHermesSessions.storedId, String(stored)) : or(eq(remoteHermesSessions.runtimeId, String(runtime)), eq(remoteHermesSessions.storedId, String(runtime))))).limit(1) : [];
    // Native ownership is profile-scoped even before a portal session exists:
    // projects, schedules and plugins use the same execution fence as sessions.
    const profileSessions = bound ? [bound] : await q.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, this.connectionId), eq(remoteHermesSessions.profile, profile)));
    for (const session of profileSessions) if (await remoteRecoveryFenceActive(q, session.id))
      throw new HttpError(409, 'Native recovery is in progress for this profile. Ordinary session ownership cannot be promoted.');
    if (tx) {
      // The caller may already hold owner/session locks and the only pool slot.
      // Its verified snapshot must have prepared ownership before this transaction;
      // validate that proof here without starting another transaction or native claim.
      const lease = await this.assertCurrentLease(tx);
      if (this.nativeCapability?.socketEpoch !== this.socket.connectionEpoch)
        throw new HttpError(409, 'Refresh the native session before confirming this operation. Ownership has not been prepared.');
      if (!this.nativeCapability.supported) return;
      const fence = this.nativeFences.get(profile);
      if (!fence || fence.generation !== Number(lease.generation) || fence.socketEpoch !== Number(lease.socketEpoch) ||
          fence.nativeGeneration < 1 || fence.phase !== 'full' || fence.recoveryId !== null ||
          fence.recoverySessionId !== null || fence.recoveryStoredSessionId !== null)
        throw new HttpError(409, 'Refresh the native session before confirming this operation. Its full ownership fence changed.');
      return;
    }
    const nativeSupported = await this.nativeOwnerSupported();
    const [lease] = await db.transaction(async tx => {
      await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
      await this.assertIdentity(tx, true);
      return [await this.ensureLease(tx, nativeSupported)];
    });
    if (!nativeSupported) return; // Existing single owner remains usable; takeover stays fail-closed.
    await this.claimNativeFence(profile, lease, 'full');
  }
  private async claimNativeFence(profile: string, lease: typeof remoteHermesHubOwners.$inferSelect,
    phase: 'full' | 'recovery', recovery?: { id: string; sessionId: string; storedSessionId: string }, expectedSocketEpoch = this.socket.connectionEpoch) {
    const socketEpoch = Number(lease.socketEpoch);
    const cachedFence = this.nativeFences.get(profile);
    if (cachedFence?.generation === Number(lease.generation) && cachedFence.socketEpoch === socketEpoch && cachedFence.nativeGeneration > 0 &&
        cachedFence.phase === phase && cachedFence.recoveryId === (recovery?.id ?? null) &&
        cachedFence.recoverySessionId === (recovery?.sessionId ?? null) && cachedFence.recoveryStoredSessionId === (recovery?.storedSessionId ?? null)) return cachedFence;
    const current = await this.socket.callConnected('collective.hub_owner.current', { profile }, expectedSocketEpoch);
    const expectedNativeGeneration = Number(record(current).native_generation);
    if (!Number.isSafeInteger(expectedNativeGeneration) || expectedNativeGeneration < 0)
      throw new HttpError(503, 'Hermes did not return a valid durable owner generation. No session operation was sent.');
    const ownerMatches = record(current).portal_connection_id === this.connectionId && record(current).portal_instance_id === this.instanceId &&
      Number(record(current).portal_generation) === Number(lease.generation) && Number(record(current).portal_socket_epoch) === socketEpoch &&
      record(current).phase === phase && record(current).recovery_id === (recovery?.id ?? null) &&
      record(current).recovery_session_id === (recovery?.sessionId ?? null) &&
      record(current).recovery_stored_session_id === (recovery?.storedSessionId ?? null) && record(current).transport_bound === true;
    if (ownerMatches) {
      const retainedGeneration = expectedNativeGeneration;
      if (retainedGeneration < 1) throw new HttpError(503, 'Hermes returned an invalid retained native ownership generation.');
      return this.persistNativeFence(profile, lease, { protocol: NATIVE_HUB_OWNER_PROTOCOL, generation: Number(lease.generation),
        socketEpoch, nativeGeneration: retainedGeneration, phase, recoveryId: recovery?.id ?? null,
        recoverySessionId: recovery?.sessionId ?? null, recoveryStoredSessionId: recovery?.storedSessionId ?? null });
    }
    const result = await this.socket.callConnected('collective.hub_owner.claim', {
      portal_connection_id: this.connectionId, profile, portal_generation: Number(lease.generation),
      portal_socket_epoch: socketEpoch, portal_instance_id: this.instanceId, expected_native_generation: expectedNativeGeneration,
      phase, recovery_id: recovery?.id, recovery_session_id: recovery?.sessionId,
      recovery_stored_session_id: recovery?.storedSessionId,
    }, expectedSocketEpoch);
    const nativeGeneration = Number(record(result).native_generation);
    if (record(result).accepted !== true || record(result).protocol !== NATIVE_HUB_OWNER_PROTOCOL ||
        record(result).portal_connection_id !== this.connectionId || record(result).profile !== profile ||
        record(result).portal_instance_id !== this.instanceId || record(result).portal_generation !== Number(lease.generation) ||
        record(result).portal_socket_epoch !== socketEpoch || record(result).phase !== phase ||
        record(result).recovery_id !== (recovery?.id ?? null) || record(result).recovery_session_id !== (recovery?.sessionId ?? null) ||
        record(result).recovery_stored_session_id !== (recovery?.storedSessionId ?? null) || !Number.isSafeInteger(nativeGeneration) ||
        !((nativeGeneration === expectedNativeGeneration + 1) || (nativeGeneration === expectedNativeGeneration && record(result).transport_bound === true)) ||
        record(result).transport_bound !== true || record(result).durable !== true) {
      throw new HttpError(503, 'Hermes did not confirm the durable native ownership fence. No session operation was sent.');
    }
    const fence: NativeHubFence = { protocol: NATIVE_HUB_OWNER_PROTOCOL, generation: Number(lease.generation), socketEpoch, nativeGeneration,
      phase, recoveryId: recovery?.id ?? null, recoverySessionId: recovery?.sessionId ?? null,
      recoveryStoredSessionId: recovery?.storedSessionId ?? null };
    return this.persistNativeFence(profile, lease, fence);
  }
  private async persistNativeFence(profile: string, lease: typeof remoteHermesHubOwners.$inferSelect, fence: NativeHubFence) {
    const saved = await db.transaction(async tx => {
      await this.assertIdentity(tx, true);
      const [updated] = await tx.update(remoteHermesHubOwners).set({ nativeProtocol: fence.protocol, nativeGeneration: fence.nativeGeneration,
        nativeSocketEpoch: fence.socketEpoch, updatedAt: new Date() }).where(and(eq(remoteHermesHubOwners.connectionId, this.connectionId),
          eq(remoteHermesHubOwners.ownerInstanceId, this.instanceId), eq(remoteHermesHubOwners.generation, fence.generation), eq(remoteHermesHubOwners.socketEpoch, fence.socketEpoch))).returning();
      return updated;
    });
    if (!saved) throw new HttpError(409, 'Hermes ownership changed after native fencing. Refresh before continuing.');
    this.nativeFences.set(profile, fence);
    return fence;
  }
  private async nativeOwnerSupported() {
    const socketEpoch = this.socket.connectionEpoch;
    if (this.nativeCapability?.socketEpoch === socketEpoch) return this.nativeCapability.supported;
    try {
      const response = await this.socket.call('collective.hub_owner.capabilities', {});
      const supported = record(response).protocol === NATIVE_HUB_OWNER_PROTOCOL && record(response).durable === true &&
        record(response).scope === 'profile_dispatch_and_server_request_answers' && record(response).atomic_execution_fence === true;
      this.nativeCapability = { socketEpoch, supported };
      return supported;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 501) throw error;
      this.nativeCapability = { socketEpoch, supported: false };
      return false;
    }
  }
  async captureOwnership(row: Session, allowNativeTakeover = false): Promise<RemoteHubOwnershipSnapshot> {
    return db.transaction(async tx => {
      await this.lockBoundary(tx, allowNativeTakeover);
      const lease = await this.assertCurrentLease(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('share');
      if (!current || current.connectionId !== this.connectionId || current.profile !== row.profile) throw new HttpError(404, 'Native Hermes chat not found.');
      if (current.storedId !== row.storedId || current.runtimeId !== row.runtimeId || current.revision !== row.revision ||
          Number(current.ownershipGeneration) !== Number(row.ownershipGeneration))
        throw new HttpError(409, 'The native Hermes session changed before its recovery review. Refresh before continuing.');
      const candidateFence = this.nativeFences.get(row.profile) ?? null;
      const fence = candidateFence && candidateFence.generation === Number(lease.generation) && candidateFence.socketEpoch === Number(lease.socketEpoch) ? candidateFence : null;
      return Object.freeze({ protocol: PORTAL_HUB_OWNERSHIP_PROTOCOL, ownerId: this.ownerId, connectionId: this.connectionId,
        instanceId: this.instanceId, leaseGeneration: Number(lease.generation), sessionId: current.id, profile: current.profile,
        storedId: current.storedId, runtimeId: current.runtimeId, sessionRevision: current.revision,
        ownershipGeneration: Number(current.ownershipGeneration), socketEpoch: this.socket.connectionEpoch,
        portalSocketEpoch: Number(lease.socketEpoch), nativeFence: fence });
    });
  }
  /** Prepare an immutable recovery candidate without changing native ownership or resuming a runtime. */
  async prepareRecoveryOwnership(row: Session): Promise<RemoteHubOwnershipSnapshot> {
    if (!row.runtimeId) throw new HttpError(409, 'This Hermes session has no verified runtime identity for recovery.');
    if (await remoteRecoveryFenceActive(db, row.id)) throw new HttpError(409, 'A confirmed native recovery already owns this session. Check its saved receipt.');
    // Connecting is only the WebSocket handshake and capability negotiation. Its usual
    // reconnect callback refreshes sessions (and would issue session.resume), so suppress
    // that callback for this candidate connection until the recovery intent is confirmed.
    await this.socket.connect({ suppressReconnectCallback: true });
    const socketEpoch = this.socket.connectionEpoch;
    if (this.socket.state !== 'connected' || !socketEpoch) throw new HttpError(409, 'Reconnect before reviewing native recovery. No recovery request was sent.');
    const capability = await this.socket.callConnected('collective.hub_owner.capabilities', {}, socketEpoch);
    const supported = record(capability).protocol === NATIVE_HUB_OWNER_PROTOCOL && record(capability).durable === true &&
      record(capability).scope === 'profile_dispatch_and_server_request_answers' && record(capability).atomic_execution_fence === true;
    if (!supported) throw new HttpError(503, 'This Hermes runtime does not provide the pinned native ownership capability. Recovery is unavailable.');
    this.nativeCapability = { socketEpoch, supported: true };
    return this.captureOwnership(row, true);
  }
  /** Called only after the durable recovery intent is committed and the owner confirmed the exact action. */
  async claimRecoveryOwnership(candidate: RemoteHubOwnershipSnapshot, recoveryId: string): Promise<RemoteHubOwnershipSnapshot> {
    if (!candidate.runtimeId || !recoveryId || candidate.connectionId !== this.connectionId || candidate.ownerId !== this.ownerId || candidate.instanceId !== this.instanceId)
      throw new HttpError(409, 'Recovery requires the exact captured runtime, connection, and recovery identity.');
    let lease!: typeof remoteHermesHubOwners.$inferSelect;
    const snapshot = await db.transaction(async tx => {
      await this.lockBoundary(tx);
      lease = await this.assertCurrentLease(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, candidate.sessionId)).for('share');
      if (!current || current.connectionId !== candidate.connectionId || current.profile !== candidate.profile || current.storedId !== candidate.storedId ||
          current.runtimeId !== candidate.runtimeId || current.revision !== candidate.sessionRevision || Number(current.ownershipGeneration) !== candidate.ownershipGeneration ||
          Number(lease.generation) !== candidate.leaseGeneration || Number(lease.socketEpoch) !== candidate.portalSocketEpoch ||
          this.socket.connectionEpoch !== candidate.socketEpoch)
        throw new HttpError(409, 'The native Hermes session changed after recovery confirmation. Prepare again.');
      return Object.freeze({ protocol: PORTAL_HUB_OWNERSHIP_PROTOCOL, ownerId: this.ownerId, connectionId: this.connectionId,
        instanceId: this.instanceId, leaseGeneration: Number(lease.generation), sessionId: current.id, profile: current.profile,
        storedId: current.storedId, runtimeId: current.runtimeId, sessionRevision: current.revision,
        ownershipGeneration: Number(current.ownershipGeneration), socketEpoch: this.socket.connectionEpoch,
        portalSocketEpoch: Number(lease.socketEpoch), nativeFence: null });
    });
    const nativeFence = await this.claimNativeFence(snapshot.profile, lease, 'recovery', {
      id: recoveryId, sessionId: snapshot.runtimeId!, storedSessionId: snapshot.storedId,
    }, snapshot.socketEpoch);
    const [current] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, candidate.sessionId));
    if (!current || current.runtimeId !== snapshot.runtimeId || current.revision !== snapshot.sessionRevision ||
        Number(current.ownershipGeneration) !== snapshot.ownershipGeneration)
      throw new HttpError(409, 'The session changed after recovery was fenced. Keep the receipt and request a new owner review.');
    return Object.freeze({ ...snapshot, nativeFence });
  }
  /** Promote recovery-only ownership after native status proves the exact receipt drained. */
  async completeRecoveryOwnership(snapshot: RemoteHubOwnershipSnapshot, recoveryId: string): Promise<RemoteHubOwnershipSnapshot> {
    if (!snapshot.nativeFence || snapshot.nativeFence.phase !== 'recovery' || snapshot.nativeFence.recoveryId !== recoveryId ||
        snapshot.nativeFence.recoverySessionId !== snapshot.runtimeId || snapshot.nativeFence.recoveryStoredSessionId !== snapshot.storedId)
      throw new HttpError(409, 'This native recovery receipt does not match the captured ownership.');
    let lease!: typeof remoteHermesHubOwners.$inferSelect;
    await db.transaction(async tx => {
      await this.lockBoundary(tx);
      // A prior attempt may have verified the full claim but lost its result
      // before the recovery receipt was committed. Retain only that exact next
      // generation and recovery tuple; never accept another claim as a retry.
      const retained = this.nativeFences.get(snapshot.profile);
      const promoted = retained?.phase === 'full' && retained.nativeGeneration === snapshot.nativeFence!.nativeGeneration + 1 &&
        retained.recoveryId === recoveryId && retained.recoverySessionId === snapshot.runtimeId && retained.recoveryStoredSessionId === snapshot.storedId;
      await this.assertCurrentOwnership(tx, promoted ? { ...snapshot, nativeFence: retained } : snapshot);
      lease = await this.assertCurrentLease(tx);
    });
    const nativeFence = await this.claimNativeFence(snapshot.profile, lease, 'full', {
      id: recoveryId, sessionId: snapshot.runtimeId!, storedSessionId: snapshot.storedId,
    }, snapshot.socketEpoch);
    const [current] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, snapshot.sessionId));
    if (!current || current.runtimeId !== snapshot.runtimeId || current.revision !== snapshot.sessionRevision ||
        Number(current.ownershipGeneration) !== snapshot.ownershipGeneration)
      throw new HttpError(409, 'The session changed during ownership promotion. Keep the receipt and request a new owner review.');
    return Object.freeze({ ...snapshot, nativeFence });
  }
  async assertCurrentOwnership(tx: Tx, snapshot: RemoteHubOwnershipSnapshot) {
    if (snapshot.protocol !== PORTAL_HUB_OWNERSHIP_PROTOCOL || snapshot.ownerId !== this.ownerId || snapshot.connectionId !== this.connectionId || snapshot.instanceId !== this.instanceId)
      throw new HttpError(409, 'The native Hermes owner changed. Confirm the operation again.');
    const lease = await this.assertCurrentLease(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, snapshot.sessionId)).for('share');
    if (Number(lease.generation) !== snapshot.leaseGeneration || Number(lease.socketEpoch) !== snapshot.portalSocketEpoch ||
        current?.connectionId !== snapshot.connectionId || current.profile !== snapshot.profile || current.storedId !== snapshot.storedId ||
        current.runtimeId !== snapshot.runtimeId || current.revision !== snapshot.sessionRevision || Number(current.ownershipGeneration) !== snapshot.ownershipGeneration ||
        this.socket.connectionEpoch !== snapshot.socketEpoch)
      throw new HttpError(409, 'The native Hermes session changed. Confirm the operation again.');
    // The lease elects this connection's process/socket; its last native claim
    // columns cannot represent every profile. Validate the profile's exact
    // verified claim, which native dispatch rechecks against its durable row.
    if (snapshot.nativeFence) await this.assertNativeOwnership(snapshot);
    return current;
  }
  async assertNativeOwnership(snapshot: RemoteHubOwnershipSnapshot) {
    const current = this.nativeFences.get(snapshot.profile);
    if (!snapshot.nativeFence || snapshot.nativeFence.protocol !== NATIVE_HUB_OWNER_PROTOCOL || snapshot.nativeFence.generation !== snapshot.leaseGeneration ||
        snapshot.nativeFence.socketEpoch !== snapshot.portalSocketEpoch || !snapshot.nativeFence.nativeGeneration || current?.generation !== snapshot.leaseGeneration ||
        current.socketEpoch !== snapshot.portalSocketEpoch || current.nativeGeneration !== snapshot.nativeFence.nativeGeneration ||
        current.protocol !== snapshot.nativeFence.protocol || current.phase !== snapshot.nativeFence.phase || current.recoveryId !== snapshot.nativeFence.recoveryId ||
        current.recoverySessionId !== snapshot.nativeFence.recoverySessionId || current.recoveryStoredSessionId !== snapshot.nativeFence.recoveryStoredSessionId)
      throw new HttpError(409, 'This Hermes runtime does not confirm a durable owner fence. Cross-instance recovery is unavailable.');
    return snapshot.nativeFence;
  }
  async invalidateRecoveredSession(sessionId: string, snapshot: RemoteHubOwnershipSnapshot) {
    const inFlight = this.refreshing.get(sessionId);
    if (inFlight) await inFlight.catch(() => {});
    const [current] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId));
    if (!current || current.id !== snapshot.sessionId || current.runtimeId !== null || Number(current.ownershipGeneration) !== snapshot.ownershipGeneration + 1)
      throw new HttpError(409, 'The native recovery did not advance the saved session generation. Refresh before continuing.');
    this.sessions.delete(sessionId);
  }
  /** Check durable identity and current policy inside the dispatch boundary. */
  private async authorize(method: string, params: RpcRecord, connection: typeof remoteHermesConnections.$inferSelect, policy: RemoteHermesSettings, q: DbOrTx) {
    // A live socket remains pinned to its admitted address; new upgrades still
    // use dashboardAddress and cannot reconnect to a revoked private destination.
    const address = this.pinned?.baseUrl === connection.baseUrl ? this.pinned :
      { baseUrl: connection.baseUrl, ...(await dashboardAddress(connection.baseUrl, policy)) };
    const revoked = isPrivateAddress(address.address) && (!policy.privateGateways.includes(connection.baseUrl) ||
      !privateHttpTransportTrusted(connection.baseUrl, address.address, policy));
    if (method === 'collective.recovery.capabilities' && this.socket.state === 'connected') return;
    if (method === 'collective.recovery.status' || method === 'collective.recovery.cancel_and_drain') {
      // assertRecoveryDispatch has already matched the exact durable owner proof and
      // confirmed intent. These read/drain methods are the only policy-revocation grace.
      return;
    }
    if (policy.enabled && !revoked) return;
    // Only an already admitted, durable binding can recover on the old socket.
    // No steering, uploads, queues, commands, setters or inspection are exempt.
    const rows = await q.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.connectionId, this.connectionId));
    const active = rows.filter(row => row.status !== 'idle' || row.queueRequestId);
    if ((method === 'ping' || (method === 'client.capabilities' && !revoked)) && active.length) return;
    if (method === 'collective.hub_owner.capabilities' && active.length && this.socket.state === 'connected') return;
    if (method === 'collective.hub_owner.current' && this.socket.state === 'connected' && active.some(row => row.profile === params.profile)) return;
    if (method === 'collective.hub_owner.claim' && params.phase === 'recovery' && this.socket.state === 'connected' &&
        active.some(row => row.profile === params.profile && row.runtimeId === params.recovery_session_id && row.storedId === params.recovery_stored_session_id)) return;
    if (method === 'collective.hub_owner.claim' && params.phase === 'full' && this.socket.state === 'connected' && typeof params.recovery_id === 'string') {
      const [intent] = await q.select().from(remoteHermesRecoveries).where(and(eq(remoteHermesRecoveries.id, params.recovery_id),
        eq(remoteHermesRecoveries.ownerId, this.ownerId), eq(remoteHermesRecoveries.connectionId, this.connectionId),
        sql`${remoteHermesRecoveries.state} in ('pending','uncertain')`)).limit(1);
      const binding = intent && recoveryBinding.safeParse(intent.binding);
      const claimed = intent && recoveryOwnership.safeParse(intent.claimedOwnership);
      if (intent?.nativeRequestedAt && intent.receipt?.state === 'drained' && intent.receipt.reason === 'drained' &&
          binding?.success && claimed?.success && claimed.data.nativeFence?.phase === 'recovery' &&
          claimed.data.nativeFence.recoveryId === intent.id && binding.data.ownership.profile === params.profile &&
          binding.data.ownership.runtimeId === params.recovery_session_id && binding.data.ownership.storedId === params.recovery_stored_session_id)
        return;
    }
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
    if (await remoteRecoveryFenceActive(db, row.id)) {
      const cached = this.sessions.get(row.id);
      if (cached) { cached.view.uncertain = true; return cached.view; }
      throw new HttpError(409, 'Native recovery is in progress. Check its saved receipt before refreshing this conversation.');
    }
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
  /** Called after a control RPC settles: older snapshots cannot reconcile it. */
  async refreshAfterPending(row: Session): Promise<NativeSessionView> {
    // Drain, rather than replace, the single-flight slot. A superseded resume
    // must finish its cache/DB writes before the post-control snapshot begins.
    while (this.refreshing.has(row.id)) {
      try { await this.refreshing.get(row.id); } catch { /* Still require a fresh snapshot after an older failure. */ }
    }
    return this.refresh(row);
  }
  private async refreshInner(row: Session) {
    const [observed] = await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id));
    if (!observed) throw new HttpError(404, 'Native Hermes chat not found.');
    row = observed;
    const eventRevision = this.sessions.get(row.id)?.eventRevision ?? 0;
    const { result: snapshot, epoch: socketEpoch } = await this.socket.callWithEpoch('session.resume', { session_id: row.storedId, profile: row.profile, cols: 80, close_on_disconnect: false });
    await this.assertIdentity();
    const runtimeId = typeof snapshot.session_id === 'string' ? snapshot.session_id : '';
    const storedId = typeof snapshot.stored_session_id === 'string' ? snapshot.stored_session_id : row.storedId;
    if (!runtimeId) throw new HttpError(502, 'Hermes did not return a native session identity.');
    const view = sessionView(row.id, row.profile, snapshot, this.socket.state);
    const pending = new Map<string, PendingPrompt>();
    for (const raw of Array.isArray(snapshot.open_requests) ? snapshot.open_requests : []) {
      const request = record(raw);
      if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') continue;
      if (record(request.params).session_id !== runtimeId) continue;
      const prompt = promptView(request.id, request.method, request.params);
      if (prompt) pending.set(prompt.id, { nativeId: request.id, prompt, params: record(request.params), socketEpoch });
      else await this.socket.answer(request.id, undefined, socketEpoch).catch(() => {});
    }
    const approval = record(snapshot.pending_approval);
    if (typeof approval.request_id === 'string' && ![...pending.values()].some(p => p.params.request_id === approval.request_id)) {
      const prompt = promptView(`approval-${approval.request_id}`, 'approval', approval)!;
      pending.set(prompt.id, { nativeId: prompt.id, prompt, params: { ...approval, fallbackApproval: true }, socketEpoch });
    }
    view.prompts = [...pending.values()].map(p => p.prompt);
    const current = await db.transaction(async tx => {
      await this.lockBoundary(tx);
      const ownerLease = await this.assertCurrentLease(tx);
      const [latest] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
      if (!latest) throw new HttpError(404, 'Native Hermes chat not found.');
      if (await remoteRecoveryFenceActive(tx, row.id)) throw new HttpError(409, 'Native recovery began during refresh. The native snapshot was not applied.');
      if (Number(latest.ownershipGeneration) !== Number(row.ownershipGeneration))
        throw new HttpError(409, 'This native session was recovered elsewhere. Refresh before continuing.');
      // Only a snapshot started after the last mutation can settle that mutation.
      let saved = latest;
      if (latest.revision === row.revision && (this.sessions.get(row.id)?.eventRevision ?? 0) === eventRevision) {
      const status = view.running ? pending.size ? 'waiting' : 'running'
        : ['admitting', 'uncertain'].includes(latest.status) ? latest.status : 'idle';
      // Unacknowledged queues remain reserved even if an idle snapshot arrives.
      const queueStatus = view.queued && latest.queueRequestId ? 'queued' : latest.queueStatus;
      const clearQueue = latest.queueStatus === 'queued' && !view.queued;
      saved = (await tx.update(remoteHermesSessions).set({ runtimeId, storedId, title: view.title, status,
        admissionRequestId: status === 'idle' ? null : latest.admissionRequestId,
        queueRequestId: clearQueue ? null : latest.queueRequestId, queueStatus: clearQueue ? null : queueStatus,
        revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, row.id)).returning())[0];
      }
      return { saved, ownerInstanceId: ownerLease.ownerInstanceId, leaseGeneration: Number(ownerLease.generation), ownerSocketEpoch: Number(ownerLease.socketEpoch) };
    });
    return db.transaction(async tx => {
      await this.lockBoundary(tx);
      const [latest] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('share');
      const ownerLease = await this.assertCurrentLease(tx);
      if (!latest || latest.connectionId !== this.connectionId || latest.profile !== row.profile ||
          Number(latest.ownershipGeneration) !== Number(current.saved.ownershipGeneration) || latest.runtimeId !== current.saved.runtimeId ||
          ownerLease.ownerInstanceId !== current.ownerInstanceId || Number(ownerLease.generation) !== current.leaseGeneration || Number(ownerLease.socketEpoch) !== current.ownerSocketEpoch)
        throw new HttpError(409, 'This native session changed while refreshing. Reload before continuing.');
      view.queuePending = !!current.saved.queueRequestId;
      view.uncertain = current.saved.status === 'admitting' || current.saved.status === 'uncertain' || current.saved.queueStatus === 'uncertain';
      view.running ||= current.saved.status === 'running' || current.saved.status === 'waiting' || !!current.saved.queueRequestId;
      const cached = this.sessions.get(row.id);
      if (cached && cached.eventRevision !== eventRevision) {
        // Keep events received while the snapshot was being read (deltas and native requests too).
        if (current.saved.revision >= cached.row.revision) cached.row = current.saved;
        cached.view.queuePending = view.queuePending;
        cached.view.uncertain ||= view.uncertain;
        return cached.view;
      }
      // Polling and reconnects must not make an attempted answer eligible for replay.
      for (const [id, request] of pending) {
        const previous = cached?.pending.get(id);
        if (previous?.prompt.method === request.prompt.method) request.prompt.delivery = previous.prompt.delivery;
      }
      this.sessions.set(row.id, { row: current.saved, view, pending, refreshedAt: Date.now(), eventRevision, socketEpoch,
        ownerInstanceId: current.ownerInstanceId, leaseGeneration: current.leaseGeneration, ownerSocketEpoch: current.ownerSocketEpoch });
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
  private onFrame(frame: NativeFrame, socketEpoch: number) {
    void this.applyFrame(frame, socketEpoch).catch(() => {});
  }
  private async applyFrame(frame: NativeFrame, socketEpoch: number) {
    const p = record(frame.params);
    const cached = [...this.sessions.values()].find(c => c.row.runtimeId === p.session_id);
    // A resume can emit a request before returning its runtime id. The snapshot replays that request.
    if (!cached || cached.socketEpoch !== socketEpoch || socketEpoch !== this.socket.connectionEpoch) return;
    const runtimeId = cached.row.runtimeId;
    if (!runtimeId) return;
    let refreshAfter = false;
    await db.transaction(async tx => {
    // Match dispatch/recovery's owner -> session order. Events may update the
    // session, so take that lock once rather than upgrading concurrent shares.
    const [lease] = await tx.select().from(remoteHermesHubOwners).where(and(eq(remoteHermesHubOwners.connectionId, this.connectionId),
      eq(remoteHermesHubOwners.ownerInstanceId, cached.ownerInstanceId), eq(remoteHermesHubOwners.generation, cached.leaseGeneration),
      eq(remoteHermesHubOwners.socketEpoch, cached.ownerSocketEpoch), sql`${remoteHermesHubOwners.leaseExpiresAt} > now()`)).for('share');
    const [durable] = await tx.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.id, cached.row.id),
      eq(remoteHermesSessions.connectionId, this.connectionId), eq(remoteHermesSessions.profile, cached.row.profile),
      eq(remoteHermesSessions.runtimeId, runtimeId), eq(remoteHermesSessions.ownershipGeneration, cached.row.ownershipGeneration))).for('update');
    if (!durable || !lease || this.sessions.get(cached.row.id) !== cached || cached.socketEpoch !== this.socket.connectionEpoch) return;
    if (await remoteRecoveryFenceActive(tx, cached.row.id)) { cached.view.uncertain = true; this.changes.emit(cached.row.id); return; }
    cached.eventRevision++;
    if (frame.id !== undefined && frame.method && frame.method !== 'event') {
      const prompt = promptView(frame.id, frame.method, p);
      if (!prompt) { void this.socket.answer(frame.id, undefined, socketEpoch).catch(() => {}); return; }
      const previous = cached.pending.get(prompt.id);
      if (previous?.prompt.method === prompt.method) prompt.delivery = previous.prompt.delivery;
      cached.pending.set(prompt.id, { nativeId: frame.id, prompt, params: p, socketEpoch });
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
        await tx.update(remoteHermesSessions).set({ status: 'running', revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
          .where(and(eq(remoteHermesSessions.id, cached.row.id), eq(remoteHermesSessions.connectionId, this.connectionId), eq(remoteHermesSessions.runtimeId, runtimeId), eq(remoteHermesSessions.ownershipGeneration, cached.row.ownershipGeneration),
            sql`exists (select 1 from ${remoteHermesHubOwners} where ${remoteHermesHubOwners.connectionId} = ${this.connectionId} and ${remoteHermesHubOwners.ownerInstanceId} = ${cached.ownerInstanceId} and ${remoteHermesHubOwners.generation} = ${cached.leaseGeneration} and ${remoteHermesHubOwners.socketEpoch} = ${cached.ownerSocketEpoch} and ${remoteHermesHubOwners.leaseExpiresAt} > now())`))
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
        await tx.update(remoteHermesSessions).set({ status: sql`case when ${remoteHermesSessions.queueRequestId} is null then 'idle' else 'running' end`, admissionRequestId: null, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
          .where(and(eq(remoteHermesSessions.id, cached.row.id), eq(remoteHermesSessions.connectionId, this.connectionId), eq(remoteHermesSessions.runtimeId, runtimeId), eq(remoteHermesSessions.ownershipGeneration, cached.row.ownershipGeneration), ne(remoteHermesSessions.status, 'admitting'),
            sql`exists (select 1 from ${remoteHermesHubOwners} where ${remoteHermesHubOwners.connectionId} = ${this.connectionId} and ${remoteHermesHubOwners.ownerInstanceId} = ${cached.ownerInstanceId} and ${remoteHermesHubOwners.generation} = ${cached.leaseGeneration} and ${remoteHermesHubOwners.socketEpoch} = ${cached.ownerSocketEpoch} and ${remoteHermesHubOwners.leaseExpiresAt} > now())`))
        refreshAfter = true;
        break;
      case 'session.info':
        if (typeof payload.yolo === 'boolean') cached.view.yolo = payload.yolo;
        if (['manual', 'smart', 'off'].includes(String(payload.approval_mode))) cached.view.approvalMode = String(payload.approval_mode);
        if (typeof payload.model === 'string') cached.view.model = payload.model;
        if (typeof payload.provider === 'string') cached.view.provider = payload.provider;
        if (typeof payload.stored_session_id === 'string' && payload.stored_session_id && payload.stored_session_id !== cached.row.storedId) {
          cached.row.storedId = payload.stored_session_id;
          await tx.update(remoteHermesSessions).set({ storedId: payload.stored_session_id, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
            .where(and(eq(remoteHermesSessions.id, cached.row.id), eq(remoteHermesSessions.connectionId, this.connectionId), eq(remoteHermesSessions.runtimeId, runtimeId), eq(remoteHermesSessions.ownershipGeneration, cached.row.ownershipGeneration),
              sql`exists (select 1 from ${remoteHermesHubOwners} where ${remoteHermesHubOwners.connectionId} = ${this.connectionId} and ${remoteHermesHubOwners.ownerInstanceId} = ${cached.ownerInstanceId} and ${remoteHermesHubOwners.generation} = ${cached.leaseGeneration} and ${remoteHermesHubOwners.socketEpoch} = ${cached.ownerSocketEpoch} and ${remoteHermesHubOwners.leaseExpiresAt} > now())`))
        }
        break;
    }
    this.changes.emit(cached.row.id);
    });
    if (refreshAfter) {
      try { await this.refreshAfterPending(cached.row); } catch { cached.view.uncertain = true; }
    }
  }
  async answer(row: Session, requestId: string, input: unknown) {
    await this.refresh(row);
    const cached = this.sessions.get(row.id)!;
    const pending = cached.pending.get(requestId);
    if (!pending) throw new HttpError(409, 'This native prompt has expired or was answered elsewhere.');
    if (pending.prompt.delivery) throw new HttpError(409, 'An answer was already sent or attempted for this prompt. Refresh or inspect the native dashboard; it will not be replayed.');
    const result = answerFor(pending.prompt, input);
    const mark = (delivery: NonNullable<NativePrompt['delivery']>) => {
      pending.prompt.delivery = delivery;
      const latest = this.sessions.get(row.id);
      const request = latest?.pending.get(requestId);
      if (request?.prompt.method === pending.prompt.method) request.prompt.delivery = delivery;
      if (latest) { latest.eventRevision++; this.changes.emit(row.id); }
    };
    // Reserve before the first await; a successful write is not native acceptance.
    mark('sending');
    try {
      if (pending.params.fallbackApproval) await this.socket.callConnected('approval.respond', { session_id: cached.row.runtimeId, profile: row.profile, request_id: pending.params.request_id, choice: result.choice }, pending.socketEpoch);
      else await this.socket.answer(pending.nativeId, result, pending.socketEpoch);
      mark('sent');
    } catch (error) {
      mark('uncertain');
      await this.refreshAfterPending(row).catch(() => {});
      throw error;
    }
    try {
      const view = await this.refreshAfterPending(row);
      return { sent: true, status: view.prompts.some(p => p.id === requestId) ? 'pending' : 'resolved' };
    } catch {
      mark('uncertain');
      return { sent: true, status: 'uncertain' };
    }
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
