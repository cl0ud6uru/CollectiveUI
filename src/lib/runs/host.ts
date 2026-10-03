/**
 * The worker process's view of the run segments it executes (one RunHost per process, on globalThis): its instance
 * id (the `holder` every executor write is fenced on), the AbortController of each segment running here, one batched
 * heartbeat for all of them, and the reaction to run signals (cancel, listener reconnect). Shutdown aborts every
 * local segment as "shutdown" (they save their partial reply as interrupted) and closes held Hermes streams.
 */
import os from "node:os";
import { randomBytes } from "node:crypto";
import { closeAllParked, dropParkedForAgentRun } from "@/lib/llm/providers/hermes/runs";
import { runListener } from "./listener";
import { heartbeatRuns } from "./state";
import { RunAbort, runConfig } from "./types";

export class RunHost {
  readonly instanceId = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  private readonly runs = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private beating: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private idle: (() => void)[] = [];
  private stopping = false;

  /** Set once shutdown starts: the executor claims nothing more (the sweeper re-enqueues what stays queued). */
  get shuttingDown(): boolean {
    return this.stopping;
  }

  /** Run ids of the segments executing here. */
  tracked(): string[] {
    return [...this.runs.keys()];
  }

  /** Registers a running segment; the returned function unregisters it (call it once the segment is done). */
  track(runId: string, ac: AbortController): () => void {
    this.runs.set(runId, ac);
    if (this.stopping) ac.abort(new RunAbort("shutdown"));
    this.ensureTimer();
    return () => {
      if (this.runs.get(runId) === ac) this.runs.delete(runId);
      if (!this.runs.size) {
        this.stopTimer();
        for (const fn of this.idle.splice(0)) fn();
      }
    };
  }

  /**
   * Refreshes the lease of every tracked segment in one statement. A segment whose run is no longer held here
   * (sweeper takeover, deleted) aborts as "lease-lost"; one with a cancel request aborts as "cancel". Overlapping calls
   * share one round trip.
   */
  heartbeat(): Promise<void> {
    this.beating ??= this.beat().finally(() => {
      this.beating = null;
    });
    return this.beating;
  }

  private async beat() {
    // Snapshot the controllers: a segment that ends (and a next segment of the same run that starts) while the
    // statement runs must not be aborted on this result.
    const entries = [...this.runs.entries()];
    if (!entries.length) return;
    let rows: Awaited<ReturnType<typeof heartbeatRuns>>;
    try {
      rows = await heartbeatRuns(
        this.instanceId,
        entries.map(([id]) => id),
      );
    } catch (err) {
      // The database is unreachable: keep going (the event writer's own fence decides when the lease is gone).
      console.warn("[runs] heartbeat failed", err instanceof Error ? err.message : err);
      return;
    }
    const held = new Map(rows.map((r) => [r.id, r]));
    for (const [id, ac] of entries) {
      if (this.runs.get(id) !== ac || ac.signal.aborted) continue;
      const row = held.get(id);
      if (!row) ac.abort(new RunAbort("lease-lost"));
      else if (row.cancelRequestedAt) ac.abort(new RunAbort("cancel"));
    }
  }

  /**
   * Listens for run signals: `c` (stop) aborts a segment running here and closes a Hermes stream held for a paused
   * run; a listener reconnect (signals may have been missed) triggers an immediate heartbeat, which sees cancel
   * requests too. Idempotent.
   */
  start() {
    if (this.unsubscribe || this.stopping) return;
    this.unsubscribe = runListener().subscribeAll((sig) => {
      if (sig.k === "reconnect") {
        void this.heartbeat();
        return;
      }
      if (sig.k !== "c") return;
      this.runs.get(sig.r)?.abort(new RunAbort("cancel"));
      dropParkedForAgentRun(sig.r);
    });
  }

  /**
   * Stops accepting segments, aborts every local one as "shutdown", waits up to `timeoutMs` for them to save and let
   * go, then closes held Hermes streams (their runs keep waiting; the next worker continues them from the saved
   * resume state) and stops the timers.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.stopping = true;
    for (const ac of this.runs.values()) ac.abort(new RunAbort("shutdown"));
    if (this.runs.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => this.idle.push(resolve)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (this.runs.size) console.warn(`[runs] shutdown: ${this.runs.size} segment(s) didn't finish in ${timeoutMs} ms`);
    }
    const held = closeAllParked();
    if (held) console.log(`[runs] shutdown: closed ${held} held Hermes stream(s)`);
    this.stopTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.heartbeat(), runConfig().heartbeatMs);
    this.timer.unref?.();
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const g = globalThis as unknown as { __portalRunHost?: RunHost };

/** This process's RunHost. */
export function runHost(): RunHost {
  return (g.__portalRunHost ??= new RunHost());
}
