import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { routineRuns, routines } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import { enqueue, QUEUES } from "@/lib/jobs";

export const MAX_ACTIVE_ROUTINE_RUNS_PER_USER = 3;
const active = ["queued", "running"] as const;

/** Always take this before a routine row lock. Counts and inserts share the same transaction/client. */
export async function lockRoutineAdmission(tx: Tx, ownerId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('routine-admission:' || ${ownerId}, 0))`);
}

/** Caller holds the owner admission lock and has claimed/locked the current routine. */
export async function insertRoutineRunTx(tx: Tx, routine: { id: string; ownerId: string }, trigger: "manual" | "webhook" | "schedule", payload?: unknown) {
  const owned = await tx.select({ id: routineRuns.id }).from(routineRuns)
    .innerJoin(routines, eq(routineRuns.routineId, routines.id))
    .where(and(eq(routines.ownerId, routine.ownerId), inArray(routineRuns.status, active))).limit(MAX_ACTIVE_ROUTINE_RUNS_PER_USER);
  if (owned.length >= MAX_ACTIVE_ROUTINE_RUNS_PER_USER) return null;
  if (trigger === "schedule") {
    const [pending] = await tx.select({ id: routineRuns.id }).from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), inArray(routineRuns.status, active))).limit(1);
    if (pending) return null;
  }
  const [run] = await tx.insert(routineRuns).values({ routineId: routine.id, trigger, payload, lastEnqueueAt: new Date() }).returning();
  return run;
}

/** Manual/webhook admission. A recorded row remains accepted if pg-boss is unavailable; the sweeper retries it. */
export async function queueRoutineRun(input: { routineId: string; ownerId: string; trigger: "manual" | "webhook"; payload?: unknown; webhookSecret?: string | null }) {
  const accepted = await db.transaction(async tx => {
    await lockRoutineAdmission(tx, input.ownerId);
    const [routine] = await tx.select().from(routines)
      .where(and(eq(routines.id, input.routineId), eq(routines.ownerId, input.ownerId))).for("update");
    if (!routine) throw new HttpError(404, "Routine not found");
    // Authentication happened before admission; a pause, trigger change or secret
    // rotation while waiting for the owner lock must also take effect here.
    if (input.trigger === "webhook" && (!routine.enabled || routine.triggerType !== "webhook" || routine.webhookSecret !== input.webhookSecret))
      throw new HttpError(409, "Routine webhook is paused or changed. Retry with its current settings.");
    const run = await insertRoutineRunTx(tx, routine, input.trigger, input.payload);
    if (!run) throw new HttpError(429, `You already have ${MAX_ACTIVE_ROUTINE_RUNS_PER_USER} queued or running routine runs. Wait for one to finish.`);
    return { run, botId: routine.botId };
  });
  await enqueue(QUEUES.routineRun, { runId: accepted.run.id }, { singletonKey: accepted.run.id });
  return accepted;
}
