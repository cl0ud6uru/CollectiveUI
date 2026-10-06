import type { ToolUIPart, UIMessageChunk } from "ai";
import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentRuns, delegatedTasks, messages } from "@/db/schema";
import { applyApprovalDecisions } from "@/lib/agent/approval-merge";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { updatePartsLockedTx } from "@/lib/chat/store";
import { enqueueRun } from "@/lib/jobs";
import { lockUserRuns } from "@/lib/runs/lock";
import { appendEventsTx } from "@/lib/runs/log";
import { getRun, requeueRunTx } from "@/lib/runs/state";
import type { ResumeState } from "@/lib/runs/types";
import { assertTaskExecution } from "./store";
import { resolveTaskSource } from "./source";

type Part = ToolUIPart & { approval?: { id: string; approved?: boolean; reason?: string } };
const workspaceRequest = (part: Part) => /^tool-workspace_(bash|write|edit|read|list|grep)$/.test(part.type) && !!part.approval?.id;

/** The route can be used in the task transcript or the root human conversation, never another assignment. */
async function scope(p: Principal, conversationId: string, runId: string, q: DbOrTx) {
  const [task] = await q.select().from(delegatedTasks).where(and(eq(delegatedTasks.childRunId, runId), eq(delegatedTasks.userId, p.user.id), eq(delegatedTasks.mode, "async")));
  if (!task) throw new HttpError(404, "Approval request not found");
  const source = await resolveTaskSource(task, q);
  if (conversationId !== task.childConversationId && conversationId !== source.conversationId) throw new HttpError(404, "Approval request not found");
  await assertTaskExecution(task, q);
  const run = await getRun(runId, q);
  const parent = task.parentRunId ? await getRun(task.parentRunId, q) : null;
  if (!run || run.userId !== p.user.id || run.executionMode !== "async_delegate" || run.cancelRequestedAt ||
      !(run.resumeState as ResumeState | null)?.native || parent?.status !== "waiting_tasks" ||
      !(parent.resumeState as ResumeState | null)?.native?.taskIds.includes(task.id))
    throw new HttpError(409, "This assignment can no longer accept approvals");
  return { task, run };
}

export async function pendingTaskApprovals(p: Principal, conversationId: string) {
  await getOwnedConversation(p, conversationId);
  const rows = await db.select({ run: agentRuns, task: delegatedTasks, parts: messages.parts }).from(agentRuns)
    .innerJoin(delegatedTasks, and(eq(delegatedTasks.childRunId, agentRuns.id), eq(delegatedTasks.userId, p.user.id)))
    .innerJoin(messages, and(eq(messages.id, agentRuns.messageId), eq(messages.conversationId, agentRuns.conversationId)))
    .where(and(eq(agentRuns.userId, p.user.id), eq(agentRuns.executionMode, "async_delegate"), eq(agentRuns.status, "waiting"))).limit(16);
  const requests = [];
  for (const row of rows) {
    try { await scope(p, conversationId, row.run.id, db); } catch (err) { if (err instanceof HttpError) continue; throw err; }
    for (const part of row.parts as Part[]) if (workspaceRequest(part) && part.state === "approval-requested")
      requests.push({ runId: row.run.id, taskId: row.task.id, conversationId: row.run.conversationId, messageId: row.run.messageId,
        botName: row.task.receiverName, assignerName: row.task.assignerName, expiresAt: row.task.deadlineAt.toISOString(), part });
  }
  return requests;
}
export type TaskApprovalRequest = Awaited<ReturnType<typeof pendingTaskApprovals>>[number];

export async function answerTaskApproval(p: Principal, conversationId: string, answer: { runId: string; approvalId: string; approved: boolean; reason?: string }) {
  const current = await loadPrincipal(p.user.id);
  if (!current || current.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "The account or session changed");
  await getOwnedConversation(current, conversationId);
  const result = await db.transaction(async tx => {
    await lockUserRuns(tx, current.user.id);
    const [locked] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, answer.runId), eq(agentRuns.userId, current.user.id))).for("update");
    if (!locked) throw new HttpError(404, "Approval request not found");
    const { run } = await scope(current, conversationId, locked.id, tx);
    const [stored] = await tx.select().from(messages).where(and(eq(messages.id, run.messageId), eq(messages.conversationId, run.conversationId))).for("update");
    const part = (stored?.parts as Part[] | undefined)?.find(p => workspaceRequest(p) && p.approval?.id === answer.approvalId);
    if (!part) throw new HttpError(404, "Approval request not found");
    if (part.state !== "approval-requested") {
      if (part.approval?.approved === answer.approved) return { run, enqueue: false };
      throw new HttpError(409, "This request was already answered");
    }
    if (run.status !== "waiting") throw new HttpError(409, "This assignment is no longer waiting for approval");
    const claimed = await updatePartsLockedTx(tx, run.conversationId, run.messageId, row =>
      applyApprovalDecisions(row.parts as Part[], new Map([[answer.approvalId, { approved: answer.approved, reason: answer.reason }]])).parts);
    if (!claimed?.parts) throw new HttpError(409, "Approval request changed");
    const chunk: UIMessageChunk = { type: "tool-approval-response", approvalId: answer.approvalId, approved: answer.approved, ...(answer.reason ? { reason: answer.reason } : {}) };
    if ((claimed.parts as Part[]).some(p => workspaceRequest(p) && p.state === "approval-requested")) {
      await appendEventsTx(tx, run.id, run.segment, [{ kind: "chunk", chunk }]);
      return { run, enqueue: false };
    }
    const queued = await requeueRunTx(tx, run.id, p.user.id, [chunk]);
    if (!queued) throw new HttpError(409, "Approval request changed");
    return { run: queued, enqueue: true };
  });
  // A lost queue delivery is recovered from this committed queued row by the ordinary sweeper.
  if (result.enqueue) await enqueueRun(result.run).catch(err => console.warn("[tasks] approval continuation dispatch delayed", err));
  return { accepted: true, runId: result.run.id, status: result.run.status };
}
