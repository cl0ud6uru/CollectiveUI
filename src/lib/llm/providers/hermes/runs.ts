/**
 * Live Hermes runs held open while a portal run waits for someone to answer an approval.
 *
 * A segment that reaches a Hermes approval ends (the run pauses as `waiting`, the card shows), but the Hermes run keeps
 * waiting. Hermes releases up to v2026.9.24 serve a run's events to its first subscriber only, so the worker that ran
 * the segment keeps that event stream open here and the continuation segment picks it up. The registry is per process:
 * with one worker (the default) every continuation lands here; with several, or after a restart, the provider falls
 * back to the resume state saved with the pause (re-attaching after its last event on newer Hermes, else the run's
 * status). Entries are dropped after the approval's time limit, and the registry holds at most RUN_MAX_HELD streams.
 */
import { runConfig } from "@/lib/runs/types";
import { stopRun, type HermesEvent, type HermesTarget } from "./client";
import type { MapperState } from "./mapper";

/** Reads a run's events in the background, so nothing is lost while nobody is consuming. */
export class EventTap {
  private readonly queue: HermesEvent[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private failure: unknown = null;
  private readonly controller = new AbortController();
  /**
   * The id of the newest event handed out by next(), i.e. where a reader that re-attaches must continue (its
   * Last-Event-ID). Starts at the id this tap re-attached after, if any.
   */
  lastSeq: string | undefined;

  constructor(open: (signal: AbortSignal) => AsyncGenerator<HermesEvent>, lastEventId?: string) {
    this.lastSeq = lastEventId;
    void (async () => {
      try {
        for await (const e of open(this.controller.signal)) {
          this.queue.push(e);
          // A paused run produces next to nothing; the cap only guards against a runaway stream nobody reads.
          if (this.queue.length > 20_000) this.queue.splice(0, this.queue.length - 20_000);
          this.wake();
        }
      } catch (err) {
        if (!this.controller.signal.aborted) this.failure = err;
      } finally {
        this.ended = true;
        this.wake();
      }
    })();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** Next event, "idle" if none arrives within `idleMs`, or null once the stream has ended. Throws the stream's error. */
  async next(idleMs?: number): Promise<HermesEvent | "idle" | null> {
    for (;;) {
      const e = this.queue.shift();
      if (e) {
        if (typeof e._seq === "string") this.lastSeq = e._seq;
        return e;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return null;
      }
      const arrived = await new Promise<boolean>((resolve) => {
        const timer = idleMs !== undefined ? setTimeout(() => resolve(false), idleMs) : null;
        this.waiter = () => {
          if (timer) clearTimeout(timer);
          resolve(true);
        };
      });
      if (!arrived) {
        this.waiter = null;
        return "idle";
      }
    }
  }

  close() {
    this.controller.abort();
  }
}

export type ParkedRun = {
  runId: string;
  sessionId: string | null;
  target: HermesTarget;
  tap: EventTap;
  state: MapperState;
  /** The portal run (agent_runs.id) paused on this Hermes run, so cancelling it can close the stream. */
  agentRunId?: string;
  /** The portal run's segment that paused (see ResumeState.hermes.segment). */
  segment?: number;
  timer: ReturnType<typeof setTimeout>;
};

const g = globalThis as unknown as { __hermesParked?: Map<string, ParkedRun> };
const parked = (g.__hermesParked ??= new Map());

/** How long a paused run's stream is kept: a minute past Hermes' own approval limit, at most RUN_HOLD_MAX_MS. */
export const holdTtlMs = (approvalTimeoutSec: number) => Math.min((approvalTimeoutSec + 60) * 1000, runConfig().holdMaxMs);

/**
 * Keeps a run's stream for a later segment; dropped (and closed) after `ttlMs`. When RUN_MAX_HELD streams are held
 * already, the stream is closed instead and false returned (the continuation then uses the saved resume state).
 */
export function park(run: Omit<ParkedRun, "timer">, ttlMs: number): boolean {
  const previous = unpark(run.runId);
  if (previous && previous.tap !== run.tap) previous.tap.close();
  if (parked.size >= runConfig().maxHeld) {
    run.tap.close();
    return false;
  }
  const timer = setTimeout(() => unpark(run.runId)?.tap.close(), ttlMs);
  timer.unref?.();
  parked.set(run.runId, { ...run, timer });
  return true;
}

/** Takes a parked run (the caller owns its stream from now on). */
export function unpark(runId: string): ParkedRun | undefined {
  const run = parked.get(runId);
  if (!run) return undefined;
  clearTimeout(run.timer);
  parked.delete(runId);
  return run;
}

export const isParked = (runId: string) => parked.has(runId);

/** The stream a portal run left held at its last pause in this process, if any. */
export function parkedForAgentRun(agentRunId: string): ParkedRun | undefined {
  return [...parked.values()].find((r) => r.agentRunId === agentRunId);
}

/** Parked runs of a conversation, e.g. to stop them when someone moves on without answering. */
export function parkedForSession(sessionId: string): ParkedRun[] {
  return [...parked.values()].filter((r) => r.sessionId === sessionId);
}

/**
 * A portal run was cancelled or superseded while paused: closes its held stream and asks Hermes to stop the run
 * (best effort). False when this process holds nothing for it.
 */
export function dropParkedForAgentRun(agentRunId: string): boolean {
  const entry = [...parked.values()].find((r) => r.agentRunId === agentRunId);
  if (!entry || !unpark(entry.runId)) return false;
  entry.tap.close();
  void stopRun(entry.target, entry.runId).catch(() => {});
  return true;
}

/**
 * Shutdown: closes every held stream. The Hermes runs keep waiting for their answers, which the next worker posts
 * using the resume state saved with each pause. Returns how many were held.
 */
export function closeAllParked(): number {
  const all = [...parked.keys()].flatMap((id) => unpark(id) ?? []);
  for (const r of all) r.tap.close();
  return all.length;
}
