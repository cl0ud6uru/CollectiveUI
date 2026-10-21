import { randomUUID } from 'node:crypto';
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
import { NativeConnectionChanged, NativeRpcError, record } from './socket';
import { pluginSelectionProjection, projectProjection, scheduleProjection } from './operations';

export const projectOperationInput = z.union([
  z.object({ operation: z.literal('prepare'), action: z.literal('create'), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal('prepare'), action: z.literal('select'), projectId: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('prepare'), action: z.enum(['pause', 'resume']), scheduleId: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('prepare'), action: z.literal('plugin-selection'), enabled: z.boolean() }).strict(),
  z.object({ operation: z.literal('confirm'), confirmation: z.string().min(1).max(4000) }).strict(),
]);

const claimSchema = z.discriminatedUnion('action', [
  z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1).max(200), storedId: z.string().min(1).max(200), profile: profileName,
    socketEpoch: z.number().int().positive(), action: z.literal('create'), name: z.string().min(1).max(80), slug: z.string().regex(/^cu-[0-9a-f]{32}$/), expiresAt: z.number().int() }).strict(),
  z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1).max(200), storedId: z.string().min(1).max(200), profile: profileName,
    socketEpoch: z.number().int().positive(), action: z.literal('select'), projectId: z.string().min(1).max(200), projectName: z.string().max(300), expiresAt: z.number().int() }).strict(),
  z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1).max(200), storedId: z.string().min(1).max(200), profile: profileName,
    socketEpoch: z.number().int().positive(), action: z.literal('schedule'), scheduleAction: z.enum(['pause', 'resume']), scheduleId: z.string().min(1).max(200), scheduleName: z.string().max(300), scheduleState: z.string().max(100), enabled: z.boolean(), expiresAt: z.number().int() }).strict(),
  z.object({ requestId: z.string().uuid(), runtimeId: z.string().min(1).max(200), storedId: z.string().min(1).max(200), profile: profileName,
    socketEpoch: z.number().int().positive(), action: z.literal('plugin-selection'), enabled: z.boolean(),
    identityRevision: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int() }).strict(),
]);
type Claim = z.infer<typeof claimSchema>;
type Session = typeof remoteHermesSessions.$inferSelect;
const binding = (owner: string, connection: string, session: string) => JSON.stringify(['remote-hermes-project:v1', owner, connection, session]);
type ScheduleClaim = Extract<Claim, { action: 'schedule' }>;
const scheduleStillReady = (schedule: { enabled: boolean; state: string }, claim: ScheduleClaim) => schedule.state === claim.scheduleState &&
  (claim.scheduleAction === 'pause' ? schedule.enabled && schedule.state === 'scheduled' : schedule.state === 'paused' || schedule.state === 'error');
const scheduleMatches = (schedule: { enabled: boolean; state: string }, claim: ScheduleClaim) => claim.scheduleAction === 'pause'
  ? !schedule.enabled && schedule.state === 'paused'
  : schedule.enabled && schedule.state === 'scheduled';

function readClaim(token: string, aad: string): Claim {
  try {
    const claim = claimSchema.parse(JSON.parse(decrypt(token, aad)));
    if (claim.expiresAt <= Date.now() || claim.expiresAt > Date.now() + 60_000) throw new Error();
    return claim;
  } catch { throw new HttpError(409, 'This project confirmation is invalid or expired. Review the Hermes profile and try again.'); }
}

