import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '@/db';
import { bots, hermesTeamDefinitions, hermesTeamOperations, hermesTeamProfiles, hermesTeamResourceStates, hermesTeamRevisions, users } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { authorizeTeam } from './store';
import { createTeamResourceSnapshot, resourceSha256, validateTeamResourceSnapshot, type TeamResourceSnapshot } from './resources';
import { beginResourceUpdate, nextResourceUpdateStep, planTeamResourceUpdate, resourceRolloutSummary,
  type ResourceConflictResolution, type ResourceUpdateReceipt, type TeamResourceUpdatePlan } from './updates';

const revision = z.number().int().min(0).max(2147483646);
export const memberUpdateRequestSchema = z.object({ expectedInstalledRevision: revision.nullable(), targetRevision: revision.optional(), requestId: z.uuid() }).strict();
export const memberResolveRequestSchema = memberUpdateRequestSchema.extend({ targetRevision: revision, packageId: z.string().min(1).max(256), choice: z.enum(['keep-member', 'use-team']),
  expectedMemberHash: z.string().regex(/^[a-f0-9]{64}$/), expectedTeamHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const memberCancelRequestSchema = z.object({ requestId: z.uuid() }).strict();
export const memberPreviewRequestSchema = z.object({ targetRevision: revision.optional() }).strict();
export type MemberUpdateInput = z.infer<typeof memberUpdateRequestSchema>;
export type MemberResolveInput = z.infer<typeof memberResolveRequestSchema>;
export interface MemberUpdateDependencies {
  inventoryResources(p: Principal, botId: string, trackedPackageIds: readonly string[]): Promise<unknown>;
  applyResources(p: Principal, botId: string, input: { operationId: string; plan: TeamResourceUpdatePlan; receipt: ResourceUpdateReceipt }): Promise<unknown>;
  abortResources(p: Principal, botId: string, input: { operationId: string; plan: TeamResourceUpdatePlan }): Promise<unknown>;
}
export interface MemberUpdateResult {
  status: 'complete' | 'needs_attention' | 'cancelled'; installedRevision: number | null; conflictCount: number; requestId: string;
}
interface OperationData {
  format: 1; kind: 'update' | 'resolve'; input: MemberUpdateInput | MemberResolveInput;
  profileId: string; sourceRevision: number | null; targetRevision: number; definitionVersion: number;
  plan?: TeamResourceUpdatePlan; receipt?: ResourceUpdateReceipt; result?: MemberUpdateResult;
}
type Operation = typeof hermesTeamOperations.$inferSelect;
const resultSchema = z.object({ status: z.enum(['complete', 'needs_attention', 'cancelled']), installedRevision: revision.nullable(),
  conflictCount: z.number().int().min(0).max(512), requestId: z.uuid() }).strict();
const json = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const pendingStates = ['pending', 'needs_attention'] as const;
function operationData(operation: Operation): OperationData {
  const data = operation.result as unknown as OperationData;
  if (!data || data.format !== 1 || !['update', 'resolve'].includes(data.kind) || operation.kind !== data.kind || data.profileId !== operation.profileId
    || !revision.nullable().safeParse(data.sourceRevision).success || !revision.safeParse(data.targetRevision).success
    || !Number.isSafeInteger(data.definitionVersion) || data.definitionVersion < 1)
    throw new HttpError(503, 'The member update receipt needs attention.');
  const input = (data.kind === 'resolve' ? memberResolveRequestSchema : memberUpdateRequestSchema).safeParse(data.input);
  if (!input.success || resourceSha256(JSON.stringify(input.data)) !== operation.digest || input.data.requestId !== operation.requestId
    || input.data.expectedInstalledRevision !== data.sourceRevision || (input.data.targetRevision !== undefined && input.data.targetRevision !== data.targetRevision))
    throw new HttpError(503, 'The member update request needs attention.');
  if (data.plan) beginResourceUpdate(operation.id, data.plan, data.receipt);
  else if (data.receipt) throw new HttpError(503, 'The member update plan needs attention.');
  if (data.result) {
    const result = resultSchema.parse(data.result);
    if (result.requestId !== operation.requestId || (result.status === 'complete' && result.installedRevision !== data.targetRevision)
      || (result.status === 'cancelled' && result.installedRevision !== data.sourceRevision)
      || (result.status === 'complete' && (!data.plan || data.receipt?.status !== 'complete'))) throw new HttpError(503, 'The member update result needs attention.');
  }
  return data;
}
async function snapshotAt(tx: Tx, botId: string, value: number): Promise<TeamResourceSnapshot> {
  if (value === 0) return createTeamResourceSnapshot([]);
  const [row] = await tx.select({ manifest: hermesTeamRevisions.manifest, hash: hermesTeamRevisions.manifestHash }).from(hermesTeamRevisions)
    .where(and(eq(hermesTeamRevisions.botId, botId), eq(hermesTeamRevisions.revision, value)));
  if (!row) throw new HttpError(404, 'Team revision not found.');
  const snapshot = validateTeamResourceSnapshot(row.manifest as unknown as TeamResourceSnapshot);
  if (snapshot.manifestHash !== row.hash) throw new HttpError(503, 'The Team revision needs attention.');
  return snapshot;
}
/** Shared lock order with audience/security mutations: bot, account, definition, private profile, operation. */
async function lockedMember(p: Principal, botId: string, tx: Tx) {
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
  await tx.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for('share');
  await tx.select({ id: hermesTeamDefinitions.botId }).from(hermesTeamDefinitions).where(eq(hermesTeamDefinitions.botId, botId)).for('update');
  const access = await authorizeTeam(p, botId, 'member', tx);
  const [profile] = await tx.select().from(hermesTeamProfiles).where(and(eq(hermesTeamProfiles.botId, botId), eq(hermesTeamProfiles.userId, p.user.id), eq(hermesTeamProfiles.mode, 'member'))).for('update');
  if (!profile || !profile.binding) throw new HttpError(409, 'Open this bot and finish preparing your private instance first.');
  if (profile.state === 'revoked') throw new HttpError(403, 'This private Team instance was revoked.');
  const states = await tx.select().from(hermesTeamResourceStates).where(eq(hermesTeamResourceStates.profileId, profile.id));
  return { ...access, profile, states };
}
type MemberAccess = Awaited<ReturnType<typeof lockedMember>>;
const overridesFor = (states: MemberAccess['states']) => Object.fromEntries(states.flatMap<[string, 'deleted' | 'keep-member']>(state =>
  state.override === 'deleted' ? [[state.packageId, 'deleted']] : state.override === 'keep' ? [[state.packageId, 'keep-member']] : []));
const trackedFor = (snapshot: TeamResourceSnapshot, states: MemberAccess['states']) => [...new Set([
  ...snapshot.resources.map(resource => resource.packageId), ...states.filter(state => state.installedHash || state.override).map(state => state.packageId),
])].sort();
function privateConflicts(plan: TeamResourceUpdatePlan, states: MemberAccess['states']) {
  return plan.actions.filter(action => action.action === 'conflict' ||
    (states.some(state => state.packageId === action.packageId && state.conflictRevision !== null) && action.beforeHash !== action.teamHash))
    .map(action => ({ packageId: action.packageId, expectedMemberHash: action.beforeHash, expectedTeamHash: action.teamHash,
      memberResources: action.memberResources, teamResources: action.teamResources,
      recorded: states.some(state => state.packageId === action.packageId && state.conflictRevision !== null) }));
}
function privateOverrides(plan: TeamResourceUpdatePlan, states: MemberAccess['states']) {
  return plan.actions.filter(action => states.some(state => state.packageId === action.packageId && ['keep', 'deleted'].includes(state.override ?? '')))
    .map(action => ({ packageId: action.packageId, choice: states.find(state => state.packageId === action.packageId)?.override === 'deleted' ? 'deleted' as const : 'keep-member' as const,
      expectedMemberHash: action.beforeHash, expectedTeamHash: action.teamHash, memberResources: action.memberResources, teamResources: action.teamResources, recorded: true as const }));
}
function previewResult(access: MemberAccess, targetRevision: number, plan?: TeamResourceUpdatePlan, pending?: Operation) {
  const data = pending ? operationData(pending) : undefined;
  return { installedRevision: access.profile.installedRevision, targetRevision, publishedRevision: access.definition.publishedRevision,
    state: access.profile.state, nativeUpdatesSupported: true,
    ...(pending && data ? { pendingRequestId: pending.requestId, pendingRequest: { kind: data.kind, input: data.input } } : {}),
    changes: plan?.actions.filter(action => action.reason !== 'independent-learning').map(action => ({ packageId: action.packageId, action: action.action, reason: action.reason })) ?? [],
    conflicts: plan ? privateConflicts(plan, access.states) : [], overrides: plan ? privateOverrides(plan, access.states) : [] };
}
export type MemberUpdatePreview = ReturnType<typeof previewResult>;

export function createMemberUpdateService(dependencies: MemberUpdateDependencies) {
  const active = new Map<string, Promise<MemberUpdateResult>>();
  async function markAttention(botId: string, operationId: string, profileId: string, receipt?: ResourceUpdateReceipt) {
    // Historical cleanup may still run after revocation; it cannot turn a revoked profile back on.
    await db.transaction(async tx => {
      await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
      await tx.select({ id: hermesTeamProfiles.id }).from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id, profileId)).for('update');
      const [operation] = await tx.select().from(hermesTeamOperations).where(eq(hermesTeamOperations.id, operationId)).for('update');
      if (!operation || operation.state === 'complete') return;
      const stored = operationData(operation);
      if (receipt && stored.plan) beginResourceUpdate(operationId, stored.plan, receipt);
      await tx.update(hermesTeamOperations).set({ state: 'needs_attention', result: json({ ...stored, ...(receipt ? { receipt } : {}) }), updatedAt: new Date() }).where(eq(hermesTeamOperations.id, operationId));
      await tx.update(hermesTeamProfiles).set({ state: 'needs_attention', updatedAt: new Date() })
        .where(and(eq(hermesTeamProfiles.id, profileId), ne(hermesTeamProfiles.state, 'revoked')));
    });
  }
  async function execute(p: Principal, botId: string, raw: unknown, resolve: boolean): Promise<MemberUpdateResult> {
    const input = resolve ? memberResolveRequestSchema.parse(raw) : memberUpdateRequestSchema.parse(raw);
    const digest = resourceSha256(JSON.stringify(input));
    const prepared = await db.transaction(async tx => {
      const access = await lockedMember(p, botId, tx);
      const [prior] = await tx.select().from(hermesTeamOperations).where(and(eq(hermesTeamOperations.botId, botId), eq(hermesTeamOperations.actorId, p.user.id), eq(hermesTeamOperations.requestId, input.requestId))).for('update');
      if (prior) {
        if (prior.digest !== digest || prior.kind !== (resolve ? 'resolve' : 'update') || prior.profileId !== access.profile.id) throw new HttpError(409, 'This update request already has different details.');
        const data = operationData(prior);
        if (prior.state === 'complete') return { access, operation: prior, data, done: resultSchema.parse(data.result) };
        if (data.sourceRevision !== access.profile.installedRevision) throw new HttpError(409, 'Your installed revision changed. Review your update again.');
        return { access, operation: prior, data, done: null };
      }
      if (access.profile.installedRevision !== input.expectedInstalledRevision) throw new HttpError(409, 'Your installed revision changed. Review your update again.');
      const [busy] = await tx.select({ id: hermesTeamOperations.id }).from(hermesTeamOperations)
        .where(and(eq(hermesTeamOperations.profileId, access.profile.id), inArray(hermesTeamOperations.state, [...pendingStates]))).limit(1);
      if (busy) throw new HttpError(409, 'Resume or cancel the unfinished update before starting another.');
      const targetRevision = input.targetRevision ?? access.definition.publishedRevision;
      if (targetRevision > access.definition.publishedRevision) throw new HttpError(404, 'Team revision not found.');
      if (resolve) {
        const choice = input as MemberResolveInput;
        if (!access.states.some(state => state.packageId === choice.packageId && (state.conflictRevision !== null || state.override)))
          throw new HttpError(409, 'This resource has no recorded conflict or override to resolve.');
      }
      await snapshotAt(tx, botId, targetRevision);
      const data: OperationData = { format: 1, kind: resolve ? 'resolve' : 'update', input, profileId: access.profile.id,
        sourceRevision: access.profile.installedRevision, targetRevision, definitionVersion: access.definition.version };
      const [operation] = await tx.insert(hermesTeamOperations).values({ botId, profileId: access.profile.id, actorId: p.user.id,
        requestId: input.requestId, kind: data.kind, digest, state: 'pending', result: json(data) }).returning();
      await tx.update(hermesTeamProfiles).set({ state: 'updating', updatedAt: new Date() }).where(eq(hermesTeamProfiles.id, access.profile.id));
      return { access, operation, data, done: null };
    });
    if (prepared.done) return prepared.done;
    const running = active.get(prepared.operation.id); if (running) return running;
    const work = (async (): Promise<MemberUpdateResult> => {
      let data = prepared.data;
      try {
        if (!data.plan) {
          const baseline = await db.transaction(tx => snapshotAt(tx, botId, data.sourceRevision ?? 0));
          const current = validateTeamResourceSnapshot(await dependencies.inventoryResources(prepared.access.principal, botId, trackedFor(baseline, prepared.access.states)) as TeamResourceSnapshot, { requireCompleteSkills: false });
          const planned = await db.transaction(async tx => {
            const fresh = await lockedMember(p, botId, tx);
            const [operation] = await tx.select().from(hermesTeamOperations).where(eq(hermesTeamOperations.id, prepared.operation.id)).for('update');
            const stored = operationData(operation);
            if (operation.state === 'complete') return { data: stored, done: resultSchema.parse(stored.result) };
            if (stored.plan) return { data: stored, done: null };
            if (fresh.profile.installedRevision !== data.sourceRevision || fresh.definition.version !== data.definitionVersion)
              throw new HttpError(409, 'Your Team access changed during inventory. Cancel this untouched request and review again.');
            const target = await snapshotAt(tx, botId, data.targetRevision);
            const resolutions: ResourceConflictResolution[] = resolve ? [input as MemberResolveInput] : [];
            let plan: TeamResourceUpdatePlan;
            try { plan = planTeamResourceUpdate({ installed: baseline, release: target, current, overrides: overridesFor(fresh.states), resolutions }); }
            catch (error) { if (resolve && error instanceof Error && error.message.includes('preview is stale')) throw new HttpError(409, 'Your skill changed. Review both versions again.'); throw error; }
            const saved: OperationData = { ...stored, plan, receipt: beginResourceUpdate(prepared.operation.id, plan) };
            await tx.update(hermesTeamOperations).set({ result: json(saved), state: 'pending', updatedAt: new Date() }).where(eq(hermesTeamOperations.id, prepared.operation.id));
            return { data: saved, done: null };
          });
          if (planned.done) return planned.done;
          data = planned.data;
        }
        const plan = data.plan!;
        const alreadyDone = await db.transaction(async tx => {
          const fresh = await lockedMember(p, botId, tx);
          const [operation] = await tx.select().from(hermesTeamOperations).where(eq(hermesTeamOperations.id, prepared.operation.id)).for('update');
          const stored = operationData(operation);
          if (operation.state === 'complete') return resultSchema.parse(stored.result);
          if (fresh.profile.installedRevision !== data.sourceRevision || stored.plan?.planHash !== plan.planHash) throw new HttpError(409, 'Your private update changed.');
          return null;
        });
        if (alreadyDone) return alreadyDone;
        const rawReceipt = await dependencies.applyResources(p, botId, { operationId: prepared.operation.id, plan, receipt: data.receipt ?? beginResourceUpdate(prepared.operation.id, plan) });
        const receipt = beginResourceUpdate(prepared.operation.id, plan, rawReceipt as ResourceUpdateReceipt);
        if (receipt.status !== 'complete') {
          await markAttention(botId, prepared.operation.id, data.profileId, receipt);
          return { status: 'needs_attention', installedRevision: data.sourceRevision, conflictCount: resourceRolloutSummary(plan).conflictGroups, requestId: input.requestId };
        }
        nextResourceUpdateStep(plan, receipt, () => { throw new HttpError(503, 'Incomplete native update receipt.'); });
        return await db.transaction(async tx => {
          const fresh = await lockedMember(p, botId, tx);
          const [operation] = await tx.select().from(hermesTeamOperations).where(eq(hermesTeamOperations.id, prepared.operation.id)).for('update');
          const prior = operationData(operation);
          if (operation.state === 'complete') return resultSchema.parse(prior.result);
          if (fresh.profile.installedRevision !== data.sourceRevision || prior.plan?.planHash !== plan.planHash) throw new HttpError(409, 'Your update changed before completion.');
          let conflictCount = 0;
          for (const action of plan.actions) {
            const priorState = fresh.states.find(state => state.packageId === action.packageId);
            if (!action.teamResources.length && !priorState && action.reason === 'independent-learning') continue;
            const applied = action.action === 'install' || action.action === 'remove';
            const override = plan.overrides[action.packageId] === 'deleted' ? 'deleted' : plan.overrides[action.packageId] === 'keep-member' ? 'keep'
              : action.action === 'conflict' ? 'modified' : priorState?.override === 'modified' && !applied ? 'modified' : null;
            const selected = resolve && (input as MemberResolveInput).packageId === action.packageId;
            const conflictRevision = selected || applied || override === 'keep' || override === 'deleted' || action.beforeHash === action.teamHash ? null
              : action.action === 'conflict' ? data.targetRevision : priorState?.conflictRevision !== null && priorState?.conflictRevision !== undefined ? data.targetRevision : null;
            if (conflictRevision !== null) conflictCount++;
            // The baseline is team-owned content, never the hash of an independently learned collision.
            const installedHash = applied ? (action.teamResources.length ? action.teamHash : null) : priorState?.installedHash ?? null;
            await tx.insert(hermesTeamResourceStates).values({ profileId: fresh.profile.id, packageId: action.packageId, installedHash, override, conflictRevision, updatedAt: new Date() })
              .onConflictDoUpdate({ target: [hermesTeamResourceStates.profileId, hermesTeamResourceStates.packageId], set: { installedHash, override, conflictRevision, updatedAt: new Date() } });
          }
          const result: MemberUpdateResult = { status: 'complete', installedRevision: data.targetRevision, conflictCount, requestId: input.requestId };
          // Resource completion is separate from model access. No native gateway is verified in this increment.
          await tx.update(hermesTeamProfiles).set({ installedRevision: data.targetRevision, state: 'connection_needed', updatedAt: new Date() }).where(eq(hermesTeamProfiles.id, fresh.profile.id));
          await tx.update(hermesTeamOperations).set({ state: 'complete', result: json({ ...data, receipt, result }), updatedAt: new Date() }).where(eq(hermesTeamOperations.id, operation.id));
          return result;
        });
      } catch (error) { await markAttention(botId, prepared.operation.id, data.profileId); throw error; }
    })();
    active.set(prepared.operation.id, work);
    try { return await work; } finally { active.delete(prepared.operation.id); }
  }
  return {
    update: (p: Principal, botId: string, raw: unknown) => execute(p, botId, raw, false),
    resolve: (p: Principal, botId: string, raw: unknown) => execute(p, botId, raw, true),
    async preview(p: Principal, botId: string, raw: unknown = {}): Promise<MemberUpdatePreview> {
      const input = memberPreviewRequestSchema.parse(raw);
      const initial = await db.transaction(async tx => {
        const access = await lockedMember(p, botId, tx);
        const [pending] = await tx.select().from(hermesTeamOperations).where(and(eq(hermesTeamOperations.profileId, access.profile.id),
          inArray(hermesTeamOperations.state, [...pendingStates]))).limit(1);
        if (pending) {
          const data = operationData(pending);
          if (input.targetRevision !== undefined && input.targetRevision !== data.targetRevision) throw new HttpError(409, 'Resume or cancel your unfinished update first.');
          return { access, pending, done: previewResult(access, data.targetRevision, data.plan, pending), baseline: null, target: null, targetRevision: data.targetRevision };
        }
        const targetRevision = input.targetRevision ?? access.definition.publishedRevision;
        if (targetRevision > access.definition.publishedRevision) throw new HttpError(404, 'Team revision not found.');
        return { access, pending, done: null, baseline: await snapshotAt(tx, botId, access.profile.installedRevision ?? 0), target: await snapshotAt(tx, botId, targetRevision), targetRevision };
      });
      // A pending journal may have a parked package; its exact stored plan supplies a safe private preview.
      if (initial.done) return initial.done;
      const current = validateTeamResourceSnapshot(await dependencies.inventoryResources(initial.access.principal, botId, trackedFor(initial.baseline!, initial.access.states)) as TeamResourceSnapshot, { requireCompleteSkills: false });
      return db.transaction(async tx => {
        const fresh = await lockedMember(p, botId, tx);
        const [pending] = await tx.select().from(hermesTeamOperations).where(and(eq(hermesTeamOperations.profileId, fresh.profile.id), inArray(hermesTeamOperations.state, [...pendingStates]))).limit(1);
        if (pending || fresh.profile.installedRevision !== initial.access.profile.installedRevision || fresh.definition.version !== initial.access.definition.version
          || fresh.definition.publishedRevision !== initial.access.definition.publishedRevision) throw new HttpError(409, 'Your bot changed. Review it again.');
        const plan = planTeamResourceUpdate({ installed: initial.baseline!, release: initial.target!, current, overrides: overridesFor(fresh.states) });
        return previewResult(fresh, initial.targetRevision, plan);
      });
    },
    async cancel(p: Principal, botId: string, raw: unknown): Promise<MemberUpdateResult> {
      const input = memberCancelRequestSchema.parse(raw);
      const pending = await db.transaction(async tx => {
        const access = await lockedMember(p, botId, tx);
        const [operation] = await tx.select().from(hermesTeamOperations).where(and(eq(hermesTeamOperations.botId, botId), eq(hermesTeamOperations.actorId, p.user.id),
          eq(hermesTeamOperations.profileId, access.profile.id), eq(hermesTeamOperations.requestId, input.requestId))).for('update');
        if (!operation || !['update', 'resolve'].includes(operation.kind)) throw new HttpError(404, 'Update request not found.');
        const data = operationData(operation);
        if (operation.state === 'complete') {
          const result = resultSchema.parse(data.result); if (result.status !== 'cancelled') throw new HttpError(409, 'This update already completed.');
          return { operation, data, done: result };
        }
        if (active.has(operation.id)) throw new HttpError(409, 'This update is still running.');
        return { operation, data, done: null };
      });
      if (pending.done) return pending.done;
      if (pending.data.plan) {
        const aborted = await dependencies.abortResources(p, botId, { operationId: pending.operation.id, plan: pending.data.plan }) as { aborted?: unknown };
        if (aborted?.aborted !== true) throw new HttpError(409, 'Native recovery is still required. Retry the original request.');
      }
      return db.transaction(async tx => {
        const fresh = await lockedMember(p, botId, tx);
        const [operation] = await tx.select().from(hermesTeamOperations).where(eq(hermesTeamOperations.id, pending.operation.id)).for('update');
        const stored = operationData(operation);
        if (operation.state === 'complete') {
          const result = resultSchema.parse(stored.result); if (result.status !== 'cancelled') throw new HttpError(409, 'This update already completed.');
          return result;
        }
        // Planning may have completed in another process after the cancellation check. Fence that exact plan before cancelling.
        if (fresh.profile.installedRevision !== pending.data.sourceRevision || stored.plan?.planHash !== pending.data.plan?.planHash)
          throw new HttpError(409, 'Your update changed before cancellation. Retry cancellation.');
        const result: MemberUpdateResult = { status: 'cancelled', installedRevision: pending.data.sourceRevision,
          conflictCount: fresh.states.filter(state => state.conflictRevision !== null).length, requestId: input.requestId };
        await tx.update(hermesTeamOperations).set({ state: 'complete', result: json({ ...stored, result }), updatedAt: new Date() }).where(eq(hermesTeamOperations.id, pending.operation.id));
        await tx.update(hermesTeamProfiles).set({ state: 'connection_needed', updatedAt: new Date() }).where(eq(hermesTeamProfiles.id, fresh.profile.id));
        return result;
      });
    },
  };
}
const service = createMemberUpdateService({
  inventoryResources: async (p, b, t) => (await import('./transport')).inventoryTeamMemberResources(p, b, t),
  applyResources: async (p, b, r) => (await import('./transport')).applyTeamMemberResources(p, b, r),
  abortResources: async (p, b, r) => (await import('./transport')).abortTeamMemberResources(p, b, r),
});
export const previewMemberUpdate = service.preview;
export const applyMemberUpdate = service.update;
export const resolveMemberUpdate = service.resolve;
export const cancelMemberUpdate = service.cancel;
