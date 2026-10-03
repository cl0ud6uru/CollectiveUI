import { and, eq, isNull, sql } from "drizzle-orm";
import { assertTaskExecution } from "./store";
import type { DbOrTx, Tx } from "@/db";
import { agentRuns, delegatedTasks } from "@/db/schema";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { EventDraft } from "@/lib/runs/types";

/** Only a server-owned assignment matching this exact parent call can receive an acknowledgment. */
async function receipt(tx: DbOrTx, origin: { userId: string; conversationId: string; messageId: string; runId: string | null }, callId: string, output: unknown, seq: number | null, record = true) {
  if (!output || typeof output !== "object" || !("taskId" in output) || typeof output.taskId !== "string") return "ordinary";
  // Resolve the invocation before the child join: a deleted child leaves an admission tombstone.
  const [task] = await tx.select().from(delegatedTasks).where(and(eq(delegatedTasks.userId, origin.userId),
    eq(delegatedTasks.originMessageId, origin.messageId), eq(delegatedTasks.originToolCallId, callId)));
  if (!task) return "ordinary";
  if (task.id !== output.taskId || task.originConversationId !== origin.conversationId || task.parentRunId !== origin.runId) return "unauthorized";
  if (task.returnedAt) return "duplicate";
  if (!task.childRunId || !task.childConversationId) return "unauthorized";
  const [child] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, task.childRunId), eq(agentRuns.userId, task.userId),
    eq(agentRuns.conversationId, task.childConversationId), eq(agentRuns.botId, task.receiverBotId), eq(agentRuns.executionMode, task.mode === "async" ? "async_delegate" : "inline_delegate")));
  if (!child) return "unauthorized";
  if (task.mode === "async" && "status" in output && output.status === "queued") {
    try { await assertTaskExecution(task, tx); return "pending"; } catch { return "unauthorized"; }
  }
  if (["running", "queued", "waiting_tasks", "waiting"].includes(child.status)) return "unauthorized";
  if ("status" in output && output.status === "done") {
    if (child.status !== "succeeded") return "unauthorized";
    try { await assertTaskExecution(task, tx); }
    catch { return "unauthorized"; }
  }
  if (!record) return "valid";
  await tx.update(delegatedTasks).set({ returnedAt: sql`now()`, parentResultSeq: seq }).where(and(eq(delegatedTasks.id, task.id), isNull(delegatedTasks.returnedAt)));
  return "recorded";
}

/** Runs inside appendEventsTx; receipt and exact parent event either both commit or neither does. */
export async function receiveDelegationEvents(tx: Tx, run: { id: string; userId: string; conversationId: string; messageId: string; lastSeq: number }, drafts: EventDraft[]) {
  const kept: EventDraft[] = [];
  for (const draft of drafts) {
    const c = draft.kind === "chunk" ? draft.chunk : null;
    if (c?.type === "tool-output-available" && !c.preliminary) {
      const outcome = await receipt(tx, { ...run, runId: run.id }, c.toolCallId, c.output, run.lastSeq + kept.length + 1);
      if (outcome === "duplicate") continue;
      if (outcome === "unauthorized") c.output = { status: "error", error: "The assignment is no longer authorized to return a result." };
    }
    kept.push(draft);
  }
  return kept;
}

/** Group turns have no event log; their committed assistant message is the durable receipt. */
export async function receiveGroupResults(tx: Tx, userId: string, conversationId: string, message: PortalUIMessage) {
  for (const p of message.parts) if ((p.type === "dynamic-tool" || p.type.startsWith("tool-")) && "state" in p && p.state === "output-available" && "toolCallId" in p && "output" in p && !("preliminary" in p && p.preliminary))
    if (await receipt(tx, { userId, conversationId, messageId: message.id, runId: null }, p.toolCallId as string, p.output, null) === "unauthorized")
      p.output = { status: "error", error: "The assignment is no longer authorized to return a result." };
}

/** Links are private execution metadata, never authority carried through shared/copy transcripts. */
export function stripTaskLinks(parts: unknown[]): unknown[] {
  return parts.map(p => {
    if (!p || typeof p !== "object") return p;
    const part = p as Record<string, unknown>;
    if (!part.output || typeof part.output !== "object" || !("taskId" in part.output)) return p;
    const { taskId: _task, conversationId: _conversation, ...output } = part.output as Record<string, unknown>;
    void _task; void _conversation;
    return { ...part, output };
  });
}

/** The SDK's final message is separate from event chunks. Do not retain a result rejected at dispatch. */
export async function sanitizeUndeliveredResults(q: DbOrTx, origin: { userId: string; conversationId: string; runId?: string }, message: PortalUIMessage) {
  if (!origin.runId) return;
  for (const p of message.parts) if ((p.type === "dynamic-tool" || p.type.startsWith("tool-")) && "state" in p && p.state === "output-available" && "toolCallId" in p && "output" in p && !("preliminary" in p && p.preliminary)) {
    const result = await receipt(q, { ...origin, messageId: message.id, runId: origin.runId }, p.toolCallId as string, p.output, null, false);
    if (result === "unauthorized" || result === "valid")
      p.output = { status: "error", error: "The assignment has no authorized, committed result in this chat." };
  }
}
