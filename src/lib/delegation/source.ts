import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentRuns, conversations, delegatedTasks } from "@/db/schema";
import type { AgentCtx } from "@/lib/agent/types";
import { HttpError } from "@/lib/authz";
import type { DelegatedTask } from "./store";

export type DelegationEdge = { from: string; to: string; mode?: "manual" | "coordinator" };

/** Resolved server-side provenance. Child background/conversation identity is never rewritten. */
export async function resolveTaskSource(task: DelegatedTask, q: DbOrTx = db) {
  const [root] = await q.select().from(delegatedTasks).where(and(eq(delegatedTasks.id, task.rootTaskId), eq(delegatedTasks.userId, task.userId)));
  if (!root || root.parentTaskId || root.rootTaskId !== root.id || root.depth !== 1 || root.rootMessageId !== task.rootMessageId ||
      root.originMessageId !== task.rootMessageId || root.sessionVersion !== task.sessionVersion || !root.originConversationId ||
      JSON.stringify(root.ancestry) !== JSON.stringify(task.ancestry.slice(0, 1)))
    throw new HttpError(403, "This assignment's original authority is unavailable.");
  return resolveSource({ userId: root.userId, sessionVersion: root.sessionVersion, conversationId: root.originConversationId,
    runId: root.parentRunId, messageId: root.originMessageId, botId: root.assignerBotId,
    rootTaskId: root.id, toolCallId: root.originToolCallId, inputHash: root.inputHash }, q);
}

/** Admission's direct source or its already persisted root, with the same owner/run binding as dispatch. */
export async function resolveAdmissionSource(ctx: AgentCtx, parent: DelegatedTask | undefined, toolCallId: string, inputHash: string, q: DbOrTx = db) {
  if (parent) return resolveTaskSource(parent, q);
  return resolveSource({ userId: ctx.principal.user.id, sessionVersion: ctx.principal.user.sessionVersion,
    conversationId: ctx.conversationId, runId: ctx.usage?.runId ?? null, messageId: ctx.usage!.messageId!, botId: ctx.bot!.id,
    rootTaskId: null, toolCallId, inputHash }, q);
}

async function resolveSource(binding: { userId: string; sessionVersion: number; conversationId: string; runId: string | null;
  messageId: string; botId: string; rootTaskId: string | null; toolCallId: string; inputHash: string }, q: DbOrTx) {
  const [conversation] = await q.select().from(conversations).where(and(eq(conversations.id, binding.conversationId), eq(conversations.userId, binding.userId)));
  const [run] = binding.runId ? await q.select().from(agentRuns).where(eq(agentRuns.id, binding.runId)) : [];
  if (!conversation || conversation.source === "delegation" ||
      (binding.runId && (!run || run.userId !== binding.userId || run.conversationId !== conversation.id || run.messageId !== binding.messageId || run.botId !== binding.botId || run.executionMode !== "worker")) ||
      (!conversation.isGroup && conversation.botId !== binding.botId) || (!run && !conversation.isGroup))
    throw new HttpError(403, "This assignment's source no longer matches its original request.");
  return { kind: "persisted-source" as const, ...binding, conversation, run: run ?? null };
}
export type DelegationSource = Awaited<ReturnType<typeof resolveTaskSource>>;
