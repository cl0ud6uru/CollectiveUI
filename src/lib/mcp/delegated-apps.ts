import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { agentRuns, delegatedTasks } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { getOwnedConversation, HttpError } from '@/lib/authz';
import { assertPersistedDelegationEdge } from '@/lib/coordinator/delegation';
import { resolveTaskSource } from '@/lib/delegation/source';

/** Human widget actions outlive the bot run, but never its saved ownership or current delegation permissions. */
export async function authorizeDelegatedApp(p: Principal, runId: string | null | undefined, conversationId: string, botId: string, taskId?: string) {
  const [row] = runId ? await db.select({ task: delegatedTasks, run: agentRuns }).from(delegatedTasks)
    .innerJoin(agentRuns, and(eq(agentRuns.id, delegatedTasks.childRunId), eq(agentRuns.userId, p.user.id)))
    .where(and(eq(delegatedTasks.userId, p.user.id), eq(delegatedTasks.childRunId, runId),
      eq(delegatedTasks.childConversationId, conversationId), eq(delegatedTasks.receiverBotId, botId))) : [];
  if (!row || (taskId && row.task.id !== taskId) || row.task.sessionVersion !== p.user.sessionVersion ||
      row.run.conversationId !== conversationId || row.run.botId !== botId || row.run.cancelRequestedAt ||
      !['inline_delegate', 'async_delegate'].includes(row.run.executionMode) || ['cancelled', 'interrupted', 'failed'].includes(row.run.status))
    throw new HttpError(403, 'This widget assignment is unavailable. Request a fresh draft.');
  const source = await resolveTaskSource(row.task);
  const origin = await getOwnedConversation(p, source.conversationId);
  if (origin.source !== 'chat' || origin.isGroup || origin.archived || !source.run || source.run.background || source.run.routineRunId ||
      source.run.cancelRequestedAt || ['cancelled', 'interrupted', 'failed'].includes(source.run.status))
    throw new HttpError(403, 'Delegated widgets require an active human-owned originating chat.');
  for (const edge of row.task.ancestry) await assertPersistedDelegationEdge(p, edge, source, row.task.mode === 'async');
  return { sourceConversationId: origin.id };
}