/** Project and schedule changes use only pinned native RPCs and never accept filesystem paths. */
export async function nativeProjectOperation(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = projectOperationInput.parse(raw);
  const initialRow = await ownedNativeSession(ownerId, connectionId, sessionId);
  assertRemoteHermesAdmission(await getSetting('remoteHermes'));
  const aad = binding(ownerId, connectionId, sessionId);
  const target = input.operation === 'confirm' ? readClaim(input.confirmation, aad) : null;
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(profile => profile.name === initialRow.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  const isPluginSelection = input.operation === 'prepare' ? input.action === 'plugin-selection' : target?.action === 'plugin-selection';
  // Native session.resume can initialize plugins while constructing its tool
  // inventory. Selection must only use an already-open matching owner-bound
  // runtime; its own native inspection proves current full-profile idleness.
  if (!isPluginSelection) await hub.refresh(initialRow);
  else if (!hub.sessions.has(sessionId)) throw new HttpError(409, 'Open the saved native chat before reviewing plugin selection.');
  const cached = () => hub.sessions.get(sessionId);
  // refresh can populate a missing runtime identity from Hermes; take the
  // persisted row it just reconciled as the comparison source for this action.
  const row = isPluginSelection ? initialRow : cached()?.row ?? initialRow;

  function compatible(current: Session | undefined) {
    const live = cached();
    if (!live?.row.runtimeId || !live.socketEpoch || hub.socket.state !== 'connected' || live.socketEpoch !== hub.socket.connectionEpoch)
      throw new NativeConnectionChanged();
    if (!current || current.profile !== row.profile || live.row.profile !== row.profile || live.view.profile !== row.profile || live.view.nativeProfile !== row.profile ||
      current.storedId !== live.row.storedId || current.runtimeId !== live.row.runtimeId || current.connectionId !== connectionId || live.row.connectionId !== connectionId)
      throw new HttpError(409, 'Refresh the selected Hermes chat before changing its project.');
    return live;
  }
  function idle(current: Session | undefined) {
    const live = compatible(current);
    if (!current || current.status !== 'idle' || current.queueRequestId || live.view.running || live.view.uncertain || live.view.queuePending || live.view.queued || live.pending.size || live.view.prompts.length)
      throw new HttpError(409, 'Finish the native turn, queued work and pending prompts before changing projects. Uncertain operations must be resolved first.');
    return live;
  }
  function sameTarget(current: Session | undefined, claim: Claim) {
    const live = compatible(current);
    if (!current || live.socketEpoch !== claim.socketEpoch || current.runtimeId !== claim.runtimeId || live.row.runtimeId !== claim.runtimeId ||
      current.storedId !== claim.storedId || live.row.storedId !== claim.storedId || current.profile !== claim.profile || live.row.profile !== claim.profile ||
      live.view.profile !== claim.profile || live.view.nativeProfile !== claim.profile || current.connectionId !== connectionId)
      throw new HttpError(409, 'The native chat changed after confirmation. Review it and request a new confirmation.');
    return live;
  }
  async function lockAdmission(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
    await hub.lockBoundary(tx);
    assertRemoteHermesAdmission(await getSetting('remoteHermes', tx));
  }
  async function projects(epoch: number) {
    return projectProjection(await hub.socket.callConnected('projects.list', { profile: row.profile }, epoch, 30_000));
  }
  async function projectByIdentity(epoch: number, idOrSlug: string) {
    try {
      return record(record(await hub.socket.callConnected('projects.get', { profile: row.profile, id: idOrSlug }, epoch, 30_000)).project);
    } catch (error) {
      // Pinned Hermes resolves the project id first and the slug second; 5062
      // is its exact not-found response. Unsupported or transport errors fail closed.
      if (error instanceof NativeRpcError && error.code === 5062) return null;
      throw error;
    }
  }
  async function schedules(epoch: number) {
    const value = record(await hub.socket.callConnected('cron.manage', { profile: row.profile, action: 'list', include_disabled: true }, epoch, 30_000));
    if (value.scoped !== row.profile) throw new HttpError(501, 'This Hermes version cannot confirm profile-scoped schedules.');
    return scheduleProjection(value);
  }
  async function selection(epoch: number) {
    return pluginSelectionProjection(await hub.socket.callConnected('collective.plugins.selection.v1',
      { profile: row.profile, session_id: cached()!.row.runtimeId, action: 'inspect' }, epoch, 30_000));
  }
  async function previousSelection(epoch: number) {
    return { confirmation: undefined, accepted: false, duplicate: true, pluginSelection: await selection(epoch),
      output: 'This selection request was already submitted and will not be replayed. The current stored preference is shown; runtime loaded state is unreported.' };
  }

  if (input.operation === 'prepare') {
    const snapshot = idle(row);
    if (snapshot.socketEpoch !== hub.socket.connectionEpoch) throw new NativeConnectionChanged();
    let claim: Claim;
    if (input.action === 'create') {
      const requestId = randomUUID();
      const slug = `cu-${requestId.replaceAll('-', '')}`;
      if (await projectByIdentity(snapshot.socketEpoch, slug)) throw new HttpError(409, 'This project request already appears in Hermes. Refresh the list instead of creating it again.');
      claim = { requestId, runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId, profile: row.profile, socketEpoch: snapshot.socketEpoch,
        action: 'create', name: input.name, slug, expiresAt: Date.now() + 60_000 };
    } else if (input.action === 'select') {
      const listed = await projects(snapshot.socketEpoch);
      const project = listed.projects.find(value => value.id === input.projectId);
      if (!project || project.archived) throw new HttpError(409, 'Choose an active project from the refreshed Hermes list.');
      claim = { requestId: randomUUID(), runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId, profile: row.profile, socketEpoch: snapshot.socketEpoch,
        action: 'select', projectId: project.id, projectName: project.name, expiresAt: Date.now() + 60_000 };
    } else if (input.action === 'plugin-selection') {
      const current = await selection(snapshot.socketEpoch);
      if (current.selected === input.enabled) throw new HttpError(409, 'This stored plugin selection already matches. Refresh before reviewing a change.');
      claim = { requestId: randomUUID(), runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId, profile: row.profile,
        socketEpoch: snapshot.socketEpoch, action: 'plugin-selection', enabled: input.enabled,
        identityRevision: current.identityRevision, expectedRevision: current.revision, expiresAt: Date.now() + 60_000 };
    } else {
      const listed = await schedules(snapshot.socketEpoch);
      const schedule = listed.schedules.find(value => value.id === input.scheduleId);
      const resumable = schedule && (schedule.state === 'paused' || schedule.state === 'error');
      if (!schedule || input.action === 'pause' && (!schedule.enabled || schedule.state !== 'scheduled') || input.action === 'resume' && !resumable)
        throw new HttpError(409, 'Only a scheduled job can be paused, and only paused or recoverable error jobs can be resumed.');
      claim = { requestId: randomUUID(), runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId, profile: row.profile, socketEpoch: snapshot.socketEpoch,
        action: 'schedule', scheduleAction: input.action, scheduleId: schedule.id, scheduleName: schedule.name, scheduleState: schedule.state, enabled: input.action === 'resume', expiresAt: Date.now() + 60_000 };
    }
    return { confirmation: encrypt(JSON.stringify(claim), aad), expiresAt: claim.expiresAt, action: claim.action, enabled: claim.action === 'schedule' || claim.action === 'plugin-selection' ? claim.enabled : undefined,
      name: claim.action === 'create' ? claim.name : claim.action === 'select' ? claim.projectName : claim.action === 'plugin-selection' ? 'teams_pipeline' : claim.scheduleName,
      profile: row.profile, title: snapshot.view.title };
  }

  const claim = target!;
  const identity = compatible(row);
  if (claim.profile !== row.profile || claim.runtimeId !== identity.row.runtimeId || claim.storedId !== identity.row.storedId || claim.socketEpoch !== identity.socketEpoch)
    throw new HttpError(409, 'The native chat changed after confirmation. Review it and request a new confirmation.');
  const digest = hmacSha256Hex(toolApprovalSecret('native-hermes-project-receipt:v1'), JSON.stringify(claim));
  const [existingReceipt] = await db.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, claim.requestId)));
  if (existingReceipt) {
    if (existingReceipt.digest !== digest) throw new HttpError(409, 'This project confirmation was already used for different content.');
    if (claim.action === 'plugin-selection') return previousSelection(claim.socketEpoch);
    if (claim.action === 'schedule') {
      const current = await schedules(claim.socketEpoch);
      const complete = current.schedules.some(schedule => schedule.id === claim.scheduleId && scheduleMatches(schedule, claim));
      return { accepted: complete, duplicate: true, schedules: current.schedules,
        output: complete ? 'This schedule request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
    }
    const current = await projects(claim.socketEpoch);
    const complete = claim.action === 'create'
      ? await projectByIdentity(claim.socketEpoch, claim.slug).then(project => !!project && project.slug === claim.slug && project.name === claim.name && Array.isArray(project.folders) && project.folders.length === 0)
      : current.activeId === claim.projectId && current.projects.some(project => project.id === claim.projectId && !project.archived);
    return { accepted: complete, duplicate: true, projects: current.projects, activeId: current.activeId,
      output: complete ? 'This project request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
  }
  if (claim.action === 'schedule') {
    const listed = await schedules(claim.socketEpoch);
    const current = listed.schedules.find(schedule => schedule.id === claim.scheduleId);
    if (!current || !scheduleStillReady(current, claim)) throw new HttpError(409, 'This schedule changed after confirmation. Refresh the schedule list and review it again.');
  } else if (claim.action === 'plugin-selection') {
    const current = await selection(claim.socketEpoch);
    if (current.identityRevision !== claim.identityRevision || current.revision !== claim.expectedRevision)
      throw new HttpError(409, 'The stored selection or reviewed plugin package changed. Refresh and review it again.');
  } else {
    const listed = await projects(claim.socketEpoch);
    if (claim.action === 'select' && !listed.projects.some(project => project.id === claim.projectId && !project.archived))
      throw new HttpError(409, 'The chosen project changed after confirmation. Refresh the list and choose it again.');
    if (claim.action === 'create' && await projectByIdentity(claim.socketEpoch, claim.slug))
      throw new HttpError(409, 'This project request already appears in Hermes. Refresh the list instead of creating it again.');
  }
  const preflight = idle(row);
  const reserved = await db.transaction(async tx => {
    await lockAdmission(tx);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, claim.requestId)));
    if (receipt) {
      if (receipt.digest !== digest) throw new HttpError(409, 'This project confirmation was already used for different content.');
      return null;
    }
    const live = idle(current);
    if (live.socketEpoch !== preflight.socketEpoch) throw new NativeConnectionChanged();
    await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId: claim.requestId, digest });
    return (await tx.update(remoteHermesSessions).set({ status: 'admitting', admissionRequestId: claim.requestId,
      admissionAt: new Date(), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(eq(remoteHermesSessions.id, sessionId)).returning())[0];
  });
  if (!reserved) {
    if (claim.action === 'plugin-selection') return previousSelection(claim.socketEpoch);
    if (claim.action === 'schedule') {
      const current = await schedules(claim.socketEpoch);
      const complete = current.schedules.some(schedule => schedule.id === claim.scheduleId && scheduleMatches(schedule, claim));
      return { accepted: complete, duplicate: true, schedules: current.schedules,
        output: complete ? 'This schedule request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
    }
    const current = await projects(claim.socketEpoch);
    const complete = claim.action === 'create'
      ? await projectByIdentity(claim.socketEpoch, claim.slug).then(project => !!project && project.slug === claim.slug && project.name === claim.name && Array.isArray(project.folders) && project.folders.length === 0)
      : current.activeId === claim.projectId && current.projects.some(project => project.id === claim.projectId && !project.archived);
    return { accepted: complete, duplicate: true, projects: current.projects, activeId: current.activeId,
      output: complete ? 'This request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
  }

  const live = cached()!;
  live.row = reserved; live.view.uncertain = true;
  let sent = false;
  try {
    const { reply } = await db.transaction(async tx => {
      await lockAdmission(tx);
      const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
      const active = sameTarget(current, claim);
      if (claim.expiresAt <= Date.now() || !current || current.status !== 'admitting' || current.admissionRequestId !== claim.requestId || current.queueRequestId ||
        active.view.running || active.view.queuePending || active.view.queued || active.pending.size || active.view.prompts.length)
        throw new HttpError(409, 'This project confirmation is no longer ready. Review the Hermes chat and confirm again.');
      sent = true;
      const method = claim.action === 'create' ? 'projects.create' : claim.action === 'select' ? 'projects.set_active' : claim.action === 'plugin-selection' ? 'collective.plugins.selection.v1' : 'cron.manage';
      const params = claim.action === 'create'
        ? { profile: claim.profile, name: claim.name, slug: claim.slug, folders: [], use: false }
        : claim.action === 'select' ? { profile: claim.profile, id: claim.projectId }
          : claim.action === 'plugin-selection' ? { profile: claim.profile, session_id: claim.runtimeId, action: 'select', key: 'teams_pipeline',
            expected_identity: claim.identityRevision, expected_revision: claim.expectedRevision, enabled: claim.enabled }
            : { profile: claim.profile, action: claim.scheduleAction, name: claim.scheduleId };
      return hub.socket.dispatchConnected(method, params, claim.socketEpoch, 30_000, tx);
    });
    const replyValue = await reply;
    if (claim.action === 'plugin-selection') {
      const changed = pluginSelectionProjection(replyValue), latest = await selection(claim.socketEpoch);
      if (changed.identityRevision !== claim.identityRevision || changed.selected !== claim.enabled || changed.revision === claim.expectedRevision ||
        latest.identityRevision !== changed.identityRevision || latest.revision !== changed.revision || latest.selected !== claim.enabled)
        throw new HttpError(502, 'Native selection readback did not match. Refresh before taking action; this request will not replay.');
      await settle('idle');
      return { accepted: true, duplicate: false, pluginSelection: latest,
        output: 'Pending plugin preference stored. Explicit local operator confirmation is required before subsequent native initializations, including worker starts, may use it. No plugin was activated or reloaded; loaded state is unreported.' };
    }
    let createdId: string | undefined;
    if (claim.action === 'create') {
      const created = record(replyValue.project);
      if (typeof created.id !== 'string' || created.slug !== claim.slug || created.name !== claim.name || !Array.isArray(created.folders) || created.folders.length !== 0)
        throw new HttpError(502, 'Hermes did not confirm the requested empty project. Refresh before continuing.');
      createdId = created.id;
    } else if (claim.action === 'select' && replyValue.active_id !== claim.projectId) {
      throw new HttpError(502, 'Hermes did not confirm the selected active project. Refresh before continuing.');
    } else if (claim.action === 'schedule') {
      const changed = record(replyValue.job);
      if (replyValue.success !== true || changed.job_id !== claim.scheduleId || !scheduleMatches({ enabled: changed.enabled === true, state: String(changed.state ?? '') }, claim))
        throw new HttpError(502, 'Hermes did not confirm the requested schedule state. Refresh before continuing.');
    }
    if (claim.action === 'schedule') {
      const latest = await schedules(claim.socketEpoch);
      if (!latest.schedules.some(schedule => schedule.id === claim.scheduleId && scheduleMatches(schedule, claim)))
        throw new HttpError(502, 'Hermes readback did not match the requested schedule state. The result is uncertain; refresh before taking action.');
      await settle('idle');
      return { accepted: true, duplicate: false, schedules: latest.schedules, output: claim.enabled ? 'Schedule resumed; it may run soon and use model usage.' : 'Schedule paused.' };
    }
    const latest = await projects(claim.socketEpoch);
    const target = claim.action === 'create' ? await projectByIdentity(claim.socketEpoch, createdId!) : null;
    const matched = claim.action === 'create'
      ? !!target && target.id === createdId && target.slug === claim.slug && target.name === claim.name && Array.isArray(target.folders) && target.folders.length === 0
      : latest.activeId === claim.projectId && latest.projects.some(project => project.id === claim.projectId);
    if (!matched) throw new HttpError(502, 'Hermes project readback did not match the requested change. The result is uncertain; refresh before taking action.');
    await settle('idle');
    return { accepted: true, duplicate: false, projects: latest.projects, activeId: latest.activeId,
      output: claim.action === 'create' ? `Created empty project “${claim.name}”.` : 'Active project changed.' };
  } catch (error) {
    const definitive = !sent || error instanceof NativeConnectionChanged || error instanceof NativeRpcError && [-32601, 4001].includes(error.code!);
    await settle(definitive ? 'idle' : 'uncertain');
    throw error;
  }

  async function settle(status: 'idle' | 'uncertain') {
    const [updated] = await db.update(remoteHermesSessions).set({ status, admissionRequestId: status === 'idle' ? null : claim.requestId,
      ...(status === 'idle' ? { admissionAt: null } : {}), revision: sql`${remoteHermesSessions.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(remoteHermesSessions.id, sessionId), eq(remoteHermesSessions.status, 'admitting'), eq(remoteHermesSessions.admissionRequestId, claim.requestId))).returning();
    const current = cached();
    if (updated && current && current.row.admissionRequestId === claim.requestId && updated.revision >= current.row.revision) {
      current.row = updated;
      current.view.uncertain = status === 'uncertain';
    }
  }
}
