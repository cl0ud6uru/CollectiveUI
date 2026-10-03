/**
 * Recovery for runs whose worker went away, run by every worker every runConfig().sweepMs:
 * 1. running segments with a stale heartbeat (the worker died or lost the database) → interrupted: the message is
 *    rebuilt from the event log, closed (no spinner left) and saved, with an error chunk and the segment-end;
 * 2. queued runs nobody claimed for runConfig().requeueAfterMs (a lost job) → enqueued again (claiming is idempotent),
 *    or cancelled when a stop is pending;
 * 3. the events of runs that finished more than runConfig().eventsTtlMs ago are deleted.
 * Several workers can sweep at once: every step locks rows with SKIP LOCKED and every transition is conditional.
 */
import type { UIMessageChunk } from "ai";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { agentRuns, inboxItems, messages, routineRuns, routines, runEvents } from "@/db/schema";
import { logToolCalls } from "@/lib/agent/persist";
import { rowToUIMessage, setCurrentLeaf, upsertMessage, type PortalUIMessage } from "@/lib/chat/store";
import type { ProviderKind } from "@/lib/llm";
import { enqueue, enqueueRun, QUEUES } from "@/lib/jobs";
import { afterRunTransition } from "./hooks";
import { readEvents, type StoredEvent } from "./log";
import { stopProviderRun } from "./provider-stop";
import { closeOpenParts, openStreamIdsOf, rebuildMessage, replayFilter } from "./replay";
import { finalizeRunTx, type FinalizeFrom } from "./state";
import { abortQueuedRun } from "./store";
import { FINAL_STATUSES, runConfig, type AgentRun, type FinalStatus } from "./types";

export const WORKER_LOST = "The worker running this reply stopped. Try again.";

const STALE_BATCH = 20;
const REQUEUE_BATCH = 100;
const READ_BATCH = 1000;
const PURGE_BATCH = 5000;
/** Purge statements per sweep at most (the rest waits for the next sweep). */
const PURGE_ROUNDS = 20;

const olderThan = (col: typeof agentRuns.updatedAt | typeof agentRuns.heartbeatAt | typeof agentRuns.finishedAt, ms: number) =>
  lt(col, sql`now() - ${Math.round(ms)}::int * interval '1 millisecond'`);

async function allEvents(tx: Tx, runId: string): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for (let after = 0; ; ) {
    const batch = await readEvents(runId, after, READ_BATCH, tx);
    out.push(...batch);
    if (batch.length < READ_BATCH) return out;
    after = batch.at(-1)!.seq;
  }
}

/**
 * The message a run has streamed so far, from its event log: the whole log through replayFilter (the log holds the
 * whole message, including earlier segments and their closings), or, for a legacy run (nothing logged before its
 * first continuation), the stored message plus the current segment's chunks. Also returns the current segment's
 * chunks (for the text streams it left open).
 */
async function rebuildFromLog(tx: Tx, run: AgentRun): Promise<{ message: PortalUIMessage; segmentChunks: UIMessageChunk[] }> {
  const events = await allEvents(tx, run.id);
  const segmentChunks = events.filter((e) => e.seq > run.boundarySeq && e.kind === "chunk" && e.chunk && !e.transient).map((e) => e.chunk!);
  if (run.legacy) {
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, run.messageId), eq(messages.conversationId, run.conversationId)));
    const stored = row?.role === "assistant" ? rowToUIMessage(row) : null;
    return { message: await rebuildMessage(stored, segmentChunks, run.messageId), segmentChunks };
  }
  const filter = replayFilter(run.segment);
  const chunks: UIMessageChunk[] = [];
  for (const e of events) {
    const out = filter(e);
    if (out === "end") break;
    if (out) chunks.push(out);
  }
  return { message: await rebuildMessage(null, chunks, run.messageId), segmentChunks };
}

/**
 * Ends a running segment from what its event log holds (its executor is gone, or never saved): rebuilds the
 * message, closes what's open, saves it (when it has any parts; the leaf moves only while it's still the question or
 * this reply) and finishes the run with an error chunk and the segment-end, all in `tx`. The caller holds the run's
 * row lock. Null when the transition doesn't apply.
 */
export async function finishFromLogTx(
  tx: Tx,
  run: AgentRun,
  from: FinalizeFrom,
  to: { status: FinalStatus; error: string },
): Promise<{ run: AgentRun; message: PortalUIMessage | null } | null> {
  const { message: rebuilt, segmentChunks } = await rebuildFromLog(tx, run);
  const closed = closeOpenParts(rebuilt, to.status, {
    openIds: openStreamIdsOf(segmentChunks),
    endNote: to.error,
    // The segment was running: an approved tool without a result may have run.
    stoppedText: "Stopped while it was running: it may have run.",
  });
  let message: PortalUIMessage | null = null;
  if (closed.message.parts.length) {
    message = closed.message;
    const meta = message.metadata ?? {};
    const extra = {
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.providerKind ? { providerKind: meta.providerKind as ProviderKind } : {}),
      appId: meta.appId ?? run.appId,
      ...(run.billingSource ? { billingSource: run.billingSource } : {}),
    };
    await upsertMessage(run.conversationId, message, run.parentMessageId, extra, tx);
    await setCurrentLeaf(run.conversationId, run.messageId, { onlyFrom: [run.parentMessageId, run.messageId].filter((x): x is string => !!x) }, tx);
  }
  const finished = await finalizeRunTx(tx, run.id, from, {
    status: to.status,
    error: to.error,
    closing: [...closed.chunks, { type: "error", errorText: to.error }],
  });
  // Under the row lock this can't happen; roll the message back rather than save it for a run that isn't ending.
  if (!finished) throw new Error(`run ${run.id} changed while locked`);
  return { run: finished, message };
}

