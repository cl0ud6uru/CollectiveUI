import { and, eq, exists, or } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentRuns, conversations, hermesTeamCandidateContexts, hermesTeamLearningHandoffs } from "@/db/schema";
import { HttpError } from "@/lib/http-error";

const RETAINED_HISTORY = "Team execution history must be retained. Archive these conversations instead, or delete other conversations individually.";

/** Expected retention denials must survive production Server Action error redaction. */
export async function conversationDeleteFeedback(action: () => Promise<void>) {
  try {
    await action();
    return { ok: true as const };
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.message === RETAINED_HISTORY)
      return { ok: false as const, error: RETAINED_HISTORY };
    throw error;
  }
}

/** A native context can be recorded after preflight; the FK remains the final retention fence. */
export function rethrowConversationDeleteError(error: unknown): never {
  let cause = error;
  for (let depth = 0; cause && typeof cause === "object" && depth < 5; depth++) {
    const pg = cause as { code?: string; constraint?: string; cause?: unknown };
    if (pg.code === "23503" && ["hermes_team_candidate_contexts_run_id_agent_runs_id_fk", "hermes_team_learning_handoffs_child_run_id_agent_runs_id_fk"].includes(pg.constraint ?? ""))
      throw new HttpError(409, RETAINED_HISTORY);
    cause = pg.cause;
  }
  throw error;
}

/** Native grants and learning receipts retain their run references even after retirement. */
export async function assertConversationsDeletable(userId: string, conversationId?: string, q: DbOrTx = db) {
  const [retained] = await q.select({ id: conversations.id }).from(conversations)
    .innerJoin(agentRuns, eq(agentRuns.conversationId, conversations.id))
    .where(and(eq(conversations.userId, userId), conversationId ? eq(conversations.id, conversationId) : undefined,
      or(
        exists(q.select({ id: hermesTeamCandidateContexts.id }).from(hermesTeamCandidateContexts)
          .where(eq(hermesTeamCandidateContexts.runId, agentRuns.id))),
        exists(q.select({ id: hermesTeamLearningHandoffs.id }).from(hermesTeamLearningHandoffs)
          .where(eq(hermesTeamLearningHandoffs.childRunId, agentRuns.id))),
      ))).limit(1);
  if (retained) throw new HttpError(409, RETAINED_HISTORY);
}
