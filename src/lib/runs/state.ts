/**
 * Every agent_runs state transition, as one conditional statement each (see the table in
 * docs/architecture/backend-harness.md → "P6 as built"). Callers never update agent_runs.status themselves: a
 * transition either applies (returns the row) or doesn't (returns null) and the caller backs off. All times are the
 * database's now(), so app clocks don't matter.
 *
 * Actors: the web (create, requeue, stop), the executor holding a run (claim, heartbeat, pause, finish), and the
 * sweeper (interrupt stale runs, re-enqueue lost jobs).
 */
import type { UIMessageChunk } from "ai";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { agentRuns, delegatedTasks, hermesRunContexts } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import { appendEventsTx, notifyRun } from "./log";
import { HOLDING_STATUSES, type AgentRun, type AgentRunStatus, type EventDraft, type FinalStatus, type ResumeState } from "./types";

/** A second run for a conversation that already has one queued or running. */
export class RunBusyError extends HttpError {
  constructor(message = "A reply is still in progress in this chat.") {
    super(409, message);
  }
}

const isUniqueViolation = (err: unknown, constraint: string) => {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const pg = e as { code?: string; constraint?: string };
  return pg?.code === "23505" && pg.constraint === constraint;
};

/** Create (→ queued). Maps the one-active-run-per-conversation index to RunBusyError. */
export async function insertRunTx(tx: Tx, values: typeof agentRuns.$inferInsert): Promise<AgentRun> {
  try {
    // A savepoint, so a unique violation doesn't abort the caller's transaction before it can map the error.
    return await tx.transaction(async (sp) => {
      const [row] = await sp.insert(agentRuns).values(values).returning();
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err, "agent_runs_active_conversation_idx")) throw new RunBusyError();
    if (isUniqueViolation(err, "agent_runs_message_idx")) throw new HttpError(409, "That reply already exists.");
    throw err;
  }
}

