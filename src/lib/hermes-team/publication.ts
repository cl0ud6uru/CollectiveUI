import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DbOrTx, type Tx } from '@/db';
import { bots, hermesTeamCaptures, hermesTeamDefinitions, hermesTeamMaintainers, hermesTeamOperations, hermesTeamProfiles, hermesTeamResourceStates, hermesTeamRevisions, users } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { authorizeTeam } from './store';
import {
  assertSafeResourcePath, createTeamResourceSnapshot, DEFAULT_RESOURCE_LIMITS, resourceSha256,
  reviewTeamResourceChanges, selectTeamResourcePublication, TeamResourceError, validateTeamResourceSnapshot,
  type ResourceSelection, type TeamResourceSnapshot,
} from './resources';

const resourceKey = z.string().min(1).max(DEFAULT_RESOURCE_LIMITS.maxPathBytes).superRefine((value, context) => {
  try { assertSafeResourcePath(value); } catch { context.addIssue({ code: 'custom', message: 'Invalid resource selection.' }); }
});
export const teamResourceSelectionSchema = z.object({
  skillPackages: z.array(resourceKey).max(DEFAULT_RESOURCE_LIMITS.maxFiles).default([]),
  includeRole: z.boolean().default(false),
  documents: z.array(resourceKey).max(DEFAULT_RESOURCE_LIMITS.maxFiles).default([]),
}).strict().superRefine((value, context) => {
  if (value.skillPackages.length + value.documents.length + Number(value.includeRole) > DEFAULT_RESOURCE_LIMITS.maxFiles)
    context.addIssue({ code: 'custom', message: 'Too many resources selected.' });
});
export const teamCaptureRequestSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2147483646),
  selection: teamResourceSelectionSchema,
}).strict();
export const teamPublishRequestSchema = z.object({
  snapshotId: z.string().min(1).max(100),
  expectedRevision: z.number().int().min(0).max(2147483646),
  selectedKeys: z.array(resourceKey).max(DEFAULT_RESOURCE_LIMITS.maxFiles),
  removalKeys: z.array(resourceKey).max(DEFAULT_RESOURCE_LIMITS.maxFiles),
  releaseNote: z.string().trim().min(1).max(500),
  requestId: z.uuid(),
}).strict().superRefine((value, context) => {
  const keys = [...value.selectedKeys, ...value.removalKeys];
  if (!keys.length || keys.length > DEFAULT_RESOURCE_LIMITS.maxFiles || new Set(keys).size !== keys.length)
    context.addIssue({ code: 'custom', message: 'Select distinct reviewed changes or removals.' });
});
export interface TeamPublicationDependencies {
  /** Authorization and profile/runtime selection belong to the server broker, never a browser path. */
  captureResources(principal: Principal, botId: string, selection: ResourceSelection): Promise<unknown>;
  now?: () => Date;
}
export interface TeamPublicationResult { revision: number; manifestHash: string; requestId: string }
const resultSchema = z.object({ revision: z.number().int().positive(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.uuid() }).strict();
const CAPTURE_TTL_MS = 15 * 60 * 1000;
const nowFor = (dependencies: TeamPublicationDependencies): Date => {
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HttpError(503, 'Publication time could not be confirmed.');
  return now;
};
const manifestJson = (snapshot: TeamResourceSnapshot): Record<string, unknown> => JSON.parse(JSON.stringify(snapshot));
function checkedSnapshot(raw: unknown, hash: string | undefined, stored: boolean): TeamResourceSnapshot {
  try {
    const snapshot = validateTeamResourceSnapshot(raw as TeamResourceSnapshot);
    if (hash !== undefined && snapshot.manifestHash !== hash) throw new Error('Manifest hash mismatch');
    return snapshot;
  } catch {
    throw new HttpError(stored ? 503 : 422, stored ? 'Stored Team Bot resources need attention.' : 'Captured resources are unsafe or incomplete. Review the selected sources.');
  }
}
async function publishedSnapshot(q: DbOrTx, botId: string, revision: number): Promise<TeamResourceSnapshot> {
  if (revision === 0) return createTeamResourceSnapshot([]);
  const [row] = await q.select({ manifest: hermesTeamRevisions.manifest, manifestHash: hermesTeamRevisions.manifestHash }).from(hermesTeamRevisions)
    .where(and(eq(hermesTeamRevisions.botId, botId), eq(hermesTeamRevisions.revision, revision)));
  if (!row) throw new HttpError(503, 'The published Team Bot revision is unavailable.');
  return checkedSnapshot(row.manifest, row.manifestHash, true);
}
/** Short mutation transaction; no native I/O while these locks are held. */
async function lockedDefinition(p: Principal, botId: string, tx: Tx) {
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
  await tx.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for('share');
  await tx.select({ botId: hermesTeamDefinitions.botId }).from(hermesTeamDefinitions).where(eq(hermesTeamDefinitions.botId, botId)).for('update');
  await tx.select({ userId: hermesTeamMaintainers.userId }).from(hermesTeamMaintainers)
    .where(and(eq(hermesTeamMaintainers.botId, botId), eq(hermesTeamMaintainers.userId, p.user.id))).for('share');
  return authorizeTeam(p, botId, 'admin', tx);
}
function stale(): never { throw new HttpError(409, 'The Team Bot changed. Capture and review its changes again.'); }
function publicationDigest(input: z.infer<typeof teamPublishRequestSchema>): string {
  return resourceSha256(JSON.stringify({ kind: 'publish', snapshotId: input.snapshotId, expectedRevision: input.expectedRevision,
    selectedKeys: [...input.selectedKeys].sort(), removalKeys: [...input.removalKeys].sort(), releaseNote: input.releaseNote }));
}
function resourceFailure(error: unknown): never {
  if (error instanceof TeamResourceError) throw new HttpError(error.code === 'unstable' ? 409 : 422, error.message);
  throw error;
}

export function createTeamPublicationService(dependencies: TeamPublicationDependencies) {
  return {
    async capture(p: Principal, botId: string, raw: unknown) {
      const input = teamCaptureRequestSchema.parse(raw);
      // Check privilege before runtime calls; capture belongs only to the separate shared working profile.
      const initial = await db.transaction(async tx => {
        const access = await lockedDefinition(p, botId, tx);
        if (access.definition.publishedRevision !== input.expectedRevision) stale();
        return access;
      });
      let captured: TeamResourceSnapshot;
      try { captured = checkedSnapshot(await dependencies.captureResources(initial.principal, botId, input.selection), undefined, false); }
      catch (error) { return resourceFailure(error); }
      return db.transaction(async tx => {
        const fresh = await lockedDefinition(p, botId, tx);
        if (fresh.definition.version !== initial.definition.version || fresh.definition.publishedRevision !== input.expectedRevision) stale();
        const previous = await publishedSnapshot(tx, botId, input.expectedRevision);
        let changes: ReturnType<typeof reviewTeamResourceChanges>;
        try { changes = reviewTeamResourceChanges(previous, captured); } catch (error) { return resourceFailure(error); }
        const now = nowFor(dependencies), expiresAt = new Date(now.getTime() + CAPTURE_TTL_MS);
        const [saved] = await tx.insert(hermesTeamCaptures).values({ botId, capturedBy: fresh.principal.user.id,
          expectedRevision: input.expectedRevision, definitionVersion: fresh.definition.version, manifestHash: captured.manifestHash,
          manifest: manifestJson(captured), expiresAt }).returning({ id: hermesTeamCaptures.id });
        return { snapshotId: saved.id, expectedRevision: input.expectedRevision, definitionVersion: fresh.definition.version,
          manifestHash: captured.manifestHash, expiresAt: expiresAt.toISOString(), changes };
      });
    },
    async publish(p: Principal, botId: string, raw: unknown): Promise<TeamPublicationResult> {
      const input = teamPublishRequestSchema.parse(raw), digest = publicationDigest(input);
      return db.transaction(async tx => {
        const access = await lockedDefinition(p, botId, tx);
        // Authorization precedes receipt lookup, including exact retries after access revocation.
        const [existing] = await tx.select().from(hermesTeamOperations).where(and(eq(hermesTeamOperations.botId, botId),
          eq(hermesTeamOperations.actorId, access.principal.user.id), eq(hermesTeamOperations.requestId, input.requestId)));
        if (existing) {
          if (existing.kind !== 'publish' || existing.digest !== digest) throw new HttpError(409, 'This publish request already has different details.');
          const prior = resultSchema.safeParse(existing.result);
          if (existing.state !== 'complete' || !prior.success || prior.data.requestId !== input.requestId || prior.data.revision !== input.expectedRevision + 1) throw new HttpError(409, 'This publication needs attention before retrying.');
          const [revision] = await tx.select({ manifestHash: hermesTeamRevisions.manifestHash, publishedBy: hermesTeamRevisions.publishedBy }).from(hermesTeamRevisions)
            .where(and(eq(hermesTeamRevisions.botId, botId), eq(hermesTeamRevisions.revision, prior.data.revision)));
          if (!revision || revision.manifestHash !== prior.data.manifestHash || revision.publishedBy !== access.principal.user.id)
            throw new HttpError(409, 'The publication receipt does not match its immutable revision.');
          return prior.data;
        }
        if (access.definition.publishedRevision !== input.expectedRevision) stale();
        const [capture] = await tx.select().from(hermesTeamCaptures).where(and(eq(hermesTeamCaptures.id, input.snapshotId),
          eq(hermesTeamCaptures.botId, botId), eq(hermesTeamCaptures.capturedBy, access.principal.user.id)));
        if (!capture) throw new HttpError(404, 'Publication review not found.');
        if (capture.expiresAt.getTime() <= nowFor(dependencies).getTime()) throw new HttpError(409, 'This publication review expired. Capture and review again.');
        if (capture.expectedRevision !== input.expectedRevision || capture.definitionVersion !== access.definition.version) stale();
        const previous = await publishedSnapshot(tx, botId, input.expectedRevision), captured = checkedSnapshot(capture.manifest, capture.manifestHash, true);
        let publication: TeamResourceSnapshot;
        try { publication = selectTeamResourcePublication({ previous, captured, expectedPreviousHash: previous.manifestHash,
          expectedCapturedHash: capture.manifestHash, selectedKeys: input.selectedKeys, removalKeys: input.removalKeys }); }
        catch (error) { return resourceFailure(error); }
        if (publication.manifestHash === previous.manifestHash) throw new HttpError(400, 'Select a resource change to publish.');
        const result = { revision: input.expectedRevision + 1, manifestHash: publication.manifestHash, requestId: input.requestId };
        const [operation] = await tx.insert(hermesTeamOperations).values({ botId, actorId: access.principal.user.id, requestId: input.requestId, kind: 'publish', digest, state: 'pending' }).returning({ id: hermesTeamOperations.id });
        await tx.insert(hermesTeamRevisions).values({ botId, revision: result.revision, manifestHash: publication.manifestHash,
          manifest: manifestJson(publication), releaseNote: input.releaseNote, publishedBy: access.principal.user.id });
        await tx.update(hermesTeamDefinitions).set({ publishedRevision: result.revision, updatedBy: access.principal.user.id, updatedAt: nowFor(dependencies) }).where(eq(hermesTeamDefinitions.botId, botId));
        await tx.update(hermesTeamOperations).set({ state: 'complete', result, updatedAt: nowFor(dependencies) }).where(eq(hermesTeamOperations.id, operation.id));
        return result;
      });
    },
    async rollout(p: Principal, botId: string) {
      return db.transaction(async tx => {
        const access = await lockedDefinition(p, botId, tx);
        const profiles = await tx.select({ id: hermesTeamProfiles.id, state: hermesTeamProfiles.state, installedRevision: hermesTeamProfiles.installedRevision })
          .from(hermesTeamProfiles).where(and(eq(hermesTeamProfiles.botId, botId), eq(hermesTeamProfiles.mode, 'member')));
        const conflicts = profiles.length ? await tx.select({ profileId: hermesTeamResourceStates.profileId }).from(hermesTeamResourceStates)
          .where(and(inArray(hermesTeamResourceStates.profileId, profiles.map(profile => profile.id)), isNotNull(hermesTeamResourceStates.conflictRevision))) : [];
        const states: Record<string, number> = {};
        for (const profile of profiles) states[profile.state] = (states[profile.state] ?? 0) + 1;
        return { publishedRevision: access.definition.publishedRevision, nativeUpdatesSupported: false,
          profileCount: profiles.length, states, conflictCount: conflicts.length, conflictedProfileCount: new Set(conflicts.map(row => row.profileId)).size,
          updatesNeeded: profiles.filter(profile => profile.state !== 'revoked' && (profile.installedRevision ?? 0) < access.definition.publishedRevision).length };
      });
    },
  };
}
const service = createTeamPublicationService({ captureResources: async (p, botId, selection) => {
  const { captureTeamResources } = await import('./transport');
  return captureTeamResources(p, botId, selection);
} });
export const captureTeamPublication = service.capture;
export const publishTeamPublication = service.publish;
export const getTeamPublicationRollout = service.rollout;
