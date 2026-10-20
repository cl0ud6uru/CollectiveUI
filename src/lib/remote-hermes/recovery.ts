import { createHash, randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '@/db';
import { remoteHermesConnections, remoteHermesSessions } from '@/db/schema';
import { remoteHermesRecoveries } from '@/db/remote-hermes-recovery-schema';
import { HttpError } from '@/lib/authz';
import { ownedNativeSession } from './sessions';
import { nativeHub, type NativeHub } from './hub';
import { NativeConnectionChanged, type RpcRecord } from './socket';
import { readNativeDrain, requestNativeDrain, requireCapability, validateReceipt, type NativeDrainBinding } from './recovery-protocol';
import { recoveryBinding, recoveryInput, recoveryOwnership, type RecoveryBinding, type RecoveryView } from './recovery-contract';

type Session = typeof remoteHermesSessions.$inferSelect;
type Connection = typeof remoteHermesConnections.$inferSelect;
type Intent = typeof remoteHermesRecoveries.$inferSelect;
type Ownership = RecoveryBinding['ownership'];
const sessionColumns = { ...getTableColumns(remoteHermesSessions), ownershipGeneration: sql<number>`ownership_generation`.mapWith(Number) };
/** The native ownership dependency must be installed; older hubs fail closed. */
type RecoveryHub = NativeHub & {
  prepareRecoveryOwnership(row: Session): Promise<unknown>;
  claimRecoveryOwnership(snapshot: Ownership, recoveryId: string): Promise<unknown>;
  completeRecoveryOwnership(snapshot: Ownership, recoveryId: string): Promise<unknown>;
  assertCurrentOwnership(tx: Tx, snapshot: Ownership): Promise<unknown>;
  assertNativeOwnership(snapshot: Ownership): Promise<unknown>;
  invalidateRecoveredSession(sessionId: string, snapshot: Ownership): Promise<unknown>;
};
function recoveryHub(ownerId: string, connectionId: string): RecoveryHub {
  const hub = nativeHub(ownerId, connectionId) as RecoveryHub;
  if (['prepareRecoveryOwnership', 'claimRecoveryOwnership', 'completeRecoveryOwnership', 'assertCurrentOwnership', 'assertNativeOwnership', 'invalidateRecoveredSession'].some(key => typeof (hub as unknown as Record<string, unknown>)[key] !== 'function'))
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
    // A confirmed fence must never resume/create another native runtime before terminal CAS.
    const [existing] = await db.select().from(remoteHermesRecoveries).where(and(eq(remoteHermesRecoveries.ownerId, ownerId),
      eq(remoteHermesRecoveries.connectionId, connectionId), eq(remoteHermesRecoveries.sessionId, row.id), inArray(remoteHermesRecoveries.state, ['pending', 'uncertain'])));
    if (existing) return view(existing);
    // Candidate capture connects the actual socket but cannot claim, resume or cancel work.
    const ownership = recoveryOwnership.safeParse(await hub.prepareRecoveryOwnership(row));
    if (!ownership.success) throw new HttpError(501, 'This native runtime cannot prepare exclusive recovery ownership.');
    const snapshot = ownership.data;
    await requireCapability(boundRpc(hub, snapshot, undefined, false));
    return db.transaction(async tx => {
      const connection = await hub.lockBoundary(tx);
      await hub.assertCurrentOwnership(tx, snapshot);
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
  const intent = await db.transaction(async tx => {
    await hub.lockBoundary(tx);
    const [target] = await tx.select().from(remoteHermesRecoveries).where(and(eq(remoteHermesRecoveries.id, input.intentId), eq(remoteHermesRecoveries.ownerId, ownerId),
      eq(remoteHermesRecoveries.connectionId, connectionId), eq(remoteHermesRecoveries.sessionId, row.id)));
    if (!target) throw new HttpError(404, 'Recovery confirmation not found.');
    if (target.state === 'applied') return target;
    if (target.state === 'superseded') throw changed();
    const binding = recoveryBinding.parse(target.binding);
    // Before confirmation the captured full fence must still match. Once the
    // transition started, its original native generation is historical: exact
    // recovery/full phase proofs are checked below before any native action.
    await assertBound(tx, hub, binding, binding.ownership, target.state === 'prepared' && !!binding.ownership.nativeFence);
    const [locked] = await tx.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, target.id)).for('update');
    if (!locked || locked.state !== target.state) throw changed();
    if (target.state === 'prepared') {
      if (input.operation !== 'confirm' || target.expiresAt.getTime() <= Date.now()) throw new HttpError(409, 'Review and confirm recovery again; this confirmation expired.');
      return (await tx.update(remoteHermesRecoveries).set({ state: 'pending', confirmedAt: new Date(), updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, target.id)).returning())[0];
    }
    return target;
  });
  if (intent.state === 'applied') return view(intent);
  const binding = recoveryBinding.parse(intent.binding);
  const native: NativeDrainBinding = { recovery_id: intent.id, session_id: binding.ownership.runtimeId, stored_session_id: binding.ownership.storedId,
    profile: binding.ownership.profile, reservation_ids: reservationIds(binding) };
  // Native claims are idempotent phase transitions for this exact confirmed UUID/tuple.
  // Prompts and protected answers are never replayed; native cancellation is dispatched once.
  try {
    let claimed = intent.claimedOwnership ? recoveryOwnership.parse(intent.claimedOwnership) : null;
    if (!claimed) {
      claimed = recoveryOwnership.parse(await hub.claimRecoveryOwnership(binding.ownership, intent.id));
      assertRecoveryPhase(binding.ownership, claimed, 'recovery', intent.id);
      const proof = claimed;
      await db.transaction(async tx => {
        await assertBound(tx, hub, binding, proof);
        const [target] = await tx.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.id)).for('update');
        if (!target || !['pending', 'uncertain'].includes(target.state)) throw changed();
        if (target.claimedOwnership && JSON.stringify(recoveryOwnership.parse(target.claimedOwnership)) !== JSON.stringify(proof)) throw changed();
        await tx.update(remoteHermesRecoveries).set({ claimedOwnership: proof, updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, intent.id));
      });
    }
    assertRecoveryPhase(binding.ownership, claimed, 'recovery', intent.id);
    let receipt = intent.receipt?.state === 'drained' ? validateReceipt(intent.receipt, native) : null;
    if (!receipt) {
      const claimedSnapshot = claimed;
      const dispatchCancellation = await db.transaction(async tx => {
        await assertBound(tx, hub, binding, claimedSnapshot);
        const [target] = await tx.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.id)).for('update');
        if (!target || !['pending', 'uncertain'].includes(target.state)) throw changed();
        if (target.nativeRequestedAt) return false;
        await tx.update(remoteHermesRecoveries).set({ nativeRequestedAt: new Date(), updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, intent.id));
        return true;
      });
      const rpc = boundRpc(hub, claimed, binding);
      receipt = dispatchCancellation ? await requestNativeDrain(rpc, native) : await readNativeDrain(rpc, native);
      // Keep proof monotonic when concurrent readers observe pending then drained in reverse order.
      await db.update(remoteHermesRecoveries).set({ receipt, updatedAt: new Date() }).where(and(eq(remoteHermesRecoveries.id, intent.id),
        inArray(remoteHermesRecoveries.state, ['pending', 'uncertain']), sql`(receipt is null or receipt->>'state' <> 'drained')`));
    }
    if (receipt.state !== 'drained') {
      const [pending] = await db.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.id));
      if (!pending) throw changed();
      return view(pending);
    }
    // Full ownership is a separate native CAS requiring this exact current-boot terminal receipt.
    // Retrying a lost full-claim reply must read back this same UUID/tuple, never a fresh claim.
    const completed = recoveryOwnership.parse(await hub.completeRecoveryOwnership(claimed, intent.id));
    assertRecoveryPhase(binding.ownership, completed, 'full', intent.id);
    if (completed.nativeFence!.nativeGeneration !== claimed.nativeFence!.nativeGeneration + 1) throw changed();
    const applied = await db.transaction(async tx => {
      await assertBound(tx, hub, binding, completed);
      const [currentIntent] = await tx.select().from(remoteHermesRecoveries).where(eq(remoteHermesRecoveries.id, intent.id)).for('update');
      if (!currentIntent || currentIntent.state === 'superseded') throw changed();
      if (currentIntent.state === 'applied') return currentIntent;
      const released = await tx.execute(sql`UPDATE remote_hermes_sessions SET runtime_id = NULL, status = 'idle', admission_at = NULL,
        admission_request_id = NULL, queue_request_id = NULL, queue_status = NULL, revision = revision + 1,
        ownership_generation = ownership_generation + 1, updated_at = now()
        WHERE id = ${row.id} AND revision = ${binding.ownership.sessionRevision} AND runtime_id = ${binding.ownership.runtimeId}
          AND ownership_generation = ${binding.ownership.ownershipGeneration} RETURNING id`);
      if (!released.rows.length) throw changed();
      return (await tx.update(remoteHermesRecoveries).set({ state: 'applied', receipt, completedOwnership: completed, updatedAt: new Date() }).where(eq(remoteHermesRecoveries.id, intent.id)).returning())[0];
    });
    if (applied.state === 'applied') await hub.invalidateRecoveredSession(row.id, completed);
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
function assertRecoveryPhase(candidate: Ownership, proof: Ownership, phase: 'recovery' | 'full', recoveryId: string) {
  const { nativeFence: _candidateFence, ...before } = candidate, { nativeFence, ...after } = proof; void _candidateFence;
  if (JSON.stringify(before) !== JSON.stringify(after) || nativeFence?.phase !== phase || nativeFence.generation !== proof.leaseGeneration ||
      nativeFence.socketEpoch !== proof.portalSocketEpoch || nativeFence.recoveryId !== recoveryId || nativeFence.recoverySessionId !== proof.runtimeId || nativeFence.recoveryStoredSessionId !== proof.storedId) throw changed();
}
async function assertBound(tx: Tx, hub: RecoveryHub, binding: RecoveryBinding, snapshot: Ownership, requireNative = true) {
  const { nativeFence: _candidateFence, ...before } = binding.ownership, { nativeFence: _proofFence, ...after } = snapshot; void _candidateFence; void _proofFence;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw changed();
  const connection = await hub.lockBoundary(tx);
  await hub.assertCurrentOwnership(tx, requireNative ? snapshot : { ...snapshot, nativeFence: null });
  if (requireNative) await hub.assertNativeOwnership(snapshot);
  const [current] = await tx.select(sessionColumns).from(remoteHermesSessions).where(eq(remoteHermesSessions.id, binding.ownership.sessionId)).for('update');
  if (!current) throw changed();
  assertRecoveryBinding(current, connection, binding);
}
function boundRpc(hub: RecoveryHub, snapshot: Ownership, binding?: RecoveryBinding, requireNative = true) {
  return { call: async (method: string, params: RpcRecord = {}) => {
    const { reply } = await db.transaction(async tx => {
      await hub.lockBoundary(tx);
      if (binding) await assertBound(tx, hub, binding, snapshot, requireNative);
      else { await hub.assertCurrentOwnership(tx, snapshot); if (requireNative) await hub.assertNativeOwnership(snapshot); }
      if (hub.socket.state !== 'connected' || hub.socket.connectionEpoch !== snapshot.socketEpoch) throw new NativeConnectionChanged();
      return hub.socket.dispatchConnected(method, params, snapshot.socketEpoch, 30_000, tx);
    });
    return reply;
  } };
}
