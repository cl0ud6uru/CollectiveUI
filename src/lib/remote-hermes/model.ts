import { randomUUID, createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { remoteHermesSessions, remoteHermesTurns } from '@/db/schema';
import { decrypt, encrypt } from '@/lib/crypto';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { assertRemoteHermesAdmission } from './policy';
import { ownedNativeSession } from './sessions';
import { nativeHub } from './hub';
import { remoteAccess } from './store';
import { NativeConnectionChanged, NativeRpcError } from './socket';
import { nativeModelChoices, resolveNativeModelChoice, sessionModelCompatible, type NativeModelChoice } from './model-contract';

export const modelInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('options') }).strict(),
  z.object({ operation: z.literal('prepare'), model: z.string().min(1).max(200), provider: z.string().min(1).max(100) }).strict(),
  z.object({ operation: z.literal('confirm'), confirmation: z.string().min(1).max(4000) }).strict(),
]);
const claimSchema = z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1), storedId: z.string().min(1), profile: z.string().min(1), socketEpoch: z.number().int().positive(), model: z.string().min(1), provider: z.string().min(1), confirmExpensiveModel: z.boolean(), expiresAt: z.number().int() }).strict();
type Claim = z.infer<typeof claimSchema>;
type Session = typeof remoteHermesSessions.$inferSelect;
const aad = (owner: string, connection: string, session: string) => JSON.stringify(['remote-hermes-session-model:v1', owner, connection, session]);

function readClaim(token: string, binding: string): Claim {
  try {
    const claim = claimSchema.parse(JSON.parse(decrypt(token, binding)));
    if (claim.expiresAt <= Date.now() || claim.expiresAt > Date.now() + 60_000) throw new Error();
    return claim;
  } catch { throw new HttpError(409, 'This model confirmation is invalid or expired. Choose the model again.'); }
}

