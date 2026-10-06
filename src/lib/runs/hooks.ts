import { isToolUIPart } from "ai";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bots, delegatedTasks, routineRuns, routines } from "@/db/schema";
import { afterRoutineTurn } from "@/lib/agent/routine-runner";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { AgentRun, AgentRunStatus } from "./types";

/** What a routine run records for a run that ended without success (the run's own error text when it has one). */
export function routineErrorFor(status: AgentRunStatus, error?: string | null): string | undefined {
  if (status !== "failed" && status !== "cancelled" && status !== "interrupted") return undefined;
  return error || (status === "cancelled" ? "Stopped." : "Interrupted.");
}

/**
 * The approval Inbox text for a pause on a Hermes approval: Hermes denies it by itself once its time limit passes
 * (the approval card's input carries `expires_in_s`). Undefined for other approvals (the default text applies).
 */
export function approvalBodyFor(routineName: string, message: PortalUIMessage | null): string | undefined {
  const pending = (message?.parts ?? []).filter((p) => isToolUIPart(p) && p.state === "approval-requested");
  const secs = pending
    .map((p) => (p as { input?: { expires_in_s?: unknown } }).input?.expires_in_s)
    .filter((v): v is number => typeof v === "number" && v > 0);
  if (!secs.length) return undefined;
  const minutes = Math.max(1, Math.round(Math.min(...secs) / 60));
  return `Routine "${routineName}" paused before a sensitive action. Open the conversation to allow or deny it. Hermes denies it if nobody answers within ${minutes} min.`;
}

/**
 * After a run transition applied (exactly once per transition, after commit): routine bookkeeping via
 * afterRoutineTurn (waiting → awaiting_approval + approval Inbox item; succeeded → result + optional email;
 * failed/cancelled/interrupted → failed + error item), plus learning reviews for completed native caller turns.
 */
export async function afterRunTransition(run: AgentRun, status: AgentRunStatus, message: PortalUIMessage | null, error?: string | null): Promise<void> {
  if (status === "succeeded" && run.botId && !run.background && run.executionMode === "worker") {
    const { scheduleLearningReview } = await import("@/lib/agent/learning/review");
    await scheduleLearningReview(run.id).catch(err => console.error("[learning] review scheduling failed", err));
  }
  if (run.executionMode === "async_delegate") {
    const { reconcileAsyncParent, reconcileAsyncTasks } = await import("@/lib/delegation/async");
    const [task] = await db.select({ parentRunId: delegatedTasks.parentRunId }).from(delegatedTasks).where(eq(delegatedTasks.childRunId, run.id));
    if (task?.parentRunId) await reconcileAsyncParent(task.parentRunId);
    await reconcileAsyncTasks();
  }
  if (!run.routineRunId) return;
  if (status === "queued" || status === "running" || status === "waiting_tasks") return;
  const [rr] = await db.select({ id: routineRuns.id, routineId: routineRuns.routineId }).from(routineRuns).where(eq(routineRuns.id, run.routineRunId));
  if (!rr) return;
  const [routine] = await db
    .select({ name: routines.name, notifyEmail: routines.notifyEmail, botId: routines.botId })
    .from(routines)
    .where(eq(routines.id, rr.routineId));
  if (!routine) return;
  const botId = run.botId ?? routine.botId;
  const [bot] = botId ? await db.select({ name: bots.name }).from(bots).where(eq(bots.id, botId)) : [];
  const waiting = status === "waiting";
  await afterRoutineTurn({
    runId: rr.id,
    routineName: routine.name,
    botName: bot?.name ?? "Your bot",
    userId: run.userId,
    conversationId: run.conversationId,
    responseMessage: message ?? { id: run.messageId, role: "assistant", parts: [] },
    pendingApproval: waiting,
    error: routineErrorFor(status, error),
    notifyEmail: routine.notifyEmail,
    body: waiting ? approvalBodyFor(routine.name, message) : undefined,
  });
}
