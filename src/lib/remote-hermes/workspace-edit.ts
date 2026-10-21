import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { remoteHermesSessions, remoteHermesTurns } from '@/db/schema';
import { decrypt, encrypt, hmacSha256Hex, toolApprovalSecret } from '@/lib/crypto';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { assertRemoteHermesAdmission } from './policy';
import { ownedNativeSession, profileName } from './sessions';
import { nativeHub } from './hub';
import { remoteAccess } from './store';
import { NativeConnectionChanged, NativeRpcError } from './socket';
import { workspaceFilesProjection } from './operations';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relativeFile = z.string().min(1).max(1024).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.') &&
    !/(?:secret|credential|token|vault)/i.test(part) && !/^(?:auth\.(?:json|ya?ml)|config\.(?:json|ya?ml)|id_(?:rsa|ed25519)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i.test(part)),
  'Choose an existing visible workspace file.');
const textContent = z.string().max(256 * 1024).refine(value => Buffer.byteLength(value, 'utf8') <= 256 * 1024 && !value.includes('\0'),
  'The edited file must be UTF-8 text no larger than 256 KiB.');

export const workspaceFileEditInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), action: z.literal('file-edit'), workspaceId: z.string().regex(/^[a-f0-9]{32}$/),
    path: relativeFile, expectedSha256: digest, content: textContent }).strict(),
  z.object({ operation: z.literal('confirm-file-edit'), confirmation: z.string().min(1).max(4000), content: textContent }).strict(),
]);

const claimSchema = z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1).max(200), storedId: z.string().min(1).max(200),
  profile: profileName, socketEpoch: z.number().int().positive(), workspaceId: z.string().regex(/^[a-f0-9]{32}$/),
  path: relativeFile, expectedSha256: digest, contentSha256: digest, expiresAt: z.number().int() }).strict();
type Claim = z.infer<typeof claimSchema>;
type Session = typeof remoteHermesSessions.$inferSelect;
const aadFor = (owner: string, connection: string, session: string) => JSON.stringify(['remote-hermes-workspace-edit:v1', owner, connection, session]);

function readClaim(token: string, aad: string): Claim {
  try {
    const claim = claimSchema.parse(JSON.parse(decrypt(token, aad)));
    if (claim.expiresAt <= Date.now() || claim.expiresAt > Date.now() + 60_000) throw new Error();
    return claim;
  } catch { throw new HttpError(409, 'This file edit confirmation is invalid or expired. Reload the file and review the edit again.'); }
}

