import { randomUUID, createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { remoteHermesSessions, remoteHermesTurns } from '@/db/schema';
import { encrypt, decrypt } from '@/lib/crypto';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { ownedNativeSession } from './sessions';
import { nativeHub } from './hub';
import { remoteAccess } from './store';
import { assertSessionYoloAdmission } from './policy';
import { NativeRpcError, NativeConnectionChanged } from './socket';
import { sessionYoloCompatible, yoloStatus, yoloStatusText } from './yolo-contract';

export const yoloInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), value: z.enum(['on', 'off']) }).strict(),
  z.object({ operation: z.literal('confirm'), confirmation: z.string().min(1).max(4000) }).strict(),
]);
const claimSchema = z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1), storedId: z.string().min(1), profile: z.string().min(1), socketEpoch: z.number().int().positive(), value: z.enum(['on', 'off']), expiresAt: z.number().int() }).strict();
type Claim = z.infer<typeof claimSchema>;
type Session = typeof remoteHermesSessions.$inferSelect;
const aad = (owner: string, connection: string, session: string) => JSON.stringify(['remote-hermes-session-yolo:v1', owner, connection, session]);
function readClaim(token: string, binding: string): Claim {
  try {
    const claim = claimSchema.parse(JSON.parse(decrypt(token, binding)));
    if (claim.expiresAt <= Date.now() || claim.expiresAt > Date.now() + 60_000) throw new Error();
    return claim;
  } catch { throw new HttpError(409, 'This YOLO confirmation is invalid or expired. Review the conversation and request a new confirmation.'); }
}

/** Explicit, confirmed session setter only. No slash-worker, profile/global or missing-session fallback. */
export async function nativeSessionYolo(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = yoloInput.parse(raw);
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  assertSessionYoloAdmission(await getSetting('remoteHermes'));
  const binding = aad(ownerId, connectionId, sessionId);
  const claim = input.operation === 'confirm' ? readClaim(input.confirmation, binding) : null;
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === row.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(row);
  const cached = () => hub.sessions.get(sessionId);
  function compatible() {
    const c = cached();
    if (!c?.row.runtimeId || !sessionYoloCompatible(c.view)) throw new HttpError(501, 'Session YOLO changes require verified Hermes 0.21.5 with native desktop contract 8 and a matching profile. This runtime is unavailable for approval-mode changes.');
    if (!c.socketEpoch || c.socketEpoch !== hub.socket.connectionEpoch || hub.socket.state !== 'connected') throw new NativeConnectionChanged();
    return c;
  }
  function idle(current: Session | undefined) {
    const c = compatible();
    if (!current || current.status !== 'idle' || current.queueRequestId || c.view.running || c.view.uncertain || c.view.queuePending || c.view.queued || c.pending.size || c.view.prompts.length)
      throw new HttpError(409, 'Finish pending prompts, queued work and the native turn before changing session YOLO. Uncertain operations must be resolved first.');
    return c;
  }
  function sameTarget(current: Session | undefined, target: Claim) {
    const c = compatible();
    if (!current || c.socketEpoch !== target.socketEpoch || current.runtimeId !== target.runtimeId || c.row.runtimeId !== target.runtimeId || current.storedId !== target.storedId || c.row.storedId !== target.storedId || current.profile !== target.profile || c.row.profile !== target.profile || c.view.profile !== target.profile || c.view.nativeProfile !== target.profile || current.connectionId !== connectionId)
      throw new HttpError(409, 'The native conversation changed after confirmation. Review it and request a new confirmation.');
    return c;
  }
  async function lockPolicy(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    await hub.lockBoundary(tx);
    assertSessionYoloAdmission(await getSetting('remoteHermes', tx));
  }
  if (input.operation === 'prepare') return db.transaction(async tx => {
    await lockPolicy(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const c = idle(current);
    if (!current.runtimeId || current.runtimeId !== c.row.runtimeId || current.storedId !== c.row.storedId || current.profile !== c.row.profile || current.connectionId !== connectionId) throw new HttpError(409, 'Refresh the native conversation before confirming YOLO.');
    const target: Claim = { requestId: randomUUID(), runtimeId: current.runtimeId, storedId: current.storedId, profile: current.profile, socketEpoch: c.socketEpoch, value: input.value, expiresAt: Date.now() + 60_000 };
    return { confirmation: encrypt(JSON.stringify(target), binding), expiresAt: target.expiresAt, value: target.value, profile: current.profile, title: c.view.title, ...yoloStatus(c.view) };
  });
  const target = claim!;
  const digest = createHash('sha256').update('session-yolo:v1:').update(JSON.stringify(target)).digest('hex');
  const reserved = await db.transaction(async tx => {
    await lockPolicy(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, target.requestId)));
    if (receipt) { if (receipt.digest !== digest) throw new HttpError(409, 'This confirmation receipt belongs to different content.'); return null; }
    idle(current); sameTarget(current, target);
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId: target.requestId, digest });
    return (await tx.update(remoteHermesSessions).set({ status: 'admitting', admissionRequestId: target.requestId, admissionAt: new Date(), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, sessionId)).returning())[0];
  });
  if (!reserved) return { duplicate: true, output: 'This YOLO confirmation was already submitted. It will not be replayed. Check effective native state; an unconfirmed outcome remains uncertain.' };
  const c = cached()!; c.row = reserved; c.view.uncertain = true;
  let sent = false;
  try {
    const { reply } = await db.transaction(async tx => {
      await lockPolicy(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
      const live = sameTarget(current, target);
      if (target.expiresAt <= Date.now() || !current || current.status !== 'admitting' || current.admissionRequestId !== target.requestId || current.queueRequestId || live.view.running || live.view.queuePending || live.view.queued || live.pending.size || live.view.prompts.length)
        throw new HttpError(409, 'This YOLO confirmation is no longer ready. Review the native conversation before changing its mode.');
      sent = true;
      return hub.socket.dispatchConnected('config.set', { profile: target.profile, session_id: target.runtimeId, scope: 'session', key: 'yolo', value: target.value }, target.socketEpoch, 30_000, tx);
    });
    const result = await reply;
    if (result.key !== 'yolo' || result.scope !== 'session' || result.value !== (target.value === 'on' ? '1' : '0')) throw new HttpError(502, 'Hermes did not confirm the requested session YOLO state. Refresh before continuing.');
  } catch (error) {
    const definitive = !sent || error instanceof NativeConnectionChanged || error instanceof NativeRpcError && [-32601, 4001].includes(error.code!);
    await settle(definitive ? 'idle' : 'uncertain');
    throw error;
  }
  await settle('idle');
  const view = await hub.refresh(cached()!.row);
  return { accepted: true, sessionValue: target.value, ...yoloStatus(view), output: yoloStatusText(view, target.value) };
  async function settle(status: 'idle' | 'uncertain') {
    const [updated] = await db.update(remoteHermesSessions).set({ status, admissionRequestId: status === 'idle' ? null : target.requestId, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.status, 'admitting'), eq(remoteHermesSessions.admissionRequestId, target.requestId))).returning();
    const live = cached();
    if (updated && live && live.row.admissionRequestId === target.requestId && updated.revision >= live.row.revision) { live.row = updated; live.view.uncertain = status === 'uncertain'; }
  }
}
