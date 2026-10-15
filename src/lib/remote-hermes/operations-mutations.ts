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
import { pluginProjection, projectProjection, scheduleProjection } from './operations';

export const workspaceOperationInput = z.union([
  z.object({ operation: z.literal('prepare'), action: z.literal('create'), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal('prepare'), action: z.literal('select'), projectId: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('prepare'), action: z.enum(['pause', 'resume']), scheduleId: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('prepare'), action: z.enum(['enable-plugin', 'disable-plugin']), pluginKey: z.string().min(1).max(300) }).strict(),
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
    socketEpoch: z.number().int().positive(), action: z.literal('plugin'), pluginKey: z.string().min(1).max(300), pluginName: z.string().max(300), enabled: z.boolean(), expiresAt: z.number().int() }).strict(),
]);
type Claim = z.infer<typeof claimSchema>;
type Session = typeof remoteHermesSessions.$inferSelect;
const binding = (owner: string, connection: string, session: string) => JSON.stringify(['remote-hermes-workspace:v1', owner, connection, session]);
const pluginState = (status: string) => status === 'enabled' ? true : status === 'disabled' || status === 'not enabled' ? false : null;
type ListedPlugin = { key: string; name: string; status: string; source: string };
function listedUserPlugin(plugins: ListedPlugin[], key: string, name?: string) {
  // Hermes' resolver accepts either the manifest name OR the canonical key and
  // returns the first discovery-order match. A key unique in the key column is
  // still unsafe when it equals another plugin's manifest name.
  const matches = plugins.filter(plugin => plugin.key === key || plugin.name === key);
  if (matches.length !== 1) return undefined;
  const plugin = matches[0];
  if (!plugin.key || plugin.key !== key || plugin.source !== 'user' || !plugin.name || name !== undefined && plugin.name !== name ||
    !['enabled', 'disabled', 'not enabled'].includes(plugin.status)) return undefined;
  return plugin;
}
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
  } catch { throw new HttpError(409, 'This Hermes confirmation is invalid or expired. Review the profile and try again.'); }
}

