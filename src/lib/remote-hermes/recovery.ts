import { createHash, randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '@/db';
import { remoteHermesConnections, remoteHermesSessions } from '@/db/schema';
import { remoteHermesRecoveries } from '@/db/remote-hermes-recovery-schema';
import { HttpError } from '@/lib/authz';
import { ownedNativeSession } from './sessions';
import { nativeHub, type NativeHub } from './hub';
import { NativeConnectionChanged, type RpcRecord } from './socket';
import { readNativeDrain, requestNativeDrain, requireCapability, type NativeDrainBinding } from './recovery-protocol';
import { recoveryBinding, recoveryInput, recoveryOwnership, type RecoveryBinding, type RecoveryView } from './recovery-contract';

type Session = typeof remoteHermesSessions.$inferSelect;
type Connection = typeof remoteHermesConnections.$inferSelect;
type Intent = typeof remoteHermesRecoveries.$inferSelect;
type Ownership = RecoveryBinding['ownership'];
const sessionColumns = { ...getTableColumns(remoteHermesSessions), ownershipGeneration: sql<number>`ownership_generation`.mapWith(Number) };
/** The native ownership dependency must be installed; older hubs fail closed. */
type RecoveryHub = NativeHub & {
  captureOwnership(row: Session): Promise<unknown>;
  assertCurrentOwnership(tx: Tx, snapshot: Ownership): Promise<unknown>;
  assertNativeOwnership(snapshot: Ownership): Promise<unknown>;
  invalidateRecoveredSession(sessionId: string, snapshot: Ownership): Promise<unknown>;
};
function recoveryHub(ownerId: string, connectionId: string): RecoveryHub {
  const hub = nativeHub(ownerId, connectionId) as RecoveryHub;
  if (['captureOwnership', 'assertCurrentOwnership', 'assertNativeOwnership', 'invalidateRecoveredSession'].some(key => typeof (hub as unknown as Record<string, unknown>)[key] !== 'function'))
    throw new HttpError(501, 'Verified native ownership and cancel-and-drain support are required for recovery.');
  return hub;
}
export const recoveryConnectionDigest = (connection: Connection) => createHash('sha256').update(JSON.stringify([
  connection.id, connection.userId, connection.baseUrl, connection.authMode, connection.secretEnc,
])).digest('hex');
const changed = () => new HttpError(409, 'This recovery binding changed. Reservations remain blocked; review the conversation before continuing.');
function reservationIds(binding: RecoveryBinding) {
  return [...new Set([binding.admissionRequestId, binding.queueRequestId].filter((value): value is string => !!value))].sort();
}
function view(intent: Intent): RecoveryView {
  const binding = recoveryBinding.parse(intent.binding);
  return { intentId: intent.id, state: intent.state === 'superseded' ? 'uncertain' : intent.state,
    expiresAt: intent.expiresAt.getTime(), reservationCount: reservationIds(binding).length, profile: binding.ownership.profile };
}
/** Compare every captured reservation identity and revision. No idle or close inference. */
export function assertRecoveryBinding(row: Session & { ownershipGeneration?: number }, connection: Connection, binding: RecoveryBinding) {
  const own = binding.ownership;
  if (connection.id !== own.connectionId || connection.userId !== own.ownerId || recoveryConnectionDigest(connection) !== binding.connectionDigest ||
      row.id !== own.sessionId || row.connectionId !== own.connectionId || row.profile !== own.profile || row.storedId !== own.storedId || row.runtimeId !== own.runtimeId ||
      row.revision !== own.sessionRevision || row.ownershipGeneration !== own.ownershipGeneration || row.status !== binding.status ||
      row.admissionRequestId !== binding.admissionRequestId || row.queueRequestId !== binding.queueRequestId || row.queueStatus !== binding.queueStatus) throw changed();
}

export async function nativeRecovery(ownerId: string, connectionId: string, raw: unknown): Promise<RecoveryView> {
  const input = recoveryInput.parse(raw);
  const row = await ownedNativeSession(ownerId, connectionId, input.sessionId);
  const hub = recoveryHub(ownerId, connectionId);
  if (input.operation === 'prepare') {
    // A read can reconnect/resume, so it happens BEFORE capturing immutable intent bindings.
    await hub.refresh(row);
    const [fresh] = await db.select(sessionColumns).from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id));
    if (!fresh) throw changed();
    const ownership = recoveryOwnership.safeParse(await hub.captureOwnership(fresh));
    if (!ownership.success) throw new HttpError(501, 'This native runtime cannot prove exclusive recovery ownership.');
    const snapshot = ownership.data;
    await hub.assertNativeOwnership(snapshot);
    const cached = hub.sessions.get(row.id);
    if (!cached || cached.view.nativeProfile !== fresh.profile || cached.view.profile !== fresh.profile || cached.row.runtimeId !== fresh.runtimeId ||
        cached.socketEpoch !== snapshot.socketEpoch) throw changed();
    // Require the exact optional contract before offering a destructive cancellation confirmation.
    await requireCapability(boundRpc(hub, snapshot));
    return db.transaction(async tx => {
      const connection = await hub.lockBoundary(tx);
      await hub.assertCurrentOwnership(tx, snapshot);
      await hub.assertNativeOwnership(snapshot);
      const [current] = await tx.select(sessionColumns).from(remoteHermesSessions).where(eq(remoteHermesSessions.id, row.id)).for('update');
      if (!current || current.revision !== snapshot.sessionRevision) throw changed();
      if (!(current.status === 'admitting' || current.status === 'uncertain' || current.queueStatus === 'admitting' || current.queueStatus === 'uncertain') ||
          (!current.admissionRequestId && !current.queueRequestId)) throw new HttpError(409, 'Only an unresolved prompt or queue reservation can use this recovery.');
      const [active] = await tx.select().from(remoteHermesRecoveries).where(and(eq(remoteHermesRecoveries.sessionId, row.id), inArray(remoteHermesRecoveries.state, ['prepared', 'pending', 'uncertain']))).for('update');
      if (active && active.state !== 'prepared') return view(active); // Resume evidence checks; never allocate a competing native fence.
      if (active) await tx.update(remoteHermesRecoveries).set({ state: 'superseded', updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, active.id));
      const binding = recoveryBinding.parse({ ownership: snapshot, connectionDigest: recoveryConnectionDigest(connection),
        admissionRequestId: current.admissionRequestId, queueRequestId: current.queueRequestId, status: current.status, queueStatus: current.queueStatus });
      assertRecoveryBinding(current, connection, binding);
      const [intent] = await tx.insert(remoteHermesRecoveries).values({ id: randomUUID(), ownerId, connectionId, sessionId: row.id,
        binding, state: 'prepared', expiresAt: new Date(Date.now() + 60_000) }).returning();
      return view(intent);
    });
  }
  const { intent, dispatchCancellation } = await db.transaction(async tx => {
    await hub.lockBoundary(tx);
    const [target] = await tx.select().from(remoteHermesRecoveries).where(and(eq(remoteHermesRecoveries.id, input.intentId), eq(remoteHermesRecoveries.ownerId, ownerId),
      eq(remoteHermesRecoveries.connectionId, connectionId), eq(remoteHermesRecoveries.sessionId, row.id)));
    if (!target) throw new HttpError(404, 'Recovery confirmation not found.');
    if (target.state === 'applied') return { intent: target, dispatchCancellation: false };
    if (target.state === 'superseded') throw changed();
    const binding = recoveryBinding.parse(target.binding);
    await assertBound(tx, hub, binding);
    const [locked] = await tx.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, target.id)).for('update');
    if (!locked || locked.state !== target.state) throw changed();
    if (target.state === 'prepared') {
      if (input.operation !== 'confirm' || target.expiresAt.getTime() <= Date.now()) throw new HttpError(409, 'Review and confirm recovery again; this confirmation expired.');
      return { intent: (await tx.update(remoteHermesRecoveries).set({ state: 'pending', confirmedAt: new Date(), updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, target.id)).returning())[0], dispatchCancellation: true };
    }
    return { intent: target, dispatchCancellation: false };
  });
  if (intent.state === 'applied') return view(intent);
  const binding = recoveryBinding.parse(intent.binding);
  const native: NativeDrainBinding = { recovery_id: intent.id, session_id: binding.ownership.runtimeId, stored_session_id: binding.ownership.storedId,
    profile: binding.ownership.profile, reservation_ids: reservationIds(binding) };
  // Only the first confirmation submits cancellation. All retries read the SAME durable UUID.
  // A lost first response is resolved by status, never by repeating a prompt/answer/cancellation.
  try {
    const rpc = boundRpc(hub, binding.ownership, binding);
    const receipt = dispatchCancellation ? await requestNativeDrain(rpc, native) : await readNativeDrain(rpc, native);
    await db.update(remoteHermesRecoveries).set({ receipt, updatedAt: new Date() }).where(and(eq(remoteHermesRecoveries.id, intent.id), inArray(remoteHermesRecoveries.state, ['pending', 'uncertain'])));
    const applied = await db.transaction(async tx => {
      await assertBound(tx, hub, binding);
      const [currentIntent] = await tx.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.id)).for('update');
      if (!currentIntent || currentIntent.state === 'superseded') throw changed();
      if (currentIntent.state === 'applied') return currentIntent;
      if (receipt.state !== 'drained') return (await tx.update(remoteHermesRecoveries).set({ state: 'pending', receipt, updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, intent.id)).returning())[0];
      const released = await tx.execute(sql`UPDATE remote_hermes_sessions SET runtime_id = NULL, status = 'idle', admission_at = NULL,
        admission_request_id = NULL, queue_request_id = NULL, queue_status = NULL, revision = revision + 1,
        ownership_generation = ownership_generation + 1, updated_at = now()
        WHERE id = ${row.id} AND revision = ${binding.ownership.sessionRevision} AND runtime_id = ${binding.ownership.runtimeId}
          AND ownership_generation = ${binding.ownership.ownershipGeneration} RETURNING id`);
      if (!released.rows.length) throw changed();
      return (await tx.update(remoteHermesRecoveries).set({ state: 'applied', receipt, updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, intent.id)).returning())[0];
    });
    if (applied.state === 'applied') await hub.invalidateRecoveredSession(row.id, binding.ownership);
    return view(applied);
  } catch {
    // No raw native diagnostic or protected request is persisted/exposed. Receipt survives a CAS failure.
    const [uncertain] = await db.update(remoteHermesRecoveries).set({ state: 'uncertain', updatedAt: new Date() })
      .where(and(eq(remoteHermesRecoveries.id, intent.id), inArray(remoteHermesRecoveries.state, ['pending', 'uncertain']))).returning();
    if (!uncertain) {
      const [settled] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.id));
      if (settled?.state === 'applied') return view(settled);
      throw changed();
    }
    return view(uncertain);
  }
}
async function assertBound(tx: Tx, hub: RecoveryHub, binding: RecoveryBinding) {
  const connection = await hub.lockBoundary(tx);
  await hub.assertCurrentOwnership(tx, binding.ownership);
  await hub.assertNativeOwnership(binding.ownership);
  const [current] = await tx.select(sessionColumns).from(remoteHermesSessions).where(eq(remoteHermesSessions.id, binding.ownership.sessionId)).for('update');
  if (!current) throw changed();
  assertRecoveryBinding(current, connection, binding);
}
function boundRpc(hub: RecoveryHub, snapshot: Ownership, binding?: RecoveryBinding) {
  return { call: async (method: string, params: RpcRecord = {}) => {
    const { reply } = await db.transaction(async tx => {
      await hub.lockBoundary(tx);
      if (binding) await assertBound(tx, hub, binding);
      else { await hub.assertCurrentOwnership(tx, snapshot); await hub.assertNativeOwnership(snapshot); }
      if (hub.socket.state !== 'connected' || hub.socket.connectionEpoch !== snapshot.socketEpoch) throw new NativeConnectionChanged();
      return hub.socket.dispatchConnected(method, params, snapshot.socketEpoch, 30_000, tx);
    });
    return reply;
  } };
}
