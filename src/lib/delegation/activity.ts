import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { delegatedTasks, runEvents } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { authorizeTaskRead, ownedTask } from "./view";
import { summarizeActivity, type ActivityEvent } from "./activity-summary";

/** Exact assignment, rather than the latest turn in a reused task conversation. */
export async function taskActivity(p: Principal, taskId: string) {
  const [assignment] = await db.select({ conversationId: delegatedTasks.childConversationId, runId: delegatedTasks.childRunId })
    .from(delegatedTasks).where(and(eq(delegatedTasks.id, taskId), eq(delegatedTasks.userId, p.user.id)));
  if (!assignment?.conversationId || !assignment.runId) throw new HttpError(404, "Task not found.");
  await authorizeTaskRead(p, assignment.conversationId, assignment.runId);
  const { task, run } = await ownedTask(p, assignment.conversationId, db, assignment.runId);
  if (task.id !== taskId) throw new HttpError(404, "Task not found.");
  const events = await db.select({
    type: sql<string>`${runEvents.chunk}->>'type'`,
    toolCallId: sql<string>`${runEvents.chunk}->>'toolCallId'`,
    toolName: sql<string>`${runEvents.chunk}->>'toolName'`,
    approvalId: sql<string>`${runEvents.chunk}->>'approvalId'`,
    approved: sql<boolean>`(${runEvents.chunk}->>'approved')::boolean`,
    isAutomatic: sql<boolean>`(${runEvents.chunk}->>'isAutomatic')::boolean`,
    preliminary: sql<boolean>`(${runEvents.chunk}->>'preliminary')::boolean`,
    failed: sql<boolean>`(${runEvents.chunk}->'output'->>'status') in ('error', 'cancelled', 'interrupted')`,
  }).from(runEvents).where(and(eq(runEvents.runId, run.id), eq(runEvents.transient, false),
    sql`((${runEvents.chunk}->>'type' like 'tool-%' and ${runEvents.chunk}->>'type' <> 'tool-input-delta') or (${runEvents.chunk}->>'type' in ('start-step', 'reset-step')))`))
    .orderBy(asc(runEvents.seq));
  // Recheck live permissions after reading, just as the task stream does while tailing.
  await authorizeTaskRead(p, assignment.conversationId, assignment.runId);
  return summarizeActivity(task.id, run.status, events as ActivityEvent[]);
}
