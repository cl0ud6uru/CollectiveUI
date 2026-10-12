import { HttpError } from '@/lib/authz';
import { and, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { agentRuns, codexBotConfigs, codexRuns } from '@/db/schema';
import type { RunHandle } from '@/lib/runs/types';
import { CodexPolicySchema } from './config';
import type { CodexRuntime } from './runtime';
import { runtimeBinding } from './binding';

export async function codexPolicy(botId: string, q: DbOrTx = db) {
  const [row] = await q.select().from(codexBotConfigs).where(eq(codexBotConfigs.botId, botId));
  return row ? CodexPolicySchema.parse(row.policy) : null;
}
export async function reserveCodexRun(run: RunHandle, runtime: CodexRuntime) {
  await db.transaction(async tx => {
    const { lockPersonalOwner } = await import('@/personal-codex/accounts');
    await lockPersonalOwner(runtime.ownerId, tx);
    if (runtime.managed) {
      const { personalAccount } = await import('@/personal-codex/accounts');
      if ((await personalAccount(runtime.ownerId, tx))?.credentialBinding !== runtime.credentialBinding) throw new HttpError(409, 'Your Codex connection changed before reservation.');
    }
    await fence(run, runtime.ownerId, tx);
    const [unresolved] = await tx.select().from(codexRuns).where(and(eq(codexRuns.userId, runtime.ownerId), ne(codexRuns.phase, 'terminal'))).limit(1);
    if (unresolved) throw new HttpError(409, 'An earlier Codex request is active or its stop is unconfirmed. Wait for runtime recovery before starting another request.');
    // A repeated worker delivery must not dispatch this run again, including an uncertain previous attempt.
    const rows = await tx.insert(codexRuns).values({ runId: run.id, userId: runtime.ownerId, runtimeId: runtime.id,
      binding: runtimeBinding(runtime), funding: runtime.funding, phase: 'reserved' }).onConflictDoNothing().returning();
    if (!rows.length) throw new HttpError(409, 'This Codex request already has a runtime attempt. It cannot be replayed.');
  });
}
async function fence(run: RunHandle, ownerId: string, q: DbOrTx) {
  const [row] = await q.select().from(agentRuns).where(and(eq(agentRuns.id, run.id), eq(agentRuns.userId, ownerId),
    eq(agentRuns.status, 'running'), eq(agentRuns.holder, run.holder ?? ''), isNull(agentRuns.cancelRequestedAt))).for('update');
  if (!row || row.segment !== 0 || row.background || row.executionMode !== 'worker') throw new HttpError(409, 'This Codex run no longer has permission to dispatch.');
}
export async function checkpointCodexRun(run: RunHandle, ownerId: string, values: Partial<Pick<typeof codexRuns.$inferInsert, 'threadId' | 'turnId' | 'baselineTurnId' | 'phase'>>) {
  await db.transaction(async tx => {
    await fence(run, ownerId, tx);
    const rows = await tx.update(codexRuns).set({ ...values, updatedAt: new Date() }).where(and(eq(codexRuns.runId, run.id),
      eq(codexRuns.userId, ownerId), ne(codexRuns.phase, 'terminal'))).returning();
    if (!rows.length) throw new HttpError(409, 'This Codex runtime attempt has already ended.');
  });
}
export async function pendingCodexStops() {
  return db.select({ execution: codexRuns }).from(codexRuns).leftJoin(agentRuns, eq(agentRuns.id, codexRuns.runId))
    .where(and(ne(codexRuns.phase, 'terminal'), lt(codexRuns.updatedAt, new Date(Date.now() - 30000)),
      or(isNull(agentRuns.id), inArray(agentRuns.status, ['succeeded', 'failed', 'cancelled', 'interrupted'])))).limit(10);
}
