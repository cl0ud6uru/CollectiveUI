import type { UIMessageChunk } from "ai";
import { db } from "@/db";
import { chunkBytes, createCoalescer, isTransientChunk } from "./coalesce";
import { appendEventsTx, type AppendResult } from "./log";
import { trackOpenStreams, type OpenStreamIds } from "./replay";
import { runConfig, type EventDraft } from "./types";

/**
 * Buffers a running segment's UI chunks and appends them to run_events (coalesced, ~100 ms / 2 KB, urgent chunks at
 * once) with appendEventsTx fenced on `holder`. Flushes are serialized; a 10 s timer keeps the heartbeat fresh during
 * long tool calls (an empty fenced append). A failed fence calls `onLeaseLost` once and drops further writes; a cancel
 * request seen on a fence calls `onCancel`.
 */
export type RunEventWriterOptions = {
  runId: string;
  segment: number;
  holder: string;
  onLeaseLost: () => void;
  onCancel?: () => void;
};

type Draft = { chunk: UIMessageChunk; transient: boolean };

/** Backoff between attempts (about 30 s in all, half the stale period: past that the sweeper may take the run over). */
const RETRY_MS = [200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000, 5000];

/** Postgres' SQLSTATE of a failed query (drizzle wraps the driver's error as `cause`). */
const sqlState = (err: unknown): string | undefined => {
  const e = ((err as { cause?: unknown })?.cause ?? err) as { code?: unknown };
  return typeof e?.code === "string" ? e.code : undefined;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RunEventWriter {
  private readonly coalescer = createCoalescer();
  private readonly open = trackOpenStreams();
  /** Drafts released by the coalescer (urgent chunks and what preceded them), waiting for the next write. */
  private pending: Draft[] = [];
  private pendingBytes = 0;
  /** The last write scheduled (writes run one after another; `write` never rejects). */
  private chain: Promise<void> = Promise.resolve();
  /** A write that is scheduled but hasn't started: later flushes join it instead of queueing another. */
  private scheduled: Promise<void> | null = null;
  private writing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatDue = false;
  private lastWriteAt = Date.now();
  private seq = 0;
  private lost = false;
  private cancelSeen = false;
  private closed = false;

  constructor(readonly opts: RunEventWriterOptions) {
    const { heartbeatMs } = runConfig();
    this.heartbeat = setInterval(() => this.beat(heartbeatMs), heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** Queues a chunk; resolves at once unless more than runConfig().maxBufferBytes is waiting (back-pressure). */
  async push(chunk: UIMessageChunk): Promise<void> {
    if (this.lost || this.closed) return;
    this.open.see(chunk);
    const cfg = runConfig();
    const now = this.coalescer.push(chunk, isTransientChunk(chunk));
    if (now.length) {
      for (const d of now) this.pendingBytes += chunkBytes(d.chunk);
      this.pending.push(...now);
      void this.flush();
    } else if (this.coalescer.bytes >= cfg.flushBytes) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, cfg.flushMs);
    }
    if (this.pendingBytes + this.coalescer.bytes > cfg.maxBufferBytes) await this.flush();
  }

  /** Writes everything buffered. Resolves with the last seq written (or the previous one). */
  async flush(): Promise<number> {
    await this.schedule();
    return this.seq;
  }

  /** Flushes and stops the heartbeat timer. */
  async close(): Promise<void> {
    this.stopHeartbeat();
    await this.flush();
    // Chunks pushed while that write ran.
    while (!this.lost && (this.pending.length || this.coalescer.size)) await this.flush();
    this.closed = true;
    this.clearTimer();
  }

  get leaseLost(): boolean {
    return this.lost;
  }

  /** Text / reasoning streams started and not ended (closeOpenParts ends them when the segment stops mid-part). */
  openStreamIds(): OpenStreamIds {
    return this.open.ids();
  }

  private schedule(): Promise<void> {
    if (!this.scheduled) {
      const p = this.chain.then(() => {
        this.scheduled = null;
        return this.write();
      });
      this.scheduled = p;
      this.chain = p;
    }
    return this.scheduled;
  }

  /** An empty fenced append when nothing was written for a heartbeat period (a long tool call). */
  private beat(heartbeatMs: number) {
    if (this.lost || this.closed || this.writing || this.scheduled) return;
    if (Date.now() - this.lastWriteAt < heartbeatMs) return;
    this.heartbeatDue = true;
    void this.schedule();
  }

  private async write(): Promise<void> {
    this.clearTimer();
    const drafts = [...this.pending, ...this.coalescer.drain()];
    this.pending = [];
    this.pendingBytes = 0;
    const heartbeat = this.heartbeatDue;
    this.heartbeatDue = false;
    if (this.lost || (!drafts.length && !heartbeat)) return;
    const events: EventDraft[] = drafts.map((d) => ({ kind: "chunk", chunk: d.chunk, transient: d.transient }));
    this.writing = true;
    try {
      const res = await this.append(events);
      if (res === "rejected") return; // the batch was dropped (logged); the run carries on
      if (!res) return this.loseLease();
      this.seq = res.lastSeq;
      this.lastWriteAt = Date.now();
      if (res.cancelRequestedAt && !this.cancelSeen) {
        this.cancelSeen = true;
        try {
          this.opts.onCancel?.();
        } catch (err) {
          console.error("[runs] onCancel failed", err);
        }
      }
    } finally {
      this.writing = false;
    }
  }

  /**
   * One fenced transaction, retried on database errors for about half the stale period (a failover, a network blip:
   * the lease is still ours); null when the fence failed or the database stayed down, "rejected" when Postgres refused
   * the data itself (SQLSTATE class 22; nothing gets better by retrying, and losing the lease would drop the reply).
   */
  private async append(events: EventDraft[]): Promise<AppendResult | null | "rejected"> {
    const { runId, segment, holder } = this.opts;
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction((tx) => appendEventsTx(tx, runId, segment, events, { holder }));
      } catch (err) {
        if (sqlState(err)?.startsWith("22")) {
          console.error(`[runs] run ${runId}: the event log refused a batch of ${events.length} event(s); dropped`, err);
          return "rejected";
        }
        if (attempt >= RETRY_MS.length) {
          console.error(`[runs] run ${runId}: giving up on the event log after ${attempt + 1} attempts`, err);
          return null;
        }
        console.warn(`[runs] run ${runId}: event append failed, retrying`, err);
        await sleep(RETRY_MS[attempt]);
      }
    }
  }

  private loseLease() {
    if (this.lost) return;
    this.lost = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.coalescer.drain();
    this.clearTimer();
    this.stopHeartbeat();
    try {
      this.opts.onLeaseLost();
    } catch (err) {
      console.error("[runs] onLeaseLost failed", err);
    }
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
