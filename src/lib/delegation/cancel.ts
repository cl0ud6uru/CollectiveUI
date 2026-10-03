import { and, eq, or } from "drizzle-orm";
import type { Tx } from "@/db";
import { delegatedTasks } from "@/db/schema";
import { requestCancelTx } from "@/lib/runs/state";

/** Caller holds the admission lock; task tombstones survive conversation removal. */
export async function cancelTasksForConversationTx(tx: Tx, userId: string, conversationId?: string) {
  const rows = await tx.select({ runId: delegatedTasks.childRunId }).from(delegatedTasks).where(and(eq(delegatedTasks.userId, userId),
    conversationId ? or(eq(delegatedTasks.originConversationId, conversationId), eq(delegatedTasks.childConversationId, conversationId)) : undefined));
  for (const row of rows) if (row.runId) await requestCancelTx(tx, row.runId);
}
