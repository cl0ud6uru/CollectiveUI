import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DbOrTx } from '@/db';
import { agentRuns, botAccess, botUserAccess, bots, hermesTeamCandidateContexts, hermesTeamDefinitions, hermesTeamMaintainers, hermesTeamOperations, hermesTeamProfiles } from '@/db/schema';
import { loadPrincipal } from '@/lib/auth/groups';
import { dockerControl } from '@/lib/docker-hermes/client';
import { OPEN_STATUSES } from '@/lib/runs/types';
import { teamModeAllows } from './policy';

const target = z.object({ userId: z.string().min(1), mode: z.enum(['member','admin']), definitionVersion: z.number().int().positive(), reason: z.enum(['policy_changed','audience_changed','principal_changed','bot_disabled']), accessRevoked: z.boolean() });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readTeamRevocationTarget(receipt: { result: unknown; digest: string }) {
  const parsed = target.safeParse(receipt.result);
  return parsed.success && digest(parsed.data) === receipt.digest ? parsed.data : null;
}

/** Called inside the audience/configuration mutation, under its bot lock. No broker I/O inside the transaction. */
export async function queueTeamAccessReconciliation(q: DbOrTx, botId: string, actorId: string, options: {
  reason: 'policy_changed' | 'audience_changed' | 'principal_changed' | 'bot_disabled'; force?: boolean; previousMaintainerIds?: string[]; scopeUserId?: string; mutationId?: string;
}) {
  const [bot] = await q.select().from(bots).where(eq(bots.id, botId));
  const [definition] = await q.select().from(hermesTeamDefinitions).where(eq(hermesTeamDefinitions.botId, botId));
  if (!bot?.hermesTeam || !definition) return;
  const profiles = await q.select().from(hermesTeamProfiles).where(eq(hermesTeamProfiles.botId, botId));
  const maintainers = await q.select().from(hermesTeamMaintainers).where(eq(hermesTeamMaintainers.botId, botId));
  const maintainerIds = maintainers.map(r => r.userId);
  const groups = await q.select().from(botAccess).where(eq(botAccess.botId, botId));
  const users = await q.select().from(botUserAccess).where(eq(botUserAccess.botId, botId));
  for (const profile of profiles) {
    const actors = profile.mode === 'member' ? [profile.userId!] : [...new Set([...maintainerIds, ...options.previousMaintainerIds ?? []])];
    for (const userId of actors) {
      if (options.scopeUserId && options.scopeUserId !== userId) continue;
      const principal = await loadPrincipal(userId, q);
      const allowed = !!principal && bot.enabled && definition.enabled && teamModeAllows(principal, bot,
        { groupIds: groups.map(r => r.groupId), userIds: users.map(r => r.userId) }, maintainerIds, profile.mode);
      if (allowed && !options.force) continue;
      if (!allowed && !options.force && profile.mode === 'member' && profile.state === 'revoked') continue;
      const value = { userId, mode: profile.mode, definitionVersion: definition.version, reason: options.reason, accessRevoked: !allowed };
      const requestId = `revoke:${digest([botId, bot.revision, definition.version, profile.id, value, options.mutationId ?? null])}`;
      await q.insert(hermesTeamOperations).values({ botId, profileId: profile.id, actorId, requestId, kind: 'revoke', digest: digest(value), result: value }).onConflictDoNothing();
      // A queued/waiting approval cannot continue while runtime reconciliation is pending or unavailable.
      await q.update(agentRuns).set({ cancelRequestedAt: new Date() }).where(and(eq(agentRuns.botId, botId), eq(agentRuns.userId, userId), inArray(agentRuns.status, [...OPEN_STATUSES])));
      // Gateway grants are server-owned and revoke in the same transaction as audience/session changes.
      await q.update(hermesTeamCandidateContexts).set({ revokedAt: new Date() }).where(and(eq(hermesTeamCandidateContexts.botId,botId),eq(hermesTeamCandidateContexts.actorId,userId)));
      // Shared admin profile state belongs to all maintainers, so one removed actor does not revoke their retained profile.
      if (profile.mode === 'member' || !definition.enabled || !bot.enabled || options.force) {
        const profileAllowed = profile.mode === 'member' ? allowed : bot.enabled && definition.enabled && maintainerIds.length > 0;
        await q.update(hermesTeamProfiles).set({ state: profileAllowed ? 'connection_needed' : 'revoked', updatedAt: new Date() }).where(eq(hermesTeamProfiles.id, profile.id));
      }
    }
  }
}

