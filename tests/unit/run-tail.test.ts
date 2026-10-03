import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState, StoredEvent } from "@/lib/runs/log";
import type { RunSignal } from "@/lib/runs/types";

type Sig = RunSignal | { r: string; k: "reconnect" };

const store = vi.hoisted(() => ({
  events: [] as StoredEvent[],
  run: null as RunState | null,
  reads: 0,
  failReads: 0,
  /** Runs inside readRunState (a NOTIFY landing between the tail's reads and its wait). */
  onState: null as null | (() => void),
}));

const fake = vi.hoisted(() => {
  const subs = new Map<string, Set<(s: Sig) => void>>();
  const listener = {
    waits: 0,
    subscribe(runId: string, fn: (s: Sig) => void) {
      if (!subs.has(runId)) subs.set(runId, new Set());
      subs.get(runId)!.add(fn);
      return () => {
        subs.get(runId)?.delete(fn);
        if (!subs.get(runId)?.size) subs.delete(runId);
      };
    },
    subscribeAll: () => () => {},
    wait(runId: string, ms: number, signal?: AbortSignal) {
      listener.waits++;
      return new Promise<"signal" | "timeout" | "aborted">((resolve) => {
        if (signal?.aborted) return resolve("aborted");
        const done = (v: "signal" | "timeout" | "aborted") => {
          clearTimeout(t);
          unsub();
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const onAbort = () => done("aborted");
        const t = setTimeout(() => done("timeout"), ms);
        signal?.addEventListener("abort", onAbort);
        const unsub = listener.subscribe(runId, () => done("signal"));
      });
    },
    ready: async () => {},
    close: async () => {},
  };
  return {
    subs,
    listener,
    emit(runId: string, k: Sig["k"]) {
      for (const fn of [...(subs.get(runId) ?? [])]) fn({ r: runId, k } as Sig);
    },
  };
});

const abortQueuedRun = vi.hoisted(() => vi.fn());

vi.mock("@/lib/runs/log", () => ({
  readEvents: async (_runId: string, after: number, limit: number) => {
    store.reads++;
    if (store.failReads > 0) {
      store.failReads--;
      throw new Error("connection refused");
    }
    return store.events.filter((e) => e.seq > after).slice(0, limit);
  },
  readRunState: async () => {
    const run = store.run && { ...store.run };
    store.onState?.();
    return run;
  },
}));
vi.mock("@/lib/runs/listener", () => ({ runListener: () => fake.listener }));
vi.mock("@/lib/runs/store", () => ({ abortQueuedRun }));

import { QUEUE_TIMEOUT_ERROR, tailRun } from "@/lib/runs/tail";

const RUN = "run_1";

function setRun(over: Partial<RunState> = {}) {
  const now = new Date();
  store.run = {
    id: RUN,
    status: "running",
    segment: 0,
    lastSeq: store.events.length,
    boundarySeq: 0,
    background: false,
    executionMode: "worker",
    resumeState: null,
    legacy: false,
    holder: "w1",
    cancelRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    ...over,
  };
}

/** Appends to the fake log (and bumps last_seq) like a committed append. */
function append(segment: number, ...items: (UIMessageChunk | "end" | { transient: UIMessageChunk })[]) {
  for (const it of items) {
    const seq = store.events.length + 1;
    if (it === "end") store.events.push({ seq, segment, kind: "segment-end", chunk: null, transient: false });
    else if ("transient" in it && typeof it.transient === "object") store.events.push({ seq, segment, kind: "chunk", chunk: it.transient, transient: true });
    else store.events.push({ seq, segment, kind: "chunk", chunk: it as UIMessageChunk, transient: false });
  }
  if (store.run) store.run.lastSeq = store.events.length;
}

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

/** Resolves a pending read while advancing fake time in steps (the tail waits on timers between polls). */
async function readWithin<T>(p: Promise<T>, ms: number, step = 100): Promise<T> {
  let settled = false;
  void p.then(() => (settled = true));
  for (let t = 0; t < ms && !settled; t += step) await vi.advanceTimersByTimeAsync(step);
  await vi.advanceTimersByTimeAsync(0);
  if (!settled) throw new Error(`still pending after ${ms} ms`);
  return p;
}

const start: UIMessageChunk = { type: "start", messageId: "m1" };
const d = (s: string): UIMessageChunk => ({ type: "text-delta", id: "0", delta: s });
const title = { type: "data-title", data: { title: "T" }, transient: true } as UIMessageChunk;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(store, { events: [], run: null, reads: 0, failReads: 0, onState: null });
  fake.subs.clear();
  fake.listener.waits = 0;
  abortQueuedRun.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("tailRun", () => {
  it("a live tail passes everything from the boundary and ends at the segment-end", async () => {
    setRun({ segment: 1 });
    append(0, start, "end", { type: "tool-approval-response", approvalId: "a1", approved: true });
    const boundary = store.events.length;
    append(1, start, { transient: title }, { type: "text-start", id: "0" }, d("hi"), "end", start);
    const out = await collect(tailRun(RUN, { afterSeq: boundary, targetSegment: 1, replay: false }));
    expect(out).toEqual([start, title, { type: "text-start", id: "0" }, d("hi")]);
    expect(fake.subs.size).toBe(0);
  });

  it("a replay starts at seq 1 with one start, no transient chunks, through earlier segment ends", async () => {
    setRun({ segment: 1, status: "succeeded" });
    append(0, start, { transient: title }, { type: "finish" }, "end", { type: "tool-approval-response", approvalId: "a1", approved: true });
    append(1, start, d("x"), { type: "finish" }, "end");
    const out = await collect(tailRun(RUN, { afterSeq: 0, targetSegment: 1, replay: true }));
    expect(out).toEqual([start, { type: "tool-approval-response", approvalId: "a1", approved: true }, d("x"), { type: "finish" }]);
  });

  it("reads in batches", async () => {
    setRun({ status: "succeeded" });
    append(0, start, ...Array.from({ length: 450 }, (_, i) => d(String(i))), "end");
    const out = await collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }));
    expect(out).toHaveLength(451);
    expect(store.reads).toBe(3);
  });

  it("safety net: ends at a final status once the cursor reached last_seq", async () => {
    setRun({ status: "failed" });
    append(0, start, d("partial"));
    expect(await collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }))).toEqual([start, d("partial")]);
  });

  it("safety net: ends when waiting at or above the target segment, not below it", async () => {
    setRun({ status: "waiting", segment: 1 });
    expect(await collect(tailRun(RUN, { afterSeq: 0, targetSegment: 1, replay: false }))).toEqual([]);

    setRun({ status: "waiting", segment: 0 });
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 1, replay: false }).getReader();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.listener.waits).toBeGreaterThanOrEqual(5);
    // Requeued and the continuation runs.
    store.run!.status = "running";
    store.run!.segment = 1;
    append(1, start);
    fake.emit(RUN, "e");
    expect(await readWithin(next, 100)).toEqual({ done: false, value: start });
    await reader.cancel();
  });

  it("closes when the run is gone (conversation deleted), and gives up on rows that never appear", async () => {
    expect(await collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: true }))).toEqual([]);
    setRun({ status: "succeeded", lastSeq: 40 });
    expect(await collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: true }))).toEqual([]);
  });

  it("wakes on a signal without waiting for the poll", async () => {
    setRun();
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }).getReader();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.listener.waits).toBe(1);
    append(0, start);
    fake.emit(RUN, "e");
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toEqual({ done: false, value: start });
    await reader.cancel();
  });

  it("re-reads at the poll floor when no signal comes", async () => {
    setRun();
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }).getReader();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    append(0, start);
    await vi.advanceTimersByTimeAsync(1_900);
    let got = false;
    void next.then(() => (got = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toEqual({ done: false, value: start });
    await reader.cancel();
  });

  it("a signal that lands between the read and the wait isn't lost", async () => {
    setRun();
    store.onState = () => {
      store.onState = null;
      append(0, start);
      fake.emit(RUN, "e");
    };
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }).getReader();
    // Delivered at once: without the dirty flag the tail would sleep until the poll floor.
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toEqual({ done: false, value: start });
    await reader.cancel();
  });

  it("a listener reconnect makes it re-read", async () => {
    setRun();
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }).getReader();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    append(0, start);
    fake.emit(RUN, "reconnect");
    await vi.advanceTimersByTimeAsync(0);
    expect(await next).toEqual({ done: false, value: start });
    await reader.cancel();
  });

  it("fails a non-background run the worker didn't pick up in time, once, and shows the error", async () => {
    setRun({ status: "queued", holder: null });
    abortQueuedRun.mockImplementation(async () => {
      store.run!.status = "failed";
      append(0, { type: "error", errorText: QUEUE_TIMEOUT_ERROR }, "end");
      return store.run;
    });
    const out = collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(abortQueuedRun).not.toHaveBeenCalled();
    expect(await readWithin(out, 5_000)).toEqual([{ type: "error", errorText: QUEUE_TIMEOUT_ERROR }]);
    expect(abortQueuedRun).toHaveBeenCalledTimes(1);
    // The database decides: queued that long by its own clock, and no worker busy (a busy one gets to it later).
    expect(abortQueuedRun).toHaveBeenCalledWith(RUN, { status: "failed", error: QUEUE_TIMEOUT_ERROR }, { ifUnclaimedForMs: 60_000 });
  });

  it("the queue timeout counts from the (re)queue and excludes unattended first segments and automatic continuations", async () => {
    // A continuation: created long ago, requeued just now. The database keeps refusing (a worker is busy).
    setRun({ status: "queued", segment: 1, createdAt: new Date(Date.now() - 3600_000) });
    abortQueuedRun.mockResolvedValue(null);
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 1, replay: false }).getReader();
    void reader.read();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abortQueuedRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(abortQueuedRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abortQueuedRun).toHaveBeenCalledTimes(2);
    await reader.cancel();

    // A routine's first segment waits for a background slot as long as it takes.
    abortQueuedRun.mockClear();
    for (const over of [
      { segment: 0 },
      { segment: 1, resumeState: { native: { background: true } } },
      { segment: 1, executionMode: "async_delegate" as const },
    ]) {
      setRun({ status: "queued", background: true, updatedAt: new Date(Date.now() - 3600_000), ...over });
      const bg = tailRun(RUN, { afterSeq: 0, targetSegment: over.segment, replay: false }).getReader();
      void bg.read();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(abortQueuedRun).not.toHaveBeenCalled();
      await bg.cancel();
    }

    // Its continuation (someone answered in the Inbox) is interactive: it does time out.
    setRun({ status: "queued", background: true, segment: 1, updatedAt: new Date(Date.now() - 3600_000) });
    const cont = tailRun(RUN, { afterSeq: 0, targetSegment: 1, replay: false }).getReader();
    void cont.read();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(abortQueuedRun).toHaveBeenCalledTimes(1);
    await cont.cancel();
  });

  it("cancel unsubscribes and stops reading; the run is untouched", async () => {
    setRun({ status: "queued", updatedAt: new Date(Date.now() - 3600_000) });
    abortQueuedRun.mockResolvedValue(null);
    const reader = tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false }).getReader();
    void reader.read().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    abortQueuedRun.mockClear();
    await reader.cancel();
    const reads = store.reads;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.subs.size).toBe(0);
    expect(store.reads).toBe(reads);
    expect(abortQueuedRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed reads, then errors the stream", async () => {
    setRun({ status: "succeeded" });
    append(0, start, "end");
    store.failReads = 2;
    expect(await readWithin(collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false })), 10_000)).toEqual([start]);

    store.failReads = 100;
    const failed = collect(tailRun(RUN, { afterSeq: 0, targetSegment: 0, replay: false })).catch((e: Error) => e);
    const err = await readWithin(failed, 20_000);
    expect(err).toBeInstanceOf(Error);
    expect(fake.subs.size).toBe(0);
  });
});
