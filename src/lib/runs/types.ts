/**
 * Durable runs: shared vocabulary. A run is one assistant message executed by the worker (src/lib/runs/execute.ts);
 * its UI message stream is appended to `run_events` and tailed by the web (tail.ts). An approval pauses it (`waiting`);
 * the answer requeues its next segment. See docs/architecture/backend-harness.md → "P6 as built".
 */
import type { UIMessageChunk } from "ai";
import type { AgentRun, AgentRunStatus } from "@/db/schema";
import type { MapperState } from "@/lib/llm/providers/hermes/mapper";
import type { HermesRunContext } from "@/lib/llm/providers/hermes/scope";

export type { AgentRun, AgentRunStatus };

/** Postgres NOTIFY channel for run signals (payloads are ids only, see RunSignal). */
export const RUN_CHANNEL = "portal_runs";

/** Runs that hold the conversation (at most one per conversation, enforced by a partial unique index). */
export const ACTIVE_STATUSES = ["queued", "running"] as const satisfies readonly AgentRunStatus[];
/** Suspended native parents keep their conversation without occupying a worker slot. */
export const HOLDING_STATUSES = ["queued", "running", "waiting_tasks"] as const satisfies readonly AgentRunStatus[];
/** Runs that can still change. */
export const OPEN_STATUSES = ["queued", "running", "waiting", "waiting_tasks"] as const satisfies readonly AgentRunStatus[];
export const FINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const satisfies readonly AgentRunStatus[];
export type FinalStatus = (typeof FINAL_STATUSES)[number];

export const isActive = (s: AgentRunStatus) => (ACTIVE_STATUSES as readonly string[]).includes(s);
export const isFinal = (s: AgentRunStatus): s is FinalStatus => (FINAL_STATUSES as readonly string[]).includes(s);

/**
 * What a NOTIFY on RUN_CHANNEL says: `r` = run id, `k` = kind.
 * - `e`: events were appended (tails re-read)
 * - `c`: cancel requested (the executing worker aborts; a worker holding a paused provider stream closes it)
 * - `q`: a waiting run was requeued (its continuation job is on the queue)
 * - `t`: status changed (paused or finished)
 */
export type RunSignal = { r: string; k: "e" | "c" | "q" | "t" };

/** One row to append to `run_events`. */
export type EventDraft = { kind: "chunk"; chunk: UIMessageChunk; transient?: boolean } | { kind: "segment-end" };

/** Provider state saved at a pause, so the next segment can continue without the live stream (agent_runs.resume_state). */
export type ResumeState = {
  /** Native continuation budget and the exact durable assignments this segment awaits. */
  native?: { deadlineAt: number; sessionVersion: number; stepsUsed: number; maxSteps: number; taskIds: string[]; background?: boolean };
  /**
   * The Hermes run behind this portal run. Recorded as soon as it starts (`runId` only, so a run that ends abnormally
   * can be stopped), and in full at each approval pause: `segment` is the pause's portal segment, which tells a stream
   * held by a worker at that pause apart from one held at an earlier pause.
   */
  hermes?: { runId: string; lastEventId?: string; state?: MapperState; segment?: number };
};

/** Automatic continuations retain unattended policy; only an explicit approval response changes it. */
export function isBackgroundSegment(run: Pick<AgentRun, "background" | "segment"> & Partial<Pick<AgentRun, "executionMode" | "resumeState">>) {
  return run.executionMode === "async_delegate" || (run.background &&
    (run.segment === 0 || (run.resumeState as ResumeState | null)?.native?.background === true));
}

/**
 * Passed from the executor through runTurn → resolveModel to providers that keep state across an approval pause
 * (Hermes). Absent outside the run executor (group chats, delegates, tests), which means "nobody can answer here".
 */
