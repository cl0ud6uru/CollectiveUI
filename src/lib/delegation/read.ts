import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, delegatedTasks, inboxItems } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { isFinal } from "@/lib/runs/types";
import { ownedTask } from "./view";
import { lockUserRuns } from "@/lib/runs/lock";

/** Acknowledges exactly the terminal snapshot rendered by the child, never an earlier visit. */
export async function markTaskRead(p: Principal, conversationId: string, observed: { runId: string; status: string; lastSeq: number }) {
  return db.transaction(async tx => {
    // A read of the previous completion cannot acknowledge a concurrently admitted follow-up.
    await lockUserRuns(tx, p.user.id);
    const { task, run } = await ownedTask(p, conversationId, tx);
    if (!isFinal(run.status) || observed.runId !== run.id || observed.status !== run.status || observed.lastSeq !== run.lastSeq)
      throw new HttpError(409, "The task has changed. Load its saved result before marking it read.");
    // Reuse the inbox marker. Creating it here also covers a read before the async notifier runs;
    // its idempotent insert cannot reset this acknowledgement. Sync tasks use the same marker.
    const seen = await tx.select({ task: delegatedTasks, run: agentRuns }).from(delegatedTasks)
      .innerJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
      .where(and(eq(delegatedTasks.userId, p.user.id), eq(delegatedTasks.childConversationId, conversationId), lte(delegatedTasks.turn, task.turn), inArray(agentRuns.status, ["succeeded", "failed", "cancelled", "interrupted"])));
    for (const { task: seenTask, run: seenRun } of seen) await tx.insert(inboxItems).values({
      id: `task_${seenTask.id}`, userId: p.user.id, conversationId,
      kind: seenRun.status === "succeeded" ? "task_result" : "task_error",
      title: `${seenTask.receiverName}: ${seenRun.status === "succeeded" ? "task completed" : seenRun.status === "cancelled" ? "task stopped" : "task ended"}`,
      body: "Open the task to review its saved result. Interrupted tasks are never restarted automatically.",
      readAt: sql`now()`,
    }).onConflictDoUpdate({ target: inboxItems.id, set: { readAt: sql`coalesce(${inboxItems.readAt}, now())` },
      setWhere: and(eq(inboxItems.userId, p.user.id), eq(inboxItems.conversationId, conversationId)) });
  });
}
