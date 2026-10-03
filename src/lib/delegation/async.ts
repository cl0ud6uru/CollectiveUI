import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { UIMessageChunk } from "ai";
import { db, type Tx } from "@/db";
import { agentRuns, aiApps, conversations, delegatedTasks, inboxItems, messages } from "@/db/schema";
import type { AgentCtx } from "@/lib/agent/types";
import { hasPendingApproval, logToolCalls } from "@/lib/agent/persist";
import { loadPrincipal } from "@/lib/auth/groups";
import { getUsableBot, HttpError } from "@/lib/authz";
import { rowToUIMessage, updateMessageParts } from "@/lib/chat/store";
import { enqueueRun } from "@/lib/jobs";
import { lockUserRuns } from "@/lib/runs/lock";
import { appendEventsTx, notifyRun } from "@/lib/runs/log";
import { runHost } from "@/lib/runs/host";
import { getRun } from "@/lib/runs/state";
import { isFinal, type AgentRun, type ResumeState } from "@/lib/runs/types";
import { taskResult } from "./execute";
import { admitDelegation, assertTaskExecution } from "./store";
import { MAX_ROOT_ACTIVE_TASKS, type DelegationResult } from "./policy";
import { bindTaskHistory } from "./history";

/** Admission is an outbox record, not dispatch. Only a committed parent suspension releases it to workers. */
export async function startAsyncDelegation(ctx: AgentCtx, receiverId: string, prompt: string, callId: string, authorizationMode: "manual" | "coordinator" = "manual", continuedFromTaskId?: string): Promise<DelegationResult> {
  const { task } = await admitDelegation(ctx, receiverId, prompt, callId, runHost().instanceId, "async", authorizationMode, continuedFromTaskId);
  if (task.returnedAt) return taskResult(task);
  ctx.awaitTask!(task.id);
  return { taskId: task.id, conversationId: task.childConversationId, bot: task.receiverName, status: "queued", steps: [] };
}

/** Called by the ordinary run claim path. The user lock serializes admissions and root concurrency across workers. */
export async function claimAsyncRun(runId: string, holder: string): Promise<AgentRun | null> {
  const run = await getRun(runId);
  if (!run || run.executionMode !== "async_delegate") return null;
  return db.transaction(async tx => {
    await lockUserRuns(tx, run.userId);
    const [task] = await tx.select().from(delegatedTasks).where(and(eq(delegatedTasks.childRunId, runId), eq(delegatedTasks.userId, run.userId), eq(delegatedTasks.mode, "async")));
    if (!task?.parentRunId) return null;
    const predecessors = await tx.select({ status: agentRuns.status }).from(delegatedTasks)
      .leftJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
      .where(and(eq(delegatedTasks.userId, run.userId), eq(delegatedTasks.childConversationId, run.conversationId), lt(delegatedTasks.turn, task.turn)));
    if (predecessors.some(p => p.status && !isFinal(p.status))) return null;
    // A queued native segment is not an execution lease. FIFO and this check also protect
    // resumed segments while the database index enforces a single executing conversation.
    const [busy] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.conversationId, run.conversationId),
      sql`${agentRuns.id} <> ${runId}`, inArray(agentRuns.status, ["running", "waiting_tasks", "waiting"])));
    if (busy) return null;
    const parent = await getRun(task.parentRunId, tx);
    if (!parent || parent.status !== "waiting_tasks" || parent.cancelRequestedAt ||
      !(parent.resumeState as ResumeState | null)?.native?.taskIds.includes(task.id)) return null;
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(delegatedTasks)
      .innerJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
      .where(and(eq(delegatedTasks.userId, run.userId), eq(delegatedTasks.rootMessageId, task.rootMessageId), eq(agentRuns.status, "running")));
    if (count >= MAX_ROOT_ACTIVE_TASKS) return null;
    const [claimed] = await tx.update(agentRuns).set({ status: "running", holder, heartbeatAt: sql`now()`, startedAt: sql`coalesce(${agentRuns.startedAt}, now())`, updatedAt: sql`now()` })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued"), eq(agentRuns.executionMode, "async_delegate"), isNull(agentRuns.cancelRequestedAt))).returning();
    if (claimed && claimed.segment === 0) {
      try { await tx.transaction(sp => bindTaskHistory(sp, task, claimed)); }
      catch (err) {
        if (!(err instanceof HttpError)) throw err;
        // Corrupt/removed history is a terminal failure, never an endlessly requeued claim.
        const { finishFromLogTx } = await import("@/lib/runs/sweeper");
        await finishFromLogTx(tx, claimed, { status: ["running"], holder }, { status: "failed", error: err.message });
        return null;
      }
    }
    return claimed ?? null;
  });
}