/** One-shot, digest-preconditioned writes through the exact-pin native workspace extension. */
export async function nativeWorkspaceFileEdit(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = workspaceFileEditInput.parse(raw);
  const initialRow = await ownedNativeSession(ownerId, connectionId, sessionId);
  assertRemoteHermesAdmission(await getSetting('remoteHermes'));
  const aad = aadFor(ownerId, connectionId, sessionId);
  const claim = input.operation === 'confirm-file-edit' ? readClaim(input.confirmation, aad) : null;
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(profile => profile.name === initialRow.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(initialRow);
  const cached = () => hub.sessions.get(sessionId);
  const row = cached()?.row ?? initialRow;

  function compatible(current: Session | undefined) {
    const live = cached();
    if (!live?.row.runtimeId || !live.socketEpoch || hub.socket.state !== 'connected' || live.socketEpoch !== hub.socket.connectionEpoch)
      throw new NativeConnectionChanged();
    if (!current || current.profile !== row.profile || live.row.profile !== row.profile || live.view.profile !== row.profile || live.view.nativeProfile !== row.profile ||
        current.storedId !== live.row.storedId || current.runtimeId !== live.row.runtimeId || current.connectionId !== connectionId)
      throw new HttpError(409, 'Refresh the selected Hermes chat before editing a workspace file.');
    return live;
  }
  function idle(current: Session | undefined) {
    const live = compatible(current);
    if (!current || current.status !== 'idle' || current.queueRequestId || live.view.running || live.view.uncertain || live.view.queuePending || live.view.queued || live.pending.size || live.view.prompts.length)
      throw new HttpError(409, 'Finish the native turn, queued work and pending prompts before editing this file. Resolve uncertain operations first.');
    return live;
  }
  function sameTarget(current: Session | undefined, value: Claim) {
    const live = compatible(current);
    if (!current || live.socketEpoch !== value.socketEpoch || current.runtimeId !== value.runtimeId || live.row.runtimeId !== value.runtimeId ||
        current.storedId !== value.storedId || live.row.storedId !== value.storedId || current.profile !== value.profile || live.row.profile !== value.profile ||
        live.view.profile !== value.profile || live.view.nativeProfile !== value.profile || current.connectionId !== connectionId)
      throw new HttpError(409, 'The native chat changed after file review. Reload it and review the edit again.');
    return live;
  }
  async function lockAdmission(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    await hub.lockBoundary(tx);
    assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
  }
  async function readFile(epoch: number, value: { workspaceId: string; path: string }) {
    const live = cached();
    if (!live?.row.runtimeId) throw new NativeConnectionChanged();
    const rawResult = await hub.socket.callConnected('collective.workspace.files', {
      profile: row.profile, session_id: live.row.runtimeId, action: 'read', workspace_id: value.workspaceId, path: value.path,
    }, epoch, 30_000);
    const result = workspaceFilesProjection(rawResult);
    if (!result.available || result.action !== 'read' || result.path !== value.path || result.workspaceId !== value.workspaceId || !result.sha256)
      throw new HttpError(409, 'This file is no longer available in the approved workspace. Refresh the file list.');
    return result;
  }

  if (input.operation === 'prepare') {
    const snapshot = idle(row);
    if (snapshot.socketEpoch !== hub.socket.connectionEpoch) throw new NativeConnectionChanged();
    const current = await readFile(snapshot.socketEpoch, input);
    if (current.sha256 !== input.expectedSha256) throw new HttpError(409, 'This file changed after it was loaded. Reload it before editing.');
    const claimValue: Claim = { requestId: randomUUID(), runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId,
      profile: row.profile, socketEpoch: snapshot.socketEpoch, workspaceId: input.workspaceId, path: input.path,
      expectedSha256: input.expectedSha256, contentSha256: createHash('sha256').update(input.content, 'utf8').digest('hex'), expiresAt: Date.now() + 60_000 };
    return { confirmation: encrypt(JSON.stringify(claimValue), aad), expiresAt: claimValue.expiresAt,
      path: claimValue.path, profile: row.profile, title: snapshot.view.title, bytes: Buffer.byteLength(input.content, 'utf8') };
  }

  if (createHash('sha256').update(input.content, 'utf8').digest('hex') !== claim!.contentSha256)
    throw new HttpError(409, 'The edited content changed after review. Review the current text again before saving.');
  const value = claim!;
  const identity = compatible(row);
  if (value.profile !== row.profile || value.runtimeId !== identity.row.runtimeId || value.storedId !== identity.row.storedId || value.socketEpoch !== identity.socketEpoch)
    throw new HttpError(409, 'The native chat changed after file review. Reload it and review the edit again.');
  const receiptDigest = hmacSha256Hex(toolApprovalSecret('native-hermes-workspace-edit-receipt:v1'), JSON.stringify(value));
  const [existingReceipt] = await db.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, value.requestId)));
  if (existingReceipt) {
    if (existingReceipt.digest !== receiptDigest) throw new HttpError(409, 'This file edit confirmation was already used for different content.');
    const current = await readFile(value.socketEpoch, value);
    const accepted = current.sha256 === value.contentSha256;
    return { accepted, duplicate: true, path: value.path,
      output: accepted ? 'This file edit was already applied and will not be replayed.' : 'This file edit was already submitted and will not be replayed. Reload the file to check its current contents.' };
  }

  const before = await readFile(value.socketEpoch, value);
  if (before.sha256 !== value.expectedSha256) throw new HttpError(409, 'This file changed after review. Reload it and review the edit again.');
  const preflight = idle(row);
  const reserved = await db.transaction(async tx => {
    await lockAdmission(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, value.requestId)));
    if (receipt) {
      if (receipt.digest !== receiptDigest) throw new HttpError(409, 'This file edit confirmation was already used for different content.');
      return null;
    }
    const live = idle(current);
    if (live.socketEpoch !== preflight.socketEpoch) throw new NativeConnectionChanged();
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId: value.requestId, digest: receiptDigest });
    return (await tx.update(remoteHermesSessions).set({ status: 'admitting', admissionRequestId: value.requestId,
      admissionAt: new Date(), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(eq(remoteHermesSessions.id, sessionId)).returning())[0];
  });
  if (!reserved) {
    const current = await readFile(value.socketEpoch, value);
    const accepted = current.sha256 === value.contentSha256;
    return { accepted, duplicate: true, path: value.path,
      output: accepted ? 'This file edit was already applied and will not be replayed.' : 'This file edit was already submitted and will not be replayed. Reload the file to check its current contents.' };
  }

  const live = cached()!;
  live.row = reserved; live.view.uncertain = true;
  let sent = false;
  try {
    const { reply } = await db.transaction(async tx => {
      await lockAdmission(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
      const active = sameTarget(current, value);
      if (value.expiresAt <= Date.now() || !current || current.status !== 'admitting' || current.admissionRequestId !== value.requestId || current.queueRequestId ||
          active.view.running || active.view.queuePending || active.view.queued || active.pending.size || active.view.prompts.length)
        throw new HttpError(409, 'This file edit is no longer ready. Reload the file and request a new confirmation.');
      sent = true;
      return hub.socket.dispatchConnected('collective.workspace.files.write.v1', {
        profile: value.profile, session_id: value.runtimeId, workspace_id: value.workspaceId, path: value.path,
        expected_sha256: value.expectedSha256, content: input.content,
      }, value.socketEpoch, 30_000, tx);
    });
    const replyValue = await reply;
    if (replyValue.protocol !== 'collective.workspace-file-write.v1' || replyValue.written !== true || replyValue.workspace_id !== value.workspaceId ||
        replyValue.path !== value.path || replyValue.sha256 !== value.contentSha256 || replyValue.bytes !== Buffer.byteLength(input.content, 'utf8'))
      throw new HttpError(502, 'Hermes did not confirm the requested file write. The result is uncertain; reload the file before taking action.');
    const latest = await readFile(value.socketEpoch, value);
    if (latest.sha256 !== value.contentSha256 || latest.content !== input.content)
      throw new HttpError(502, 'Hermes file readback did not match the reviewed text. The result is uncertain; reload the file before taking action.');
    await settle('idle');
    return { accepted: true, duplicate: false, path: value.path, sha256: latest.sha256, output: 'File saved and verified.' };
  } catch (error) {
    const definitive = !sent || error instanceof NativeConnectionChanged || error instanceof NativeRpcError && [-32601, 4001, 4090].includes(error.code!);
    await settle(definitive ? 'idle' : 'uncertain');
    throw error;
  }

  async function settle(status: 'idle' | 'uncertain') {
    const [updated] = await db.update(remoteHermesSessions).set({ status, admissionRequestId: status === 'idle' ? null : value.requestId,
      ...(status === 'idle' ? { admissionAt: null } : {}), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.status, 'admitting'), eq(remoteHermesSessions.admissionRequestId, value.requestId))).returning();
    const current = cached();
    if (updated && current && current.row.admissionRequestId === value.requestId && updated.revision >= current.row.revision) {
      current.row = updated;
      current.view.uncertain = status === 'uncertain';
    }
  }
}