/** Claim (queued → running) for worker `holder`. Null when it isn't claimable (already taken, cancelled, finished). */
export async function claimRun(runId: string, holder: string): Promise<AgentRun | null> {
  const existing = await getRun(runId);
  if (existing?.executionMode === "async_delegate") {
    const { claimAsyncRun } = await import("@/lib/delegation/async");
    return claimAsyncRun(runId, holder);
  }
  const [row] = await db
    .update(agentRuns)
    .set({
      status: "running",
      holder,
      heartbeatAt: sql`now()`,
      startedAt: sql`coalesce(${agentRuns.startedAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued"), eq(agentRuns.executionMode, "worker"), isNull(agentRuns.cancelRequestedAt)))
    .returning();
  return row ?? null;
}

/**
 * Heartbeat for the running segments a worker holds. Returns the ids still held (with any cancel request); an id
 * missing from the result means the lease is lost (the caller aborts that run without writing).
 */
export async function heartbeatRuns(holder: string, runIds: string[]): Promise<{ id: string; cancelRequestedAt: Date | null }[]> {
  if (!runIds.length) return [];
  return db
    .update(agentRuns)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(agentRuns.holder, holder), inArray(agentRuns.id, runIds), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id, cancelRequestedAt: agentRuns.cancelRequestedAt });
}

/**
 * Runs `fn` while holding the run's row lock, only if `holder` still holds it and it is running (fenced writes, e.g.
 * saving the message). Returns null (without calling fn) when the lease is lost.
 */
export async function withRunFence<T>(runId: string, holder: string, fn: (tx: Tx) => Promise<T>): Promise<{ value: T } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.holder, holder), eq(agentRuns.status, "running")))
      .for("update");
    if (!row) return null;
    return { value: await fn(tx) };
  });
}

/** Records the provider run behind a running segment as soon as it starts (fenced), so it can be stopped later. */
export async function noteRunResumeState(runId: string, holder: string, resumeState: ResumeState) {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(agentRuns).set({ resumeState: resumeState as Record<string, unknown> })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.holder, holder), eq(agentRuns.status, "running"))).returning({ id: agentRuns.id });
    if (!row) throw new Error("The provider run could not be recorded: lease lost.");
    if (resumeState.hermes) await tx.update(hermesRunContexts).set({ upstreamRunId: resumeState.hermes.runId }).where(eq(hermesRunContexts.runId, runId));
  });
}

/** Records who pays for the run (fenced). */
export async function setRunBilling(runId: string, holder: string, billingSource: AgentRun["billingSource"]) {
  await db
    .update(agentRuns)
    .set({ billingSource })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.holder, holder), eq(agentRuns.status, "running")));
}

/**
 * Pause (running → waiting) after the segment's message was saved with pending approvals. Stores the provider's
 * resume state, releases the lease and writes `closing` chunks (see closeOpenParts) and the segment-end marker (tails
 * close there, so the browser can send the answer). Null when the lease was lost.
 */
export async function pauseRun(
  run: Pick<AgentRun, "id" | "segment">,
  holder: string,
  resumeState: ResumeState | null,
  closing: UIMessageChunk[] = [],
): Promise<AgentRun | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentRuns)
      .set({
        status: "waiting",
        holder: null,
        resumeState: resumeState as Record<string, unknown> | null,
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.holder, holder), eq(agentRuns.status, "running"), inArray(agentRuns.executionMode, ["worker", "async_delegate"])))
      .returning();
    if (!row) return null;
    const drafts: EventDraft[] = [...closing.map((chunk) => ({ kind: "chunk" as const, chunk })), { kind: "segment-end" }];
    const appended = await appendEventsTx(tx, run.id, run.segment, drafts);
    await notifyRun(tx, { r: run.id, k: "t" });
    return { ...row, lastSeq: appended?.lastSeq ?? row.lastSeq };
  });
}

export type FinalizeFrom = {
  /** The statuses the run must be in for the transition to apply. */
  status: AgentRunStatus[];
  /** Fence on the executing worker (executor finishing its own segment). */
  holder?: string;
  /** Only runs whose heartbeat is older than this many ms (sweeper). */
  staleMs?: number;
  /** Only runs with a cancel request (reconciling a stop). */
  cancelRequested?: boolean;
};

/**
 * Finish (→ succeeded | failed | cancelled | interrupted) inside `tx`: appends `closing` chunks (e.g. closing
 * unfinished tool parts, an error) and the segment-end marker, clears lease and resume state. The caller saves the
 * matching message in the same transaction. Null when the transition doesn't apply (someone else finished it).
 */
export async function finalizeRunTx(
  tx: Tx,
  runId: string,
  from: FinalizeFrom,
  to: { status: FinalStatus; error?: string | null; closing?: UIMessageChunk[] },
): Promise<AgentRun | null> {
  const conds = [eq(agentRuns.id, runId), inArray(agentRuns.status, from.status)];
  if (from.holder) conds.push(eq(agentRuns.holder, from.holder));
  if (from.staleMs) conds.push(lt(agentRuns.heartbeatAt, sql`now() - ${Math.round(from.staleMs)}::int * interval '1 millisecond'`));
  if (from.cancelRequested) conds.push(sql`${agentRuns.cancelRequestedAt} is not null`);
  const [row] = await tx
    .update(agentRuns)
    .set({
      status: sql`case when ${agentRuns.executionMode} = 'async_delegate' and ${agentRuns.cancelRequestedAt} is not null then 'cancelled' else ${to.status} end`,
      // A paused segment already has an end marker. Put cancellation/failure chunks in a new closing segment,
      // otherwise replay stops at the old pause and leaves an approval card answerable in the browser.
      segment: sql`case when ${agentRuns.status} in ('waiting', 'waiting_tasks') then ${agentRuns.segment} + 1 else ${agentRuns.segment} end`,
      boundarySeq: sql`case when ${agentRuns.status} in ('waiting', 'waiting_tasks') then ${agentRuns.lastSeq} else ${agentRuns.boundarySeq} end`,
      error: to.error ?? null,
      finishedAt: sql`now()`,
      holder: null,
      resumeState: null,
      updatedAt: sql`now()`,
    })
    .where(and(...conds))
    .returning();
  if (!row) return null;
  await cancelDescendantsTx(tx, runId);
  const drafts: EventDraft[] = [...(to.closing ?? []).map((chunk) => ({ kind: "chunk" as const, chunk })), { kind: "segment-end" }];
  const appended = await appendEventsTx(tx, runId, row.segment, drafts);
  await notifyRun(tx, { r: runId, k: "t" });
  return { ...row, lastSeq: appended?.lastSeq ?? row.lastSeq };
}

/**
 * Requeue (waiting → queued) for the next segment, inside the transaction that claimed the approval decisions (a
 * failure rolls the decisions back). Appends `chunks` (the decisions as `tool-approval-response`, so a replay
 * rebuilds them) and moves the segment boundary past them. Null when the run isn't waiting (running → 409 upstream).
 */
export async function requeueRunTx(tx: Tx, runId: string, userId: string, chunks: UIMessageChunk[]): Promise<AgentRun | null> {
  const [cur] = await tx
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    .for("update");
  if (!cur || !["worker", "async_delegate"].includes(cur.executionMode) || cur.status !== "waiting" || cur.cancelRequestedAt) return null;
  const appended = chunks.length
    ? await appendEventsTx(
        tx,
        runId,
        cur.segment,
        chunks.map((chunk) => ({ kind: "chunk" as const, chunk })),
      )
    : null;
  const lastSeq = appended?.lastSeq ?? cur.lastSeq;
  try {
    const [row] = await tx.transaction(async (sp) =>
      sp
        .update(agentRuns)
        .set({
          status: "queued",
          segment: sql`${agentRuns.segment} + 1`,
          boundarySeq: lastSeq,
          // This transition is called only after committed human approval decisions.
          resumeState: cur.resumeState && (cur.resumeState as ResumeState).native
            ? { ...cur.resumeState, native: { ...(cur.resumeState as ResumeState).native!, background: false } }
            : cur.resumeState,
          cancelRequestedAt: null,
          error: null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "waiting")))
        .returning(),
    );
    if (!row) return null;
    await notifyRun(tx, { r: runId, k: "q" });
    return row;
  } catch (err) {
    // Another run of this conversation is queued or running.
    if (isUniqueViolation(err, "agent_runs_active_conversation_idx")) throw new RunBusyError();
    throw err;
  }
}

/** Stop request for an open run: sets cancel_requested_at (once) and signals `c`. Returns the run's status then. */
export async function requestCancelTx(tx: Tx, runId: string): Promise<AgentRunStatus | null> {
  const [row] = await tx
    .update(agentRuns)
    .set({ cancelRequestedAt: sql`coalesce(${agentRuns.cancelRequestedAt}, now())`, updatedAt: sql`now()` })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ["queued", "running", "waiting", "waiting_tasks"])))
    .returning({ status: agentRuns.status });
  if (!row) return null;
  await cancelDescendantsTx(tx, runId);
  await notifyRun(tx, { r: runId, k: "c" });
  return row.status;
}

/** The conversation's queued or running run, if any. */
export async function activeRunOf(conversationId: string, q: DbOrTx = db): Promise<AgentRun | null> {
  const [row] = await q
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.conversationId, conversationId), inArray(agentRuns.status, [...HOLDING_STATUSES])))
    .orderBy(sql`case when ${agentRuns.status} in ('running', 'waiting_tasks') then 0 else 1 end`,
      sql`(select turn from delegated_tasks where child_run_id = ${agentRuns.id})`, asc(agentRuns.createdAt), asc(agentRuns.id)).limit(1);
  return row ?? null;
}

export async function getRun(runId: string, q: DbOrTx = db): Promise<AgentRun | null> {
  const [row] = await q.select().from(agentRuns).where(eq(agentRuns.id, runId));
  return row ?? null;
}

export async function runOfMessage(messageId: string, q: DbOrTx = db): Promise<AgentRun | null> {
  const [row] = await q.select().from(agentRuns).where(eq(agentRuns.messageId, messageId));
  return row ?? null;
}

/** Stop descendants without scheduling them. The ancestry is bounded at admission. */
export async function cancelDescendantsTx(tx: Tx, parentRunId: string): Promise<void> {
  const children = await tx.select({ runId: delegatedTasks.childRunId }).from(delegatedTasks)
    .where(eq(delegatedTasks.parentRunId, parentRunId));
  for (const child of children) if (child.runId) await requestCancelTx(tx, child.runId);
}