/** Lock before group/account writes so bot edits and provisioning cannot retain a grant from the old permissions. */
export async function lockTeamAccessBots(q: DbOrTx) {
  const definitions = await q.select({ botId: hermesTeamDefinitions.botId }).from(hermesTeamDefinitions);
  const botIds = definitions.map(r => r.botId).sort();
  for (const botId of botIds) {
    await q.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('update');
  }
  return botIds;
}

/** Role/group/account edits can affect audience and maintainer access without editing a bot. Caller holds bot locks. */
export async function queueTeamPrincipalAccessReconciliation(q: DbOrTx, botIds: string[], actorId: string, userId?: string, force = false) {
  // Group and account edits do not increment the bot definition. A new mutation must not reuse a completed old revocation.
  const mutationId = randomUUID();
  for (const botId of botIds) {
    await queueTeamAccessReconciliation(q, botId, actorId, { reason: userId ? 'principal_changed' : 'audience_changed', scopeUserId: userId, force, mutationId });
  }
  return botIds;
}

/** Safe to retry after crashes. Failed native cleanup retains a durable needs-attention receipt and all native data. */
export async function reconcileTeamAccess(botId: string) {
  const rows = await db.select().from(hermesTeamOperations).where(and(eq(hermesTeamOperations.botId, botId), eq(hermesTeamOperations.kind, 'revoke'), inArray(hermesTeamOperations.state, ['pending','needs_attention'])));
  for (const receipt of rows) {
    await db.transaction(async tx => {
      // Re-read under a row lock: a caller that selected an old pending row cannot revoke a newly reopened grant.
      const [current] = await tx.select().from(hermesTeamOperations).where(eq(hermesTeamOperations.id, receipt.id)).for('update');
      if (!current || current.botId !== botId || current.kind !== 'revoke' || current.state === 'complete') return;
      const currentTarget = readTeamRevocationTarget(current);
      if (!currentTarget) {
        await tx.update(hermesTeamOperations).set({ state: 'needs_attention', updatedAt: new Date() }).where(eq(hermesTeamOperations.id, current.id));
        return;
      }
      try {
        const response = await dockerControl<unknown>(currentTarget.userId, '/team/revoke', { teamBotId: botId, mode: currentTarget.mode, requestId: current.requestId, digest: current.digest }, 3000);
        const result = z.object({ stopped: z.boolean(), interruption: z.enum(['none','runtime-wide']) }).strict().parse(response);
        await tx.update(hermesTeamOperations).set({ state: 'complete', result: { ...currentTarget, ...result }, updatedAt: new Date() }).where(eq(hermesTeamOperations.id, current.id));
      } catch {
        await tx.update(hermesTeamOperations).set({ state: 'needs_attention', updatedAt: new Date() }).where(eq(hermesTeamOperations.id, current.id));
      }
    });
  }
}

/** Post-commit hook for directory/session mutations, including nested authentication transactions. */
export async function reconcileTeamActorAccess(userId: string) {
  const receipts = await db.select({ botId: hermesTeamOperations.botId, result: hermesTeamOperations.result }).from(hermesTeamOperations)
    .where(and(eq(hermesTeamOperations.kind, 'revoke'), inArray(hermesTeamOperations.state, ['pending','needs_attention'])));
  for (const botId of new Set(receipts.filter(r => r.result?.userId === userId).map(r => r.botId))) await reconcileTeamAccess(botId);
}