/** After a run ended from its log (outside the transaction): routine hooks and the tool-call audit log. */
export async function afterFinishedFromLog(done: { run: AgentRun; message: PortalUIMessage | null }, error: string) {
  const { run, message } = done;
  if (message) await logToolCalls({ runId: run.id, conversationId: run.conversationId, userId: run.userId, botId: run.botId }, message).catch(() => {});
  await afterRunTransition(run, run.status, message, error).catch((err) => console.error(`[runs] hooks after run ${run.id} (${run.status}) failed`, err));
}

async function interruptStale(): Promise<number> {
  const { staleMs } = runConfig();
  const candidates = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.status, "running"), olderThan(agentRuns.heartbeatAt, staleMs)))
    .limit(STALE_BATCH);
  let n = 0;
  for (const { id } of candidates) {
    try {
      const done = await db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.id, id), eq(agentRuns.status, "running"), olderThan(agentRuns.heartbeatAt, staleMs)))
          .for("update", { skipLocked: true });
        if (!run) return null;
        const finished = await finishFromLogTx(tx, run, { status: ["running"], staleMs }, { status: "interrupted", error: WORKER_LOST });
        return finished && { ...finished, before: run };
      });
      if (!done) continue;
      n++;
      console.warn(`[runs] run ${id} (segment ${done.run.segment}) interrupted: its worker stopped heartbeating`);
      // Its provider run (Hermes) would otherwise carry on unobserved; finalizing cleared the state, so use the row before.
      await stopProviderRun(done.before);
      await afterFinishedFromLog(done, WORKER_LOST);
    } catch (err) {
      console.error(`[runs] couldn't interrupt stale run ${id}`, err);
    }
  }
  return n;
}

async function requeueLost(afterMs: number): Promise<{ requeued: number; cancelled: number }> {
  // Touching updated_at claims the rows for this sweep (the next one waits requeueAfterMs again).
  const { rows } = await db.execute<{ id: string; segment: number; background: boolean; cancel_requested_at: Date | null }>(sql`
    update ${agentRuns} set updated_at = now()
    where ${agentRuns.id} in (
      select ${agentRuns.id} from ${agentRuns}
      where ${agentRuns.executionMode} in ('worker', 'async_delegate') and ${agentRuns.status} = 'queued' and ${olderThan(agentRuns.updatedAt, afterMs)}
      order by ${agentRuns.updatedAt}
      limit ${REQUEUE_BATCH}
      for update skip locked
    ) and ${agentRuns.status} = 'queued'
    returning ${agentRuns.id} as id, ${agentRuns.segment} as segment, ${agentRuns.background} as background,
      ${agentRuns.cancelRequestedAt} as cancel_requested_at`);
  let requeued = 0;
  let cancelled = 0;
  for (const r of rows) {
    try {
      if (r.cancel_requested_at) {
        // A stop that raced the claim: nothing will run it, end it here.
        if (await abortQueuedRun(r.id, { status: "cancelled" })) cancelled++;
        continue;
      }
      await enqueueRun({ id: r.id, segment: r.segment, background: r.background });
      requeued++;
    } catch (err) {
      console.error(`[runs] couldn't re-enqueue run ${r.id}`, err);
    }
  }
  return { requeued, cancelled };
}

/** Queued routine rows are a durable admission outbox, including rows saved before this recovery existed.
 * Repeated delivery is safe: executeRoutineRun claims queued → running and creates its agent run atomically.
 */
async function requeueRoutineAdmissions(afterMs: number): Promise<void> {
  // Claim a bounded batch and rotate it to the back even when admission fails. Parallel sweepers
  // skip claimed rows; older failures cannot starve newer queued work indefinitely.
  const { rows } = await db.execute<{ id: string }>(sql`
    update ${routineRuns} set last_enqueue_at = now()
    where ${routineRuns.id} in (
      select ${routineRuns.id} from ${routineRuns}
      where ${routineRuns.status} = 'queued'
        and (${routineRuns.lastEnqueueAt} is null or ${routineRuns.lastEnqueueAt} < now() - ${Math.round(afterMs)}::int * interval '1 millisecond')
      order by ${routineRuns.lastEnqueueAt} nulls first, ${routineRuns.createdAt}
      limit ${REQUEUE_BATCH}
      for update skip locked
    ) and ${routineRuns.status} = 'queued'
    returning ${routineRuns.id} as id`);
  for (const run of rows) await enqueue(QUEUES.routineRun, { runId: run.id }, { singletonKey: run.id });
}