/** The saved message precedes this checkpoint. A crash before it leaves unstarted children for cancellation. */
export async function suspendForTasks(run: AgentRun, holder: string, native: NonNullable<ResumeState["native"]>, closing: UIMessageChunk[]): Promise<AgentRun | null> {
  return db.transaction(async tx => {
    await lockUserRuns(tx, run.userId);
    const [current] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, "running"), eq(agentRuns.holder, holder))).for("update");
    if (!current || current.executionMode === "inline_delegate") return null;
    if (current.cancelRequestedAt) {
      const { finishFromLogTx } = await import("@/lib/runs/sweeper");
      return (await finishFromLogTx(tx, current, { status: ["running"], holder }, { status: "cancelled", error: "Stopped. Actions already dispatched may have run." }))?.run ?? null;
    }
    const tasks = await tx.select().from(delegatedTasks).where(and(eq(delegatedTasks.parentRunId, run.id), eq(delegatedTasks.parentSegment, run.segment), eq(delegatedTasks.mode, "async"), isNull(delegatedTasks.returnedAt)));
    if (!native.taskIds.length || new Set(native.taskIds).size !== tasks.length || tasks.some(t => !native.taskIds.includes(t.id) || t.userId !== run.userId || t.originMessageId !== run.messageId))
      throw new HttpError(409, "The assignments do not match this parent segment.");
    const [saved] = await tx.select().from(messages).where(and(eq(messages.id, run.messageId), eq(messages.conversationId, run.conversationId)));
    if (!saved) throw new HttpError(409, "The assigning reply was not saved.");
    for (const task of tasks) {
      await assertTaskExecution(task, tx);
      const part = rowToUIMessage(saved).parts.find(p => "toolCallId" in p && p.toolCallId === task.originToolCallId);
      if (!part || !("output" in part) || !part.output || typeof part.output !== "object" || !("taskId" in part.output) || part.output.taskId !== task.id)
        throw new HttpError(409, "The saved reply did not accept this assignment.");
    }
    const [paused] = await tx.update(agentRuns).set({ status: "waiting_tasks", holder: null, resumeState: { ...(current.resumeState ?? {}), native }, updatedAt: sql`now()` })
      .where(eq(agentRuns.id, run.id)).returning();
    await appendEventsTx(tx, run.id, run.segment, [...closing.map(chunk => ({ kind: "chunk" as const, chunk })), { kind: "segment-end" }]);
    await notifyRun(tx, { r: run.id, k: "t" });
    return paused;
  });
}

async function assertParent(tx: Tx, run: AgentRun, native: NonNullable<ResumeState["native"]>) {
  const principal = await loadPrincipal(run.userId, tx);
  if (!principal || principal.user.sessionVersion !== native.sessionVersion) throw new HttpError(403, "The account or session changed while this reply was suspended.");
  if (native.deadlineAt <= Date.now()) throw new HttpError(409, "The asynchronous task deadline expired.");
  const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.id, run.conversationId), eq(conversations.userId, run.userId)));
  const bot = run.botId ? await getUsableBot(principal, run.botId, tx) : null;
  const [app] = run.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, run.appId)) : [];
  if (!conversation || !bot || conversation.botId !== bot.id || bot.appId !== app?.id || !app?.enabled || app.provider === "hermes" || bot.executionMode === "service")
    throw new HttpError(403, "The assigning bot or connection is no longer available.");
}

type ResultChunk = Extract<UIMessageChunk, { type: "tool-output-available" }>;

