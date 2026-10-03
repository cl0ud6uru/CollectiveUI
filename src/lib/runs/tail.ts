import type { UIMessageChunk } from "ai";
import { readEvents, readRunState } from "./log";
import { runListener } from "./listener";
import { liveFilter, replayFilter } from "./replay";
import { abortQueuedRun } from "./store";
import { isBackgroundSegment, isFinal, runConfig } from "./types";

const BATCH = 200;
/** Consecutive failed reads (database down) before the tail gives up with an error. */
const MAX_READ_FAILURES = 5;

export const QUEUE_TIMEOUT_ERROR = "The background worker didn't pick up this reply. Check that it's running.";
/** How often a tail asks again whether a long-queued run can be failed (no worker busy: the worker is down). */
const QUEUE_CHECK_MS = 10_000;

/**
 * A run's UI chunk stream for the browser. Pull-based: reads up to 200 events after the cursor through replayFilter
 * (replay) or liveFilter, enqueues them; with nothing new, re-reads the run state and ends when the status is final,
 * or waiting at/above targetSegment, and the cursor has reached last_seq; otherwise waits on the listener (poll floor
 * runConfig().pollMs). A non-background run still queued after runConfig().queueTimeoutMs is failed via
 * abortQueuedRun (the worker didn't pick it up). `cancel()` unsubscribes; it never affects the run.
 *
 * The run's `updated_at` is when it was (re)queued: a continuation's `created_at` is its first segment's.
 */
export function tailRun(
  runId: string,
  opts: { afterSeq: number; targetSegment: number; replay: boolean; liveAfterSeq?: number; authorize?: () => Promise<void> },
): ReadableStream<UIMessageChunk> {
  const filter = opts.replay ? replayFilter(opts.targetSegment, opts.liveAfterSeq) : liveFilter(opts.targetSegment);
  const listener = runListener();
  const stop = new AbortController();
  let cursor = opts.afterSeq;
  // Set by any signal for the run (incl. a listener reconnect): something may have changed since the last read.
  let dirty = true;
  let unsubscribe: (() => void) | null = null;
  let nextQueueCheck = 0;
  // Reads that found nothing although the run is done and last_seq is ahead (rows gone, e.g. deleted): give up after one retry.
  let emptyWhenDone = 0;
  let failures = 0;

  const end = () => {
    unsubscribe?.();
    unsubscribe = null;
    stop.abort();
  };

  /** Reads until it enqueued something or the stream is done. */
  const step = async (controller: ReadableStreamDefaultController<UIMessageChunk>): Promise<void> => {
    for (;;) {
      if (stop.signal.aborted) return;
      await opts.authorize?.();
      dirty = false;
      const events = await readEvents(runId, cursor, BATCH);
      if (stop.signal.aborted) return;
      await opts.authorize?.();
      let sent = 0;
      for (const e of events) {
        cursor = e.seq;
        const out = filter(e);
        if (out === "end") {
          end();
          controller.close();
          return;
        }
        if (out) {
          controller.enqueue(out);
          sent++;
        }
      }
      if (sent) return;
      if (events.length) continue;

      const run = await readRunState(runId);
      if (stop.signal.aborted) return;
      if (!run) {
        // The conversation (and its runs) was deleted.
        end();
        controller.close();
        return;
      }
      const done = isFinal(run.status) || ((run.status === "waiting" || run.status === "waiting_tasks") && run.segment >= opts.targetSegment);
      if (done) {
        if (cursor >= run.lastSeq || ++emptyWhenDone > 1) {
          end();
          controller.close();
          return;
        }
        // Rows committed between the two reads: read again.
        continue;
      }
      emptyWhenDone = 0;

      const cfg = runConfig();
      // Nobody picked it up (a routine's first segment may wait its turn). The local clock only says when to ask: the
      // database checks the age itself, and that no worker is busy (a busy one gets to it once a slot frees up).
      const interactive = !isBackgroundSegment(run);
      if (run.status === "queued" && interactive && Date.now() >= nextQueueCheck && Date.now() - run.updatedAt.getTime() > cfg.queueTimeoutMs) {
        nextQueueCheck = Date.now() + QUEUE_CHECK_MS;
        // Its finalize appends the error and the segment-end this tail ends at.
        const failed = await abortQueuedRun(runId, { status: "failed", error: QUEUE_TIMEOUT_ERROR }, { ifUnclaimedForMs: cfg.queueTimeoutMs }).catch((err) => {
          console.error(`[runs] couldn't fail queued run ${runId}`, err);
          return null;
        });
        if (failed) continue;
      }
      if (dirty) continue;
      await listener.wait(runId, cfg.pollMs, stop.signal);
    }
  };

  return new ReadableStream<UIMessageChunk>({
    start() {
      // Before the first read, so a NOTIFY between a read and the wait isn't lost (it sets `dirty`).
      unsubscribe = listener.subscribe(runId, () => {
        dirty = true;
      });
    },
    async pull(controller) {
      for (;;) {
        try {
          if (opts.authorize) {
            try { await opts.authorize(); } catch (err) { end(); controller.error(err); return; }
          }
          await step(controller);
          failures = 0;
          return;
        } catch (err) {
          if (stop.signal.aborted) return;
          if (++failures >= MAX_READ_FAILURES) {
            end();
            controller.error(err);
            return;
          }
          console.warn(`[runs] tail of run ${runId}: read failed, retrying`, err);
          await listener.wait(runId, runConfig().pollMs, stop.signal);
        }
      }
    },
    cancel() {
      end();
    },
  });
}
