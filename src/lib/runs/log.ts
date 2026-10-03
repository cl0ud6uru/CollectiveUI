/**
 * The run event log's database primitives: append (optionally fenced on the executing worker), read, and NOTIFY.
 * Every append reserves its seq range by bumping agent_runs.last_seq in the same transaction, so a run has one
 * contiguous, gap-free sequence whoever writes (worker, web on continuation, sweeper).
 */
import type { UIMessageChunk } from "ai";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { agentRuns, runEvents } from "@/db/schema";
import { jsonbSafe } from "@/lib/jsonb";
import { RUN_CHANNEL, type AgentRun, type AgentRunStatus, type EventDraft, type RunSignal } from "./types";
import { receiveDelegationEvents } from "@/lib/delegation/receipts";

/** Queues a NOTIFY on RUN_CHANNEL; inside a transaction it is delivered on commit. */
export async function notifyRun(q: DbOrTx, sig: RunSignal) {
  await q.execute(sql`select pg_notify(${RUN_CHANNEL}, ${JSON.stringify(sig)})`);
}

export type AppendResult = { lastSeq: number; cancelRequestedAt: Date | null };

/**
 * Appends events to a run inside `tx` and queues an `e` signal.
 *
 * With `holder`, the append is fenced: it only happens while that worker still holds the run and the run is running
 * (and it refreshes the heartbeat). Returns null when the fence fails: the run was taken over (sweeper), cancelled
 * while queued, deleted with its conversation, or finished — the caller must stop writing.
 */
export async function appendEventsTx(
  tx: Tx,
  runId: string,
  segment: number,
  drafts: EventDraft[],
  opts: { holder?: string } = {},
): Promise<AppendResult | null> {
  // Lock first: duplicate result events and their receipts are serialized with finalization/cancellation.
  if (drafts.some(d => d.kind === "chunk" && d.chunk.type === "tool-output-available" && !d.chunk.preliminary && d.chunk.output && typeof d.chunk.output === "object" && "taskId" in d.chunk.output)) {
    const [origin] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for("update");
    if (!origin || (opts.holder && (origin.holder !== opts.holder || origin.status !== "running"))) return null;
    drafts = await receiveDelegationEvents(tx, origin, drafts);
  }
  const n = drafts.length;
  const fence = opts.holder ? and(eq(agentRuns.holder, opts.holder), eq(agentRuns.status, "running")) : undefined;
  const [row] = await tx
    .update(agentRuns)
    .set({
      lastSeq: sql`${agentRuns.lastSeq} + ${n}`,
      updatedAt: sql`now()`,
      ...(opts.holder ? { heartbeatAt: sql`now()` } : {}),
    })
    .where(fence ? and(eq(agentRuns.id, runId), fence) : eq(agentRuns.id, runId))
    .returning({ lastSeq: agentRuns.lastSeq, cancelRequestedAt: agentRuns.cancelRequestedAt });
  if (!row) return null;
  if (n) {
    const first = row.lastSeq - n + 1;
    await tx.insert(runEvents).values(
      drafts.map((d, i) => ({
        runId,
        seq: first + i,
        segment,
        kind: d.kind,
        chunk: d.kind === "chunk" ? (jsonbSafe(d.chunk) as unknown as Record<string, unknown>) : null,
        transient: d.kind === "chunk" ? !!d.transient : false,
      })),
    );
    await notifyRun(tx, { r: runId, k: "e" });
  }
  return row;
}

/** `appendEventsTx` in its own transaction. */
export async function appendEvents(runId: string, segment: number, drafts: EventDraft[], opts: { holder?: string } = {}) {
  return db.transaction((tx) => appendEventsTx(tx, runId, segment, drafts, opts));
}

export type StoredEvent = {
  seq: number;
  segment: number;
  kind: "chunk" | "segment-end";
  chunk: UIMessageChunk | null;
  transient: boolean;
};

/** Events after `afterSeq`, in order. */
export async function readEvents(runId: string, afterSeq: number, limit = 200, q: DbOrTx = db): Promise<StoredEvent[]> {
  const rows = await q
    .select({ seq: runEvents.seq, segment: runEvents.segment, kind: runEvents.kind, chunk: runEvents.chunk, transient: runEvents.transient })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
  return rows.map((r) => ({ ...r, chunk: r.chunk as UIMessageChunk | null }));
}

export type RunState = {
  id: string;
  status: AgentRunStatus;
  segment: number;
  lastSeq: number;
  boundarySeq: number;
  background: boolean;
  executionMode: AgentRun["executionMode"];
  resumeState: AgentRun["resumeState"];
  legacy: boolean;
  holder: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
};

export async function readRunState(runId: string, q: DbOrTx = db): Promise<RunState | null> {
  const [row] = await q
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      segment: agentRuns.segment,
      lastSeq: agentRuns.lastSeq,
      boundarySeq: agentRuns.boundarySeq,
      background: agentRuns.background,
      executionMode: agentRuns.executionMode,
      resumeState: agentRuns.resumeState,
      legacy: agentRuns.legacy,
      holder: agentRuns.holder,
      cancelRequestedAt: agentRuns.cancelRequestedAt,
      createdAt: agentRuns.createdAt,
      updatedAt: agentRuns.updatedAt,
      startedAt: agentRuns.startedAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return row ?? null;
}