export type RunHandle = {
  id: string;
  holder?: string;
  deadlineAt?: number;
  /** The segment being executed (0 for a new turn). */
  segment: number;
  /** A run created for an approval that was pending before durable runs (no resume state of its own). */
  legacy: boolean;
  /** Saved at the previous pause (null on a first segment, or when nothing was saved). */
  resumeState: ResumeState | null;
  /** Immutable admission snapshot; reused by every approval continuation. */
  hermes?: HermesRunContext;
  /** In-memory worker admission only; never serialized into resumable state or browser responses. */
  teamCandidate?: import('@/lib/hermes-team/candidate-startup').ActiveTeamCandidateRun;
  /** A provider calls this when its segment pauses; the executor stores it with the pause. */
  saveResumeState(state: ResumeState): void;
  /** A provider calls this as soon as it starts a run of its own, so the run can be stopped if this one ends abnormally. */
  noteProviderRun?(state: ResumeState): void | Promise<void>;
};

/** Why a run's segment was aborted. */
export type AbortKind = "cancel" | "timeout" | "shutdown" | "lease-lost";

export class RunAbort extends Error {
  constructor(readonly kind: AbortKind) {
    super(`run aborted: ${kind}`);
    this.name = "RunAbort";
  }
}

export const abortKindOf = (reason: unknown): AbortKind | undefined => (reason instanceof RunAbort ? reason.kind : undefined);

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Tunables (env overrides are read on each call so tests can change them). */
export const runConfig = () => ({
  /** Coalescing window for streamed deltas before a flush. */
  flushMs: env("RUN_FLUSH_MS", 100),
  flushBytes: env("RUN_FLUSH_BYTES", 2048),
  /** Buffered bytes above which the pump waits for flushes (back-pressure). */
  maxBufferBytes: env("RUN_MAX_BUFFER_BYTES", 256 * 1024),
  /** SSE keepalive comment interval on tails. */
  keepaliveMs: env("RUN_KEEPALIVE_MS", 15_000),
  /** Tails re-read at least this often even without a NOTIFY. */
  pollMs: env("RUN_POLL_MS", 2_000),
  /** Worker heartbeat for running segments. */
  heartbeatMs: env("RUN_HEARTBEAT_MS", 10_000),
  /** A running segment whose heartbeat is older than this is considered dead (sweeper interrupts it). */
  staleMs: env("RUN_STALE_MS", 60_000),
  sweepMs: env("RUN_SWEEP_MS", 30_000),
  /** A non-background run still queued after this long fails with "the worker didn't pick it up". */
  queueTimeoutMs: env("RUN_QUEUE_TIMEOUT_MS", 60_000),
  /** Queued runs unclaimed for this long are re-enqueued by the sweeper (lost job). */
  requeueAfterMs: env("RUN_REQUEUE_AFTER_MS", 120_000),
  /** How long a new message waits for a run that is being stopped. */
  stopWaitMs: env("RUN_STOP_WAIT_MS", 5_000),
  /** After an abort, how long the stream may take to end before it is cut. */
  cancelDeadlineMs: env("RUN_CANCEL_DEADLINE_MS", 3_000),
  /** A run that finished (or paused) this recently is still replayed by the resume endpoint. */
  recentReplayMs: env("RUN_RECENT_REPLAY_MS", 120_000),
  /** Events of finished runs are deleted after this long. */
  eventsTtlMs: env("RUN_EVENTS_TTL_MS", 24 * 3600_000),
  /** Concurrent non-background runs per user. */
  runsPerUser: env("RUNS_PER_USER", 3),
  /** Chat segment timeout; routines use ROUTINE_TIMEOUT_MS. */
  runTimeoutMs: env("RUN_TIMEOUT_MS", 30 * 60_000),
  routineTimeoutMs: env("ROUTINE_TIMEOUT_MS", 10 * 60_000),
  /** Paused provider streams (Hermes) a worker keeps open at most, and for how long at most. */
  maxHeld: env("RUN_MAX_HELD", 50),
  holdMaxMs: env("RUN_HOLD_MAX_MS", 3600_000),
});