/** Child results, receipt, parent transcript and next-segment claim commit together. No tools are replayed here. */
export async function reconcileAsyncParent(parentId: string): Promise<void> {
  const before = await getRun(parentId);
  if (!before || before.status !== "waiting_tasks") return;
  const outcome = await db.transaction(async tx => {
    await lockUserRuns(tx, before.userId);
    const [parent] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, parentId), eq(agentRuns.status, "waiting_tasks"))).for("update");
    if (!parent) return null;
    // Rotate pending parents to the back of the recovery queue, including those still waiting on children.
    await tx.update(agentRuns).set({ updatedAt: sql`now()` }).where(eq(agentRuns.id, parent.id));
    const native = (parent.resumeState as ResumeState | null)?.native;
    const fail = async (error: string, cancelled = false) => {
      const { finishFromLogTx } = await import("@/lib/runs/sweeper");
      const ended = await finishFromLogTx(tx, parent, { status: ["waiting_tasks"] }, { status: cancelled ? "cancelled" : "failed", error });
      return ended ? { finished: ended } : null;
    };
    if (parent.cancelRequestedAt) return fail("Stopped. Actions already dispatched may have run.", true);
    if (!native?.taskIds.length) return fail("This reply has no valid task checkpoint.");
    try { await assertParent(tx, parent, native); }
    catch (err) { return fail(err instanceof HttpError ? err.message : "The assigning reply is no longer authorized."); }
    const rows = await tx.select({ task: delegatedTasks, child: agentRuns }).from(delegatedTasks)
      .leftJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
      .where(and(eq(delegatedTasks.parentRunId, parent.id), eq(delegatedTasks.userId, parent.userId), eq(delegatedTasks.mode, "async"), inArray(delegatedTasks.id, native.taskIds)));
    if (rows.length !== native.taskIds.length || rows.some(r => r.task.originMessageId !== parent.messageId || r.task.parentSegment !== parent.segment))
      return fail("This reply's task checkpoint changed.");
    if (rows.some(r => r.child && !isFinal(r.child.status))) return { queued: rows.flatMap(r => r.child?.status === "queued" ? [r.child] : []) };
    const [stored] = await tx.select().from(messages).where(and(eq(messages.id, parent.messageId), eq(messages.conversationId, parent.conversationId))).for("update");
    if (!stored) return fail("The assigning reply was removed.");
    const message = rowToUIMessage(stored);
    const chunks: ResultChunk[] = [];
    for (const { task } of rows) {
      const part = message.parts.find(p => "toolCallId" in p && p.toolCallId === task.originToolCallId);
      if (!part || !("output" in part) || !part.output || typeof part.output !== "object" || !("taskId" in part.output) || part.output.taskId !== task.id)
        return fail("A task result no longer matches its assigning tool call.");
      let result: DelegationResult;
      try { await assertTaskExecution(task, tx); result = await taskResult(task, tx); }
      catch { result = { taskId: task.id, conversationId: task.childConversationId, bot: task.receiverName, status: "error", steps: [], error: "The assignment is no longer authorized to return a result." }; }
      chunks.push({ type: "tool-output-available", toolCallId: task.originToolCallId, output: result });
    }
    // Result events belong to the next segment: replay crosses the previous suspension's end marker.
    const approval = hasPendingApproval(message);
    const [next] = await tx.update(agentRuns).set({ status: "queued", segment: parent.segment + 1, boundarySeq: parent.lastSeq,
      resumeState: { ...(parent.resumeState ?? {}), native: { ...native, taskIds: [] } }, updatedAt: sql`now()` }).where(eq(agentRuns.id, parent.id)).returning();
    await appendEventsTx(tx, parent.id, next.segment, chunks.map(chunk => ({ kind: "chunk", chunk })));
    // appendEventsTx validates and may replace an unauthorized output; save those exact committed outputs.
    const outputs = new Map(chunks.map(chunk => [chunk.toolCallId, chunk.output]));
    message.parts = message.parts.map(p => "toolCallId" in p && outputs.has(p.toolCallId as string) ? { ...p, state: "output-available", output: outputs.get(p.toolCallId as string) } as typeof p : p);
    await updateMessageParts(parent.conversationId, message, {}, tx);
    if (approval) {
      // Validate task receipts before switching to the separate, human-approval pause.
      await tx.update(agentRuns).set({ status: "waiting" }).where(eq(agentRuns.id, parent.id));
      next.status = "waiting";
      await appendEventsTx(tx, parent.id, next.segment, [{ kind: "segment-end" }]);
    }
    await notifyRun(tx, { r: parent.id, k: approval ? "t" : "q" });
    return { resumed: next, message };
  });
  if (!outcome) return;
  if ("finished" in outcome) {
    const { afterFinishedFromLog } = await import("@/lib/runs/sweeper");
    await afterFinishedFromLog(outcome.finished, outcome.finished.run.error ?? "Stopped.");
  } else if ("queued" in outcome) {
    for (const run of outcome.queued ?? []) await enqueueRun(run).catch(err => console.warn("[tasks] dispatch delayed", err));
  } else {
    await logToolCalls({ runId: outcome.resumed.id, conversationId: outcome.resumed.conversationId, userId: outcome.resumed.userId, botId: outcome.resumed.botId }, outcome.message).catch(() => {});
    if (outcome.resumed.status === "queued") await enqueueRun(outcome.resumed).catch(err => console.warn("[tasks] parent continuation dispatch delayed", err));
    else {
      const { afterRunTransition } = await import("@/lib/runs/hooks");
      await afterRunTransition(outcome.resumed, "waiting", outcome.message);
    }
  }
}

/** Owner-visible notifications and continuation recovery are backed by DB state, not a process callback. */
export async function reconcileAsyncTasks(): Promise<number> {
  const finished = await db.select({ task: delegatedTasks, run: agentRuns }).from(delegatedTasks)
    .innerJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
    .where(and(eq(delegatedTasks.mode, "async"), isNull(delegatedTasks.notifiedAt), inArray(agentRuns.status, ["succeeded", "failed", "cancelled", "interrupted"]))).limit(100);
  for (const { task, run } of finished) await db.transaction(async tx => {
    const [claimed] = await tx.update(delegatedTasks).set({ notifiedAt: sql`now()` }).where(and(eq(delegatedTasks.id, task.id), isNull(delegatedTasks.notifiedAt))).returning();
    if (!claimed || !claimed.childConversationId) return;
    await tx.insert(inboxItems).values({ id: `task_${task.id}`, userId: task.userId, conversationId: claimed.childConversationId,
      kind: run.status === "succeeded" ? "task_result" : "task_error", title: `${task.receiverName}: ${run.status === "succeeded" ? "task completed" : run.status === "cancelled" ? "task stopped" : "task ended"}`,
      body: "Open the task to review its saved result. Interrupted tasks are never restarted automatically." }).onConflictDoNothing();
  });
  const parents = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.status, "waiting_tasks"))
    .orderBy(asc(agentRuns.updatedAt), asc(agentRuns.id)).limit(100);
  for (const parent of parents) await reconcileAsyncParent(parent.id).catch(err => console.error(`[tasks] reconcile ${parent.id}`, err));
  return parents.length + finished.length;
}
