import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentRuns, bots, conversations, delegatedTasks } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { loadPrincipal } from "@/lib/auth/groups";
import { isFinal } from "@/lib/runs/types";
import { HttpError } from "@/lib/authz";
import { assertTaskExecution } from "./store";

export async function ownedTask(p: Principal, conversationId: string, q: DbOrTx = db, runId?: string) {
  const [row] = await q.select({ task: delegatedTasks, run: agentRuns }).from(delegatedTasks)
    .innerJoin(conversations, and(eq(conversations.id, delegatedTasks.childConversationId), eq(conversations.userId, p.user.id), eq(conversations.source, "delegation")))
    .innerJoin(agentRuns, and(eq(agentRuns.id, delegatedTasks.childRunId), eq(agentRuns.userId, p.user.id), eq(agentRuns.conversationId, conversationId), eq(agentRuns.botId, delegatedTasks.receiverBotId), or(eq(conversations.botId, delegatedTasks.receiverBotId), and(isNull(conversations.botId), sql`not exists (select 1 from ${bots} where ${bots.id} = ${delegatedTasks.receiverBotId})`))))
    .where(and(eq(delegatedTasks.userId, p.user.id), eq(delegatedTasks.childConversationId, conversationId), runId ? eq(agentRuns.id, runId) : undefined))
    .orderBy(sql`case when ${agentRuns.status} in ('running', 'waiting_tasks', 'waiting') then 0 when ${agentRuns.status} = 'queued' then 1 else 2 end`,
      sql`case when ${agentRuns.status} in ('queued', 'running', 'waiting_tasks', 'waiting') then ${delegatedTasks.turn} end`, desc(delegatedTasks.turn)).limit(1);
  if (!row) throw new HttpError(404, "Task not found.");
  return row;
}

/** Historical transcripts remain the human owner's history; only live work requires current ancestry access. */
export async function taskView(p: Principal, conversationId: string, q: DbOrTx = db) {
  const { task, run } = await ownedTask(p, conversationId, q);
  const [{ queuedCount }] = await q.select({ queuedCount: sql<number>`count(*)::int` }).from(delegatedTasks)
    .innerJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
    .where(and(eq(delegatedTasks.userId, p.user.id), eq(delegatedTasks.childConversationId, conversationId), eq(agentRuns.status, "queued"), sql`${delegatedTasks.id} <> ${task.id}`));
  let executionUnavailable: string | null = null;
  if (["queued", "running", "waiting_tasks"].includes(run.status)) {
    try { await assertTaskExecution(task, q); } catch { executionUnavailable = "Live access to this assignment ended. Its saved history remains available."; }
  }
  const [origin] = task.originConversationId ? await q.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.id, task.originConversationId), eq(conversations.userId, p.user.id))) : [];
  const [parent] = !task.returnedAt && task.parentRunId ? await q.select({ status: agentRuns.status }).from(agentRuns)
    .where(and(eq(agentRuns.id, task.parentRunId), eq(agentRuns.userId, p.user.id))) : [];
  return { id: task.id, turn: task.turn, queuedCount, assigner: task.assignerName, receiver: task.receiverName, originConversationId: origin?.id ?? null,
    mode: task.mode, status: run.status, runId: run.id, lastSeq: run.lastSeq, error: run.error, returnedAt: task.returnedAt?.toISOString() ?? null,
    deliveryPending: !!parent && !isFinal(parent.status),
    cancelRequested: !!run.cancelRequestedAt, executionUnavailable };
}
export type TaskView = Awaited<ReturnType<typeof taskView>>;

/** A finished transcript is owner history, not permission to execute or return new results. */
export async function authorizeTaskRead(p: Principal, conversationId: string, runId: string) {
  const current = await loadPrincipal(p.user.id);
  if (!current || current.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "The account or session changed.");
  const { task, run } = await ownedTask(current, conversationId, db, runId);
  if (!isFinal(run.status)) await assertTaskExecution(task);
}
