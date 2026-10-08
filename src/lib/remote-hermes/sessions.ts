import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '@/db';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, settings } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { assertRemoteHermesAdmission } from './policy';
import { yoloStatusText } from './yolo-contract';
import { remoteAccess } from './store';
import { nativeHub } from './hub';
import { NativeRpcError, record, type RpcRecord } from './socket';
import { nativeCommandCatalog, nativeCommandResult, parseNativeInput, resolveNativeCommand } from './commands';

export const profileName = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/);
export type NativeUpload = { name: string; type: string; bytes: Buffer };
const pageOffset = z.number().int().min(0).max(100000);
const active = (status: string) => status !== 'idle';
export async function ownedNativeSession(ownerId: string, connectionId: string, sessionId: string) {
  const [row] = await db.select({ session: remoteHermesSessions }).from(remoteHermesSessions)
    .innerJoin(remoteHermesConnections, eq(remoteHermesConnections.id, remoteHermesSessions.connectionId))
    .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesConnections.id, connectionId), eq(remoteHermesConnections.userId, ownerId)));
  if (!row) throw new HttpError(404, 'Native Hermes chat not found.');
  return row.session;
}
async function admission(tx: Tx) {
  await tx.select().from(settings).where(eq(settings.key, 'remoteHermes')).for('share');
  assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
}
export async function browseNativeSessions(ownerId: string, connectionId: string, rawProfile: string, offset = 0) {
  pageOffset.parse(offset);
  const profile = profileName.parse(rawProfile);
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === profile)) throw new HttpError(404, 'Hermes profile not found.');
  const page = await access.client.sessionPage(profile, offset);
  const linked = await db.select({ id: remoteHermesSessions.id, storedId: remoteHermesSessions.storedId, title: remoteHermesSessions.title, profile: remoteHermesSessions.profile, status: remoteHermesSessions.status }).from(remoteHermesSessions)
    .where(and(eq(remoteHermesSessions.connectionId, connectionId), eq(remoteHermesSessions.profile, profile))).orderBy(desc(remoteHermesSessions.updatedAt));
  return { ...page, linked };
}
export async function openNativeSession(ownerId: string, connectionId: string, rawProfile: string, storedId?: string, offset = 0) {
  pageOffset.parse(offset);
  const profile = profileName.parse(rawProfile);
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(p => p.name === profile)) throw new HttpError(404, 'Hermes profile not found.');
  let title = 'New Hermes chat';
  if (storedId) {
    const found = (await access.client.sessions(profile, offset)).find(s => s.id === storedId);
    if (!found) throw new HttpError(404, 'Choose a conversation listed by this Hermes profile.');
    title = found.title || title;
  } else {
    const created = await nativeHub(ownerId, connectionId).socket.call('session.create', { profile });
    storedId = typeof created.stored_session_id === 'string' ? created.stored_session_id : typeof record(created.info).stored_session_id === 'string' ? String(record(created.info).stored_session_id) : undefined;
    if (!storedId) throw new HttpError(502, 'Hermes did not return a saved session identity.');
  }
  const row = await db.transaction(async tx => {
    await admission(tx);
    const [existing] = await tx.select().from(remoteHermesSessions).where(and(eq(remoteHermesSessions.connectionId, connectionId), eq(remoteHermesSessions.profile, profile), eq(remoteHermesSessions.storedId, storedId!)));
    if (existing) return existing;
    return (await tx.insert(remoteHermesSessions).values({ id: newId(), connectionId, profile, storedId: storedId!, title }).returning())[0];
  });
  return nativeHub(ownerId, connectionId).refresh(row);
}
export async function nativeSnapshot(ownerId: string, connectionId: string, sessionId: string) {
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  const policy = await getSetting('remoteHermes');
  const hub = nativeHub(ownerId, connectionId);
  if (!policy.enabled && !active(row.status)) {
    return hub.retainedView(row);
  }
  return { ...await hub.view(row), admissionAllowed: policy.enabled, yoloAllowed: policy.enabled && policy.allowSessionYolo === true };
}
/** Read history only for a persisted, owned binding; native IDs are never accepted from the browser. */
export async function nativeHistory(ownerId: string, connectionId: string, sessionId: string, offset: number) {
  pageOffset.parse(offset);
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  if (!(await getSetting('remoteHermes')).enabled && !active(row.status)) throw new HttpError(403, 'Personal remote Hermes is disabled. Saved conversations are retained.');
  const access = await remoteAccess(ownerId, connectionId, 'continuation');
  return access.client.history(row.profile, row.storedId, offset);
}
/** Admission receipts are written before any upload or prompt RPC, so retrying an HTTP request never replays work. */
export async function submitNativePrompt(ownerId: string, connectionId: string, sessionId: string, requestId: string, text: string, uploads: NativeUpload[] = []) {
  z.string().uuid().parse(requestId);
  if (!text.trim() && !uploads.length) throw new HttpError(400, 'Enter a message or attach a file.');
  if (text.length > 64000) throw new HttpError(400, 'This Hermes message is too large.');
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  const parsed = parseNativeInput(text);
  if (parsed.kind !== 'text') throw new HttpError(400, parsed.kind === 'shell'
    ? '! is CLI shell syntax, not a remote command. /yolo shows approval status.'
    : 'Run slash commands through Commands & skills. Remove attachments first, or use // to send literal slash text.');
  text = parsed.text;
  const policy = await getSetting('remoteHermes'); assertRemoteHermesAdmission(policy);
  const hub = nativeHub(ownerId, connectionId);
  const view = await hub.refresh(row);
  const digest = createHash('sha256').update(text);
  for (const file of uploads) digest.update(JSON.stringify([file.name, file.type, file.bytes.length])).update(file.bytes);
  const contentDigest = digest.digest('hex');
  const accepted = await db.transaction(async tx => {
    await admission(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, requestId)));
    if (receipt) {
      if (receipt.digest !== contentDigest) throw new HttpError(409, 'This message receipt belongs to different content.');
      return false;
    }
    if (!current || active(current.status) || current.queueRequestId || view.running) throw new HttpError(409, 'Finish or stop the native turn before sending another message. Use steering to correct an active turn.');
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId, digest: contentDigest });
    return (await tx.update(remoteHermesSessions).set({ status: 'admitting', admissionRequestId: requestId, revision: sql`${remoteHermesSessions.revision} + 1`, admissionAt: new Date(), updatedAt: new Date() }).where(eq(remoteHermesSessions.id, sessionId)).returning())[0];
  });
  if (!accepted) return { accepted: true, duplicate: true };
  const cached = hub.sessions.get(row.id)!;
  cached.row = accepted; cached.view.uncertain = true;
  const params = { profile: row.profile, session_id: cached.row.runtimeId };
  let outgoing = text;
  const imagePaths: string[] = [];
  try {
    for (const file of uploads) {
      let attached: RpcRecord;
      if (file.type.startsWith('image/')) {
        attached = await hub.socket.call('image.attach_bytes', { ...params, filename: file.name, content_base64: file.bytes.toString('base64') });
        if (typeof attached.path === 'string') imagePaths.push(attached.path);
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        attached = await hub.socket.call('pdf.attach', { ...params, filename: file.name, content_base64: file.bytes.toString('base64') }, 60_000);
        for (const page of Array.isArray(attached.pages) ? attached.pages : []) if (typeof record(page).path === 'string') imagePaths.push(String(record(page).path));
      } else {
        attached = await hub.socket.call('file.attach', { ...params, name: file.name, data_url: `data:${file.type || 'application/octet-stream'};base64,${file.bytes.toString('base64')}` });
        if (typeof attached.ref_text === 'string') outgoing += `\n${attached.ref_text}`;
      }
      if (attached.attached !== true) throw new HttpError(502, 'Hermes could not attach this file. No prompt was sent.');
    }
    const result = await hub.socket.call('prompt.submit', { ...params, text: outgoing });
    if (!['streaming', 'queued'].includes(String(result.status))) throw new HttpError(409, 'Hermes did not confirm turn admission. Refresh this session before continuing.');
    await settlePrompt('running');
    return { accepted: true, duplicate: false };
  } catch (error) {
    for (const imagePath of imagePaths) { try { await hub.socket.call('image.detach', { ...params, path: imagePath }); } catch {} }
    await settlePrompt('uncertain');
    throw error;
  }
  async function settlePrompt(status: 'running' | 'uncertain') {
    const [updated] = await db.update(remoteHermesSessions).set({ status, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.status, 'admitting'), eq(remoteHermesSessions.admissionRequestId, requestId))).returning();
    const current = hub.sessions.get(row.id);
    if (updated && current && current.row.admissionRequestId === requestId && updated.revision >= current.row.revision) {
      current.row = updated; current.view.uncertain = status === 'uncertain';
    }
    // message.start may have confirmed this request before its RPC reply arrived.
    if (status === 'running' && current?.row.admissionRequestId === requestId) current.view.uncertain = current.row.queueStatus === 'uncertain';
  }
}
export async function nativeControl(ownerId: string, connectionId: string, sessionId: string, operation: 'stop' | 'steer' | 'answer' | 'catalog' | 'context' | 'command' | 'queue', input: RpcRecord = {}) {
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  const policy = await getSetting('remoteHermes');
  if (['steer', 'command', 'catalog', 'context', 'queue'].includes(operation)) assertRemoteHermesAdmission(policy);
  else if (!policy.enabled && !active(row.status)) throw new HttpError(409, 'This native turn has already finished. New work is disabled.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(row);
  const cached = hub.sessions.get(row.id)!;
  const params = { session_id: cached.row.runtimeId, profile: row.profile };
  if (operation === 'answer') return hub.answer(row, z.string().max(200).parse(input.requestId), input.answer);
  if (operation === 'stop') return hub.socket.call('session.interrupt', params);
  if (operation === 'steer') {
    if (!cached.view.running) throw new HttpError(409, 'This native turn has already finished.');
    return hub.socket.call('session.steer', { ...params, text: z.string().min(1).max(4000).parse(input.text) });
  }
  if (operation === 'catalog') return readCatalog();
  if (operation === 'context') return hub.socket.call('session.context_breakdown', params);
  if (operation === 'queue') {
    const text = z.string().min(1).max(4000).parse(input.text);
    const requestId = z.string().uuid().parse(input.requestId);
    const digest = createHash('sha256').update('queue:').update(text).digest('hex');
    const reservation = await reserveControl(row.id, requestId, digest, false, cached.view.running && !cached.view.queued);
    if (!reservation) return { accepted: true, duplicate: true };
    cached.row = reservation; cached.view.queuePending = true;
    try {
      const result = await hub.socket.call('prompt.submit', { ...params, text, queued: true });
      if (!['queued', 'streaming'].includes(String(result.status))) throw new HttpError(409, 'Hermes did not confirm the queued message. Refresh before trying again.');
      if (await settleQueue('queued')) {
        const current = hub.sessions.get(row.id)!;
        if (current.row.queueRequestId === requestId && current.row.queueStatus === 'queued') current.view.queued = result.status === 'queued' ? text : '';
      }
      return { accepted: true };
    } catch (error) {
      // Only method-not-found proves dispatch never occurred. Other errors may follow side effects.
      await settleQueue(error instanceof NativeRpcError && error.code === -32601 ? null : 'uncertain');
      throw error;
    }
    async function settleQueue(queueStatus: 'queued' | 'uncertain' | null) {
      const [updated] = await db.update(remoteHermesSessions).set({ queueStatus, queueRequestId: queueStatus ? requestId : null,
        revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
        .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.queueRequestId, requestId))).returning();
      const current = hub.sessions.get(row.id);
      if (updated && current && current.row.queueRequestId === requestId && updated.revision >= current.row.revision) {
        current.row = updated; current.view.queuePending = !!updated.queueRequestId; current.view.uncertain = queueStatus === 'uncertain'; return true;
      }
      return false;
    }
  }
  const catalog = await readCatalog();
  let selected: ReturnType<typeof resolveNativeCommand>;
  try { selected = resolveNativeCommand(z.string().min(1).max(2000).parse(input.text), catalog); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Unsupported Hermes command.'); }
  if (selected.kind === 'local') {
    if (selected.value === '/yolo' && ['on', 'off'].includes(selected.args)) throw new HttpError(409, 'Use the confirmed session YOLO control. Review and confirm the exact on/off action; no mode was changed.');
    if (selected.value === '/commands') return { output: catalog.commands.map(c => `${c.value} — ${c.description}${c.available ? '' : ' (unavailable here)'}`).join('\n') + (catalog.warning ? `\n${catalog.warning}` : '') };
    if (selected.value === '/context') return { output: JSON.stringify(await hub.socket.call('session.context_breakdown', params), null, 2) };
    if (selected.value === '/stop') return { ...await hub.socket.call('session.interrupt', params), output: 'Stop requested. Check the native turn for completion.' };
    return { output: yoloStatusText(cached.view) + ' Use /yolo on or /yolo off for a policy-controlled confirmation. Profile-wide approval policy cannot be changed here.' };
  }
  const command = selected.command;
  const requestId = z.string().uuid().parse(input.requestId);
  const reservation = await reserveControl(row.id, requestId, createHash('sha256').update('command:').update(command).digest('hex'), true, !cached.view.running);
  if (!reservation) return { output: 'This command was already submitted. Refresh its native session to see the outcome.' };
  cached.row = reservation; cached.view.uncertain = true;
  // Native dispatch results that request inference are returned as composer prefills, never auto-submitted.
  let result: RpcRecord;
  try {
    // Known skills intentionally refuse slash.exec with 4018. Dispatch them directly after catalog validation;
    // 4018 is ALSO used for failures after side effects, so it is never a general retry signal.
    try { result = selected.kind === 'skill'
      ? await hub.socket.call('command.dispatch', { ...params, name: selected.value.slice(1), arg: selected.args }, 60_000)
      : await hub.socket.call('slash.exec', { ...params, command }, 60_000); }
    catch (error) {
      if (selected.kind === 'skill' || !(error instanceof NativeRpcError) || error.code !== -32601) throw error;
      const [name, ...words] = command.split(/\s+/);
      result = await hub.socket.call('command.dispatch', { ...params, name, arg: words.join(' ') }, 60_000);
    }
  } catch (error) {
    await settleCommand(error instanceof NativeRpcError && error.code === -32601 ? 'idle' : 'uncertain');
    throw error;
  }
  await settleCommand('idle');
  await hub.refresh(hub.sessions.get(row.id)!.row);
  return nativeCommandResult(result);
  async function readCatalog() {
    try { return nativeCommandCatalog(await hub.socket.call('commands.catalog', params)); }
    catch (e) {
      if (!(e instanceof NativeRpcError) || e.code !== -32601) throw e;
      return nativeCommandCatalog(null);
    }
  }
  async function settleCommand(status: 'idle' | 'uncertain') {
    const [updated] = await db.update(remoteHermesSessions).set({ status, admissionRequestId: status === 'idle' ? null : requestId, revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.status, 'admitting'), eq(remoteHermesSessions.admissionRequestId, requestId))).returning();
    const current = hub.sessions.get(row.id);
    if (updated && current && current.row.admissionRequestId === requestId && updated.revision >= current.row.revision) { current.row = updated; current.view.uncertain = status === 'uncertain'; }
  }
}

async function reserveControl(sessionId: string, requestId: string, digest: string, requireIdle: boolean, nativeAllows: boolean) {
  return db.transaction(async tx => {
    await admission(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, requestId)));
    if (receipt) {
      if (receipt.digest !== digest) throw new HttpError(409, 'This receipt belongs to another native operation.');
      return null;
    }
    if (!current || !nativeAllows || current.queueRequestId || (requireIdle ? current.status !== 'idle' : !['running', 'waiting'].includes(current.status))) throw new HttpError(409, 'This native session has unfinished work.');
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId, digest });
    return (await tx.update(remoteHermesSessions).set({ ...(requireIdle ? { status: 'admitting' as const, admissionRequestId: requestId, admissionAt: new Date() }
      : { queueRequestId: requestId, queueStatus: 'admitting' as const }), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() }).where(eq(remoteHermesSessions.id, sessionId)).returning())[0];
  });
}