/** A routine run's bookkeeping happens after its agent run's transition commits: this long later it must agree. */
const ROUTINE_GRACE_MS = 120_000;
const ROUTINE_BATCH = 20;

/**
 * Routine runs left behind: still `running` or `awaiting_approval` with no open agent run, because their bookkeeping
 * hook was lost (the worker died between the run's transition and the hook) or their conversation was deleted (which
 * deletes the agent run). Brought in line with the agent run's outcome, or failed. Approvals pending since before
 * durable runs (no agent run, conversation still there) are left as they are: they continue on a legacy run.
 */
async function reconcileRoutines(): Promise<number> {
  const { rows } = await db.execute<{ id: string; status: string; conversation_id: string | null }>(sql`
    select rr.id, rr.status, rr.conversation_id from ${routineRuns} rr
    where rr.status in ('running', 'awaiting_approval')
      and rr.created_at < now() - ${ROUTINE_GRACE_MS}::int * interval '1 millisecond'
      and not exists (select 1 from ${agentRuns} ar where ar.routine_run_id = rr.id and ar.status in ('queued', 'running', 'waiting', 'waiting_tasks'))
    limit ${ROUTINE_BATCH}`);
  let n = 0;
  for (const rr of rows) {
    try {
      const [last] = await db.select().from(agentRuns).where(eq(agentRuns.routineRunId, rr.id)).orderBy(desc(agentRuns.createdAt)).limit(1);
      if (last) {
        // Its hook never ran: apply it now (the agent run is final, so this is its outcome).
        await afterRunTransition(last, last.status, null, last.error);
        n++;
      } else if (rr.status === "running" || !rr.conversation_id) {
        const [owner] = await db
          .select({ userId: routines.ownerId, name: routines.name })
          .from(routineRuns)
          .innerJoin(routines, eq(routines.id, routineRuns.routineId))
          .where(eq(routineRuns.id, rr.id));
        const error = rr.conversation_id ? "The run was lost. Run the routine again." : "Its conversation was deleted.";
        const [failed] = await db
          .update(routineRuns)
          .set({ status: "failed", error, finishedAt: sql`now()` })
          .where(and(eq(routineRuns.id, rr.id), inArray(routineRuns.status, ["running", "awaiting_approval"])))
          .returning({ id: routineRuns.id });
        if (failed && owner)
          await db.insert(inboxItems).values({
            userId: owner.userId,
            kind: "routine_error",
            title: `${owner.name} failed`,
            body: error,
            conversationId: rr.conversation_id,
            routineRunId: rr.id,
          });
        if (failed) n++;
      }
    } catch (err) {
      console.error(`[runs] couldn't reconcile routine run ${rr.id}`, err);
    }
  }
  return n;
}

async function purgeEvents(): Promise<number> {
  const final = sql.join(
    FINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  let purged = 0;
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const res = await db.execute(sql`
      delete from ${runEvents} where ctid in (
        select e.ctid from ${runEvents} e
        join ${agentRuns} r on r.id = e.run_id
        where r.status in (${final}) and r.finished_at < now() - ${Math.round(runConfig().eventsTtlMs)}::bigint * interval '1 millisecond'
        limit ${PURGE_BATCH}
      )`);
    const n = res.rowCount ?? 0;
    purged += n;
    if (n < PURGE_BATCH) break;
  }
  return purged;
}

export type SweepResult = { interrupted: number; requeued: number; cancelled: number; routines: number; purged: number };

/**
 * One sweep (see the module comment); each step runs even when an earlier one failed. `startup`: the worker's first
 * sweep re-enqueues every queued run whatever its age (a job a previous worker took while shutting down is gone;
 * enqueueing again is harmless, claiming is idempotent).
 */
export async function sweepRuns(opts: { startup?: boolean } = {}): Promise<SweepResult> {
  const out: SweepResult = { interrupted: 0, requeued: 0, cancelled: 0, routines: 0, purged: 0 };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[runs] sweeper: ${name} failed`, err);
    }
  };
  await step("interrupting stale runs", async () => {
    out.interrupted = await interruptStale();
  });
  await step("re-enqueueing lost runs", async () => {
    Object.assign(out, await requeueLost(opts.startup ? 0 : runConfig().requeueAfterMs));
  });
  await step("re-enqueueing routine admissions", () => requeueRoutineAdmissions(opts.startup ? 0 : runConfig().requeueAfterMs));
  await step("reconciling routine runs", async () => {
    out.routines = await reconcileRoutines();
  });
  await step("reconciling native asynchronous tasks", async () => {
    const { reconcileAsyncTasks } = await import("@/lib/delegation/async");
    await reconcileAsyncTasks();
  });
  await step("deleting old events", async () => {
    out.purged = await purgeEvents();
  });
  return out;
}