/** Project and schedule changes use only pinned native RPCs and never accept filesystem paths. */
export async function nativeWorkspaceOperation(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = workspaceOperationInput.parse(raw);
  const initialRow = await ownedNativeSession(ownerId, connectionId, sessionId);
  assertRemoteHermesAdmission(await getSetting('remoteHermes'));
  const aad = binding(ownerId, connectionId, sessionId);
  const target = input.operation === 'confirm' ? readClaim(input.confirmation, aad) : null;
  const access = await remoteAccess(ownerId, connectionId, 'admission');
  if (!(await access.client.profiles()).some(profile => profile.name === initialRow.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  await hub.refresh(initialRow);
  const cached = () => hub.sessions.get(sessionId);
  // refresh can populate a missing runtime identity from Hermes; take the
  // persisted row it just reconciled as the comparison source for this action.
  const row = cached()?.row ?? initialRow;

  function compatible(current: Session | undefined) {
    const live = cached();
    if (!live?.row.runtimeId || !live.socketEpoch || hub.socket.state !== 'connected' || live.socketEpoch !== hub.socket.connectionEpoch)
      throw new NativeConnectionChanged();
    if (!current || current.profile !== row.profile || live.row.profile !== row.profile || live.view.profile !== row.profile || live.view.nativeProfile !== row.profile ||
      current.storedId !== live.row.storedId || current.runtimeId !== live.row.runtimeId || current.connectionId !== connectionId)
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
      // On the pinned Hermes contract, 5062 is the exact project-not-found response.
      // Other native and transport failures remain errors so they cannot look like absence.
      if (error instanceof NativeRpcError && error.code === 5062) return null;
      throw error;
    }
  }
  async function schedules(epoch: number) {
    const value = record(await hub.socket.callConnected('cron.manage', { profile: row.profile, action: 'list', include_disabled: true }, epoch, 30_000));
    if (value.scoped !== row.profile) throw new HttpError(501, 'This Hermes version cannot confirm profile-scoped schedules.');
    return scheduleProjection(value);
  }
  async function plugins(epoch: number) {
    const value = record(await hub.socket.callConnected('plugins.manage', { profile: row.profile, action: 'list' }, epoch, 30_000));
    if (!Array.isArray(value.plugins) || value.plugins.length > 500)
      throw new HttpError(502, 'Hermes returned an incomplete plugin inventory. Refresh it before changing a plugin.');
    return pluginProjection(value);
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
    } else if (input.action === 'pause' || input.action === 'resume') {
      const listed = await schedules(snapshot.socketEpoch);
      const schedule = listed.schedules.find(value => value.id === input.scheduleId);
      const resumable = schedule && (schedule.state === 'paused' || schedule.state === 'error');
      if (!schedule || input.action === 'pause' && (!schedule.enabled || schedule.state !== 'scheduled') || input.action === 'resume' && !resumable)
        throw new HttpError(409, 'Only a scheduled job can be paused, and only paused or recoverable error jobs can be resumed.');
      claim = { requestId: randomUUID(), runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId, profile: row.profile, socketEpoch: snapshot.socketEpoch,
        action: 'schedule', scheduleAction: input.action, scheduleId: schedule.id, scheduleName: schedule.name, scheduleState: schedule.state, enabled: input.action === 'resume', expiresAt: Date.now() + 60_000 };
    } else if (input.action === 'enable-plugin' || input.action === 'disable-plugin') {
      const listed = await plugins(snapshot.socketEpoch);
      const plugin = listedUserPlugin(listed.plugins, input.pluginKey);
      if (!plugin) throw new HttpError(409, 'Choose a supported, unambiguous user-installed plugin from the refreshed Hermes list.');
      const enabled = input.action === 'enable-plugin';
      if ((plugin.status === 'enabled') === enabled) throw new HttpError(409, 'This plugin already has the requested state. Refresh the list before continuing.');
      claim = { requestId: randomUUID(), runtimeId: snapshot.row.runtimeId!, storedId: snapshot.row.storedId, profile: row.profile, socketEpoch: snapshot.socketEpoch,
        action: 'plugin', pluginKey: plugin.key, pluginName: plugin.name, enabled, expiresAt: Date.now() + 60_000 };
    } else throw new HttpError(400, 'Unsupported Hermes operation.');
    return { confirmation: encrypt(JSON.stringify(claim), aad), expiresAt: claim.expiresAt, action: claim.action, enabled: claim.action === 'schedule' || claim.action === 'plugin' ? claim.enabled : undefined,
      name: claim.action === 'create' ? claim.name : claim.action === 'select' ? claim.projectName : claim.action === 'schedule' ? claim.scheduleName : claim.pluginName,
      profile: row.profile, title: snapshot.view.title };
  }

  const claim = target!;
  const identity = compatible(row);
  if (claim.profile !== row.profile || claim.runtimeId !== identity.row.runtimeId || claim.storedId !== identity.row.storedId || claim.socketEpoch !== identity.socketEpoch)
    throw new HttpError(409, 'The native chat changed after confirmation. Review it and request a new confirmation.');
  const digest = hmacSha256Hex(toolApprovalSecret('native-hermes-workspace-receipt:v1'), JSON.stringify(claim));
  const [existingReceipt] = await db.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, claim.requestId)));
  if (existingReceipt) {
    if (existingReceipt.digest !== digest) throw new HttpError(409, 'This project confirmation was already used for different content.');
    if (claim.action === 'schedule') {
      const current = await schedules(claim.socketEpoch);
      const complete = current.schedules.some(schedule => schedule.id === claim.scheduleId && scheduleMatches(schedule, claim));
      return { accepted: complete, duplicate: true, schedules: current.schedules,
        output: complete ? 'This schedule request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
    }
    if (claim.action === 'plugin') {
      const current = await plugins(claim.socketEpoch);
      const plugin = listedUserPlugin(current.plugins, claim.pluginKey, claim.pluginName);
      const complete = !!plugin && pluginState(plugin.status) === claim.enabled;
      return { accepted: complete, duplicate: true, plugins: current.plugins,
        output: complete ? 'This plugin request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
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
  } else if (claim.action === 'plugin') {
    const listed = await plugins(claim.socketEpoch);
    const current = listedUserPlugin(listed.plugins, claim.pluginKey, claim.pluginName);
    if (!current || (current.status === 'enabled') === claim.enabled)
      throw new HttpError(409, 'This plugin changed after confirmation. Refresh the plugin list and review it again.');
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
    if (claim.action === 'schedule') {
      const current = await schedules(claim.socketEpoch);
      const complete = current.schedules.some(schedule => schedule.id === claim.scheduleId && scheduleMatches(schedule, claim));
      return { accepted: complete, duplicate: true, schedules: current.schedules,
        output: complete ? 'This schedule request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
    }
    if (claim.action === 'plugin') {
      const current = await plugins(claim.socketEpoch);
      const plugin = listedUserPlugin(current.plugins, claim.pluginKey, claim.pluginName);
      const complete = !!plugin && pluginState(plugin.status) === claim.enabled;
      return { accepted: complete, duplicate: true, plugins: current.plugins,
        output: complete ? 'This plugin request was already applied and will not be replayed.' : 'This request was already submitted and will not be replayed. Refresh the native panel to check its outcome.' };
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
        throw new HttpError(409, 'This Hermes confirmation is no longer ready. Review the selected chat and confirm again.');
      sent = true;
      const method = claim.action === 'create' ? 'projects.create' : claim.action === 'select' ? 'projects.set_active' : claim.action === 'plugin' ? 'plugins.manage' : 'cron.manage';
      const params = claim.action === 'create'
        ? { profile: claim.profile, name: claim.name, slug: claim.slug, folders: [], use: false }
        : claim.action === 'select' ? { profile: claim.profile, id: claim.projectId }
          : claim.action === 'schedule' ? { profile: claim.profile, action: claim.scheduleAction, name: claim.scheduleId }
            : { profile: claim.profile, action: 'toggle', key: claim.pluginKey, enable: claim.enabled };
      return hub.socket.dispatchConnected(method, params, claim.socketEpoch, 30_000, tx);
    });
    const replyValue = await reply;
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
    } else if (claim.action === 'plugin') {
      const plugin = record(replyValue.plugin);
      if (replyValue.ok !== true || replyValue.name !== claim.pluginKey || plugin.key !== claim.pluginKey || plugin.name !== claim.pluginName ||
        plugin.source !== 'user' || pluginState(String(plugin.status)) !== claim.enabled)
        throw new HttpError(502, 'Hermes did not confirm the requested plugin state. Refresh before continuing.');
    }
    if (claim.action === 'schedule') {
      const latest = await schedules(claim.socketEpoch);
      if (!latest.schedules.some(schedule => schedule.id === claim.scheduleId && scheduleMatches(schedule, claim)))
        throw new HttpError(502, 'Hermes readback did not match the requested schedule state. The result is uncertain; refresh before taking action.');
      await settle('idle');
      return { accepted: true, duplicate: false, schedules: latest.schedules, output: claim.enabled ? 'Schedule resumed; it may run soon and use model usage.' : 'Schedule paused.' };
    }
    if (claim.action === 'plugin') {
      const latest = await plugins(claim.socketEpoch);
      const plugin = listedUserPlugin(latest.plugins, claim.pluginKey, claim.pluginName);
      if (!plugin || pluginState(plugin.status) !== claim.enabled)
        throw new HttpError(502, 'Hermes plugin readback did not match the requested change. The result is uncertain; refresh before taking action.');
      await settle('idle');
      const runningGateway = replyValue.gateway_reloaded === true
        ? 'Hermes confirms the running gateway reloaded.'
        : replyValue.restart_required === true
          ? 'Hermes could not confirm a gateway reload; restart may be required for running handlers to update.'
          : 'Hermes did not confirm the running gateway state; verify it before relying on the change.';
      return { accepted: true, duplicate: false, plugins: latest.plugins,
        output: claim.enabled
          ? `Plugin “${claim.pluginName}” enabled in profile settings. ${runningGateway} Activation may add tools or skills to open chats.`
          : `Plugin “${claim.pluginName}” disabled in profile settings. ${replyValue.restart_required === true ? 'A running gateway may keep its handlers until restarted.' : runningGateway}` };
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