/** Confirmed, session-only model/provider selection. Never uses slash.exec or invokes inference. */
export async function nativeSessionModel(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = modelInput.parse(raw);
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  assertRemoteHermesAdmission(await getSetting('remoteHermes'));
  const binding = aad(ownerId, connectionId, sessionId);
  const target = input.operation === 'confirm' ? readClaim(input.confirmation, binding) : null;
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === row.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(row);
  const cached = () => hub.sessions.get(row.id);
  function compatible() {
    const c = cached();
    if (!c?.row.runtimeId || !sessionModelCompatible(c.view)) throw new HttpError(501, 'Model changes require verified Hermes 0.21.5 with native desktop contract 8 and a matching profile. This runtime is unavailable for remote model controls.');
    if (!c.socketEpoch || c.socketEpoch !== hub.socket.connectionEpoch || hub.socket.state !== 'connected') throw new NativeConnectionChanged();
    return c;
  }
  function idle(current: Session | undefined) {
    const c = compatible();
    if (!current || current.status !== 'idle' || current.queueRequestId || c.view.running || c.view.uncertain || c.view.queuePending || c.view.queued || c.pending.size || c.view.prompts.length)
      throw new HttpError(409, 'Finish pending prompts, queued work and the native turn before changing its model. Uncertain operations must be resolved first.');
    return c;
  }
  function sameTarget(current: Session | undefined, claim: Claim) {
    const c = compatible();
    if (!current || c.socketEpoch !== claim.socketEpoch || current.runtimeId !== claim.runtimeId || c.row.runtimeId !== claim.runtimeId || current.storedId !== claim.storedId || c.row.storedId !== claim.storedId || current.profile !== claim.profile || c.row.profile !== claim.profile || c.view.profile !== claim.profile || c.view.nativeProfile !== claim.profile || current.connectionId !== connectionId)
      throw new HttpError(409, 'The native conversation changed after you reviewed the model. Choose it again.');
    return c;
  }
  async function lockAdmission(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    await hub.lockBoundary(tx);
    assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
  }
  async function currentChoices(c: NonNullable<ReturnType<typeof cached>>): Promise<NativeModelChoice[]> {
    const payload = await hub.socket.callConnected('model.options', { profile: row.profile, session_id: c.row.runtimeId,
      explicit_only: true, include_unconfigured: false, refresh: false }, c.socketEpoch, 30_000);
    return nativeModelChoices(payload);
  }
  if (input.operation === 'options') {
    const c = compatible();
    return { choices: await currentChoices(c), model: c.view.model, provider: c.view.provider, profile: row.profile, title: c.view.title };
  }
  if (input.operation === 'prepare') {
    const snapshot = compatible();
    const choice = resolveNativeModelChoice(await currentChoices(snapshot), input.model, input.provider);
    return db.transaction(async tx => {
      await lockAdmission(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
      const c = idle(current);
      if (c.socketEpoch !== snapshot.socketEpoch || current.runtimeId !== c.row.runtimeId || current.storedId !== c.row.storedId || current.profile !== c.row.profile || current.connectionId !== connectionId)
        throw new HttpError(409, 'Refresh the native conversation before choosing a model.');
      const claim: Claim = { requestId: randomUUID(), runtimeId: current.runtimeId!, storedId: current.storedId, profile: current.profile,
        socketEpoch: c.socketEpoch, model: choice.model, provider: choice.provider, confirmExpensiveModel: false, expiresAt: Date.now() + 60_000 };
      return { confirmation: encrypt(JSON.stringify(claim), binding), expiresAt: claim.expiresAt, ...choice,
        currentModel: c.view.model, currentProvider: c.view.provider, profile: current.profile, title: c.view.title };
    });
  }

  const claim = target!;
  const digest = createHash('sha256').update('session-model:v1:').update(JSON.stringify(claim)).digest('hex');
  const beforeReserve = compatible();
  const latestChoices = await currentChoices(beforeReserve);
  resolveNativeModelChoice(latestChoices, claim.model, claim.provider);
  const reserved = await db.transaction(async tx => {
    await lockAdmission(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, claim.requestId)));
    if (receipt) { if (receipt.digest !== digest) throw new HttpError(409, 'This confirmation receipt belongs to different model content.'); return null; }
    const c = idle(current); sameTarget(current, claim);
    if (c.socketEpoch !== beforeReserve.socketEpoch) throw new NativeConnectionChanged();
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId: claim.requestId, digest });
    return (await tx.update(remoteHermesSessions).set({ status: 'admitting', admissionRequestId: claim.requestId, admissionAt: new Date(), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, sessionId)).returning())[0];
  });
  if (!reserved) return { duplicate: true, output: 'This model confirmation was already submitted and will not be replayed. Refresh the native conversation to check its selected model.' };
  const c = cached()!; c.row = reserved; c.view.uncertain = true;
  let sent = false;
  let setterConfirmed = false;
  let setterRejectedWithoutMutation = false;
  let verified: { model: string; provider: string; title: string } | null = null;
  try {
    const { reply } = await db.transaction(async tx => {
      await lockAdmission(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
      const live = sameTarget(current, claim);
      if (claim.expiresAt <= Date.now() || !current || current.status !== 'admitting' || current.admissionRequestId !== claim.requestId || current.queueRequestId || live.view.running || live.view.queuePending || live.view.queued || live.pending.size || live.view.prompts.length)
        throw new HttpError(409, 'This model confirmation is no longer ready. Review the native conversation and choose again.');
      sent = true;
      return hub.socket.dispatchConnected('config.set', { profile: claim.profile, session_id: claim.runtimeId, scope: 'session', key: 'model',
        value: `${claim.model} --session --provider ${claim.provider}`, confirm_expensive_model: claim.confirmExpensiveModel }, claim.socketEpoch, 30_000, tx);
    });
    const result = await reply;
    if (result.key !== 'model' || result.scope !== 'session' || result.value !== claim.model)
      throw new HttpError(502, 'Hermes did not confirm a session-only model switch. Refresh native state before continuing.');
    if (result.confirm_required === true) {
      setterRejectedWithoutMutation = true;
      if (claim.confirmExpensiveModel || typeof result.confirm_message !== 'string' || !result.confirm_message.trim())
        throw new HttpError(502, 'Hermes returned an invalid model warning. Refresh before continuing.');
      if (result.confirm_message.length > 4_000)
        throw new HttpError(502, 'Hermes returned a model warning too long to display safely. No model change was made; refresh before continuing.');
      await settle('idle');
      const followup: Claim = { ...claim, requestId: randomUUID(), confirmExpensiveModel: true, expiresAt: Date.now() + 60_000 };
      const current = cached()!.view;
      return { confirmRequired: true, confirmation: encrypt(JSON.stringify(followup), binding), expiresAt: followup.expiresAt,
        warning: result.confirm_message, model: claim.model, provider: claim.provider,
        profile: claim.profile, title: current.title, currentModel: current.model, currentProvider: current.provider,
        output: result.confirm_message };
    }
    if (result.confirm_required !== false && claim.confirmExpensiveModel)
      throw new HttpError(502, 'Hermes did not confirm acceptance of its model warning. Refresh before continuing.');
    setterConfirmed = true;
    const latest = await hub.socket.callConnected('model.options', { profile: claim.profile, session_id: claim.runtimeId,
      explicit_only: true, include_unconfigured: false, refresh: false }, claim.socketEpoch, 30_000);
    if (latest.model !== claim.model || latest.provider !== claim.provider)
      throw new HttpError(502, 'Hermes did not report the selected model/provider for this native conversation. The outcome is uncertain; refresh before taking action.');
    const view = await hub.refresh(cached()!.row);
    if (view.model !== claim.model || view.provider !== claim.provider)
      throw new HttpError(502, 'The refreshed native session did not report the selected model/provider. The outcome is uncertain; refresh before taking action.');
    verified = { model: view.model, provider: view.provider, title: view.title };
  } catch (error) {
    const definitive = !sent || setterRejectedWithoutMutation || !setterConfirmed && (error instanceof NativeConnectionChanged || error instanceof NativeRpcError && [-32601, 4001].includes(error.code!));
    await settle(definitive ? 'idle' : 'uncertain');
    throw error;
  }
  await settle('idle');
  return { accepted: true, model: verified!.model, provider: verified!.provider, profile: claim.profile, title: verified!.title,
    output: `This conversation now uses ${verified!.model} · ${verified!.provider}. No prompt was sent. Its next explicit message may use the selected provider; other native clients sharing this conversation are affected.` };

  async function settle(status: 'idle' | 'uncertain') {
    const [updated] = await db.update(remoteHermesSessions).set({ status, admissionRequestId: status === 'idle' ? null : claim.requestId, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.status, 'admitting'), eq(remoteHermesSessions.admissionRequestId, claim.requestId))).returning();
    const live = cached();
    if (updated && live && live.row.admissionRequestId === claim.requestId && updated.revision >= live.row.revision) { live.row = updated; live.view.uncertain = status === 'uncertain'; }
  }
}
