import { sanitizeUndeliveredResults } from "@/lib/delegation/receipts";
import { hasPendingAsyncTasks, isDelegationTool } from "@/lib/delegation/policy";
import { getToolOrDynamicToolName, isToolUIPart } from "ai";
import { eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { conversations, toolCalls, type ToolCallStatus } from "@/db/schema";
import { setCurrentLeaf, updateMessageParts, upsertMessage, type PortalUIMessage } from "@/lib/chat/store";
import { scheduleMemoryExtraction } from "@/lib/jobs";
import { jsonbSafe } from "@/lib/jsonb";
import type { BillingSource, ProviderKind } from "@/lib/llm";
import { sha256Hex } from "@/lib/crypto";

/** Who a turn's tool calls are attributed to in the audit log. */
export type ToolLogContext = { conversationId: string; userId: string; botId: string | null; runId?: string };

/**
 * A tool call's audit status. Streaming tools (workspace commands, delegates) report progress as "preliminary"
 * outputs; a part still preliminary when the turn ended was cut off, so it counts as an error, not done.
 */
export function toolStatus(state: string, preliminary?: boolean): ToolCallStatus | null {
  if (state === "output-available" && preliminary) return "error";
  switch (state) {
    case "approval-requested":
      return "pending_approval";
    case "approval-responded":
      return "approved";
    case "output-denied":
      return "denied";
    case "output-available":
      return "done";
    case "output-error":
      return "error";
    default:
      return null;
  }
}

export function hasPendingApproval(msg: PortalUIMessage) {
  return msg.parts.some((p) => isToolUIPart(p) && p.state === "approval-requested");
}

export async function logToolCalls(ctx: ToolLogContext, msg: PortalUIMessage) {
  for (const p of msg.parts) {
    if (!isToolUIPart(p)) continue;
    const preliminary = "preliminary" in p && p.preliminary === true;
    let status = toolStatus(p.state, preliminary);
    if (status === "done" && isDelegationTool(getToolOrDynamicToolName(p)) && "output" in p && p.output && typeof p.output === "object" && "status" in p.output && ["error", "cancelled", "interrupted"].includes(String(p.output.status))) status = "error";
    if (!status) continue;
    const output = preliminary
      ? { interrupted: true, last: p.output }
      : "output" in p
        ? p.output
        : "errorText" in p
          ? { error: p.errorText }
          : null;
    const values = {
      id: `call_${sha256Hex(`${msg.id}:${p.toolCallId}`)}`,
      runId: ctx.runId ?? null,
      providerCallId: p.toolCallId,
      conversationId: ctx.conversationId,
      messageId: msg.id,
      userId: ctx.userId,
      botId: ctx.botId,
      toolName: getToolOrDynamicToolName(p),
      input: jsonbSafe(p.input ?? null) as object | null,
      output: jsonbSafe(output) as object | null,
      status,
    };
    await db
      .insert(toolCalls)
      .values(values)
      .onConflictDoUpdate({ target: [toolCalls.messageId, toolCalls.providerCallId], set: { runId: ctx.runId ?? null, status, output: values.output } })
      .catch((err) => console.error("[agent] tool call log failed", err));
  }
}

export type PersistTurnInput = ToolLogContext & {
  responseMessage: PortalUIMessage;
  /** True when the response extends an existing assistant message (tool approval continuation). */
  isContinuation: boolean;
  parentId: string | null;
  extra: {
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    billingSource?: BillingSource | null;
    providerKind?: ProviderKind | null;
    appId?: string | null;
  };
  /** A routine's first segment: no memory extraction (see TurnOptions.background). */
  background: boolean;
};

/**
 * Saves the assistant message: a continuation updates the stored message, a new turn inserts it (or updates it when
 * the same run saves it again), the branch leaf moves to it and the conversation is bumped. `q` lets the run executor
 * do this in its fenced transaction; `leafOnlyFrom` moves the leaf only while it's still one of those ids.
 */
export async function saveAssistantMessage(i: PersistTurnInput, q: DbOrTx = db, opts: { leafOnlyFrom?: string[] } = {}): Promise<void> {
  const { conversationId, responseMessage, isContinuation, extra } = i;
  await sanitizeUndeliveredResults(q, i, responseMessage);
  if (isContinuation) await updateMessageParts(conversationId, responseMessage, extra, q);
  else if (responseMessage.parts.length) await upsertMessage(conversationId, responseMessage, i.parentId, extra, q);
  if (responseMessage.parts.length || isContinuation) await setCurrentLeaf(conversationId, responseMessage.id, { onlyFrom: opts.leafOnlyFrom }, q);
  await q.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, conversationId));
}

/** What follows a saved turn (outside any transaction): the tool-call audit log and memory extraction. */
export async function afterAssistantSaved(i: PersistTurnInput): Promise<void> {
  await logToolCalls(i, i.responseMessage);
  if (!i.background && !hasPendingAsyncTasks(i.responseMessage)) void scheduleMemoryExtraction(i.conversationId);
}

/**
 * Stores a finished (or paused) assistant turn: saveAssistantMessage, then afterAssistantSaved. The default for
 * runTurn callers that don't pass their own `persist` (the run executor saves under its lease instead).
 */
export async function persistAssistantTurn(i: PersistTurnInput) {
  await saveAssistantMessage(i);
  await afterAssistantSaved(i);
}
