import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { hermesTeamRevisions } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { authorizeTeam } from './store';
import { createTeamPublicationService } from './publication';
import { createTeamResourceSnapshot, validateTeamResourceSnapshot, type TeamResourceSnapshot } from './resources';

/** Team release metadata contains no private member identity or resource state. */
export async function teamRevisionHistory(p: Principal, botId: string) {
  await authorizeTeam(p, botId, 'admin');
  const revisions = await db.select({ revision: hermesTeamRevisions.revision, releaseNote: hermesTeamRevisions.releaseNote,
    publishedAt: hermesTeamRevisions.createdAt, manifestHash: hermesTeamRevisions.manifestHash }).from(hermesTeamRevisions)
    .where(eq(hermesTeamRevisions.botId, botId)).orderBy(desc(hermesTeamRevisions.revision)).limit(100);
  await authorizeTeam(p, botId, 'admin');
  return { revisions: revisions.map(row => ({ ...row, publishedAt: row.publishedAt.toISOString() })) };
}
const inputSchema = z.object({ targetRevision: z.number().int().min(0), expectedRevision: z.number().int().min(1).max(2147483646) }).strict()
  .refine(input => input.targetRevision < input.expectedRevision, 'Choose an earlier published revision.');

/** Restore is reviewed like any publication and creates a new immutable revision. */
export async function captureTeamRollback(p: Principal, botId: string, raw: unknown) {
  const input = inputSchema.parse(raw);
  await authorizeTeam(p, botId, 'admin');
  const service = createTeamPublicationService({ captureResources: async () => {
    if (input.targetRevision === 0) return createTeamResourceSnapshot([]);
    const [target] = await db.select({ manifest: hermesTeamRevisions.manifest, hash: hermesTeamRevisions.manifestHash }).from(hermesTeamRevisions)
      .where(and(eq(hermesTeamRevisions.botId, botId), eq(hermesTeamRevisions.revision, input.targetRevision)));
    if (!target) throw new HttpError(404, 'Published Team version not found.');
    try {
      const snapshot = validateTeamResourceSnapshot(target.manifest as unknown as TeamResourceSnapshot);
      if (snapshot.manifestHash !== target.hash) throw new Error('Invalid stored release hash');
      return snapshot;
    } catch { throw new HttpError(503, 'The published Team version needs attention.'); }
  } });
  return service.capture(p, botId, { expectedRevision: input.expectedRevision, selection: {} });
}
