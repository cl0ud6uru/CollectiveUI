import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDraft } from "@/lib/runs/types";

type Append = { drafts: EventDraft[]; holder?: string; segment: number };
const log = vi.hoisted(() => ({
  appends: [] as Append[],
  inFlight: 0,
  maxInFlight: 0,
  /** Next results: "lost" (fence failed), "throw" (database error), a Date (cancel requested), or a promise to wait on. */
  script: [] as ("lost" | "throw" | "bad-data" | Date | Promise<void>)[],
  seq: 0,
}));

vi.mock("@/db", () => ({ db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) } }));
vi.mock("@/lib/runs/log", () => ({
  appendEventsTx: async (_tx: unknown, _runId: string, segment: number, drafts: EventDraft[], opts: { holder?: string }) => {
    log.inFlight++;
    log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
    try {
      const next = log.script.shift();
      if (next instanceof Promise) await next;
      if (next === "throw") throw new Error("connection terminated");
      if (next === "bad-data") throw Object.assign(new Error("query failed"), { cause: { code: "22P05", message: "unsupported Unicode escape sequence" } });
      if (next === "lost") return null;
      log.appends.push({ drafts, holder: opts.holder, segment });
      log.seq += drafts.length;
      return { lastSeq: log.seq, cancelRequestedAt: next instanceof Date ? next : null };
    } finally {
      log.inFlight--;
    }
  },
}));

import { RunEventWriter } from "@/lib/runs/events";

const delta = (d: string, id = "0"): UIMessageChunk => ({ type: "text-delta", id, delta: d });
const chunksOf = (a: Append) => a.drafts.map((d) => (d.kind === "chunk" ? d.chunk : d));

function writer(over: Partial<ConstructorParameters<typeof RunEventWriter>[0]> = {}) {
  const onLeaseLost = vi.fn();
  const onCancel = vi.fn();
  const w = new RunEventWriter({ runId: "r1", segment: 2, holder: "w1", onLeaseLost, onCancel, ...over });
  return { w, onLeaseLost, onCancel };
}

let open: RunEventWriter[] = [];
const track = <T extends { w: RunEventWriter }>(x: T) => (open.push(x.w), x);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(log, { appends: [], inFlight: 0, maxInFlight: 0, script: [], seq: 0 });
});
afterEach(async () => {
  for (const w of open) await w.close().catch(() => {});
  open = [];
  vi.useRealTimers();
  delete process.env.RUN_MAX_BUFFER_BYTES;
});

describe("RunEventWriter", () => {
  it("coalesces deltas and flushes after the window, fenced on the holder", async () => {
    const { w } = track(writer());
    await w.push({ type: "text-start", id: "0" });
    for (const d of ["Hel", "lo", "!"]) await w.push(delta(d));
    await vi.advanceTimersByTimeAsync(50);
    expect(log.appends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(log.appends).toHaveLength(1);
    expect(log.appends[0]).toMatchObject({ holder: "w1", segment: 2 });
    expect(chunksOf(log.appends[0])).toEqual([{ type: "text-start", id: "0" }, delta("Hello!")]);
    expect(await w.flush()).toBe(2);
  });

  it("flushes at the size threshold without waiting for the timer", async () => {
    const { w } = track(writer());
    await w.push({ type: "text-start", id: "0" });
    await w.push(delta("x".repeat(3000)));
    await vi.advanceTimersByTimeAsync(0);
    expect(log.appends).toHaveLength(1);
  });

  it("writes urgent and transient chunks at once, after what was buffered", async () => {
    const { w } = track(writer());
    await w.push({ type: "start", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.appends.map(chunksOf)).toEqual([[{ type: "start", messageId: "m1" }]]);
    await w.push({ type: "text-start", id: "0" });
    await w.push(delta("a"));
    await w.push({ type: "data-title", data: { title: "T" }, transient: true } as UIMessageChunk);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.appends).toHaveLength(2);
    expect(log.appends[1].drafts).toEqual([
      { kind: "chunk", chunk: { type: "text-start", id: "0" }, transient: false },
      { kind: "chunk", chunk: delta("a"), transient: false },
      { kind: "chunk", chunk: { type: "data-title", data: { title: "T" }, transient: true }, transient: true },
    ]);
  });

  it("serializes flushes: one in flight, the rest join the next write", async () => {
    const { w } = track(writer());
    let release!: () => void;
    log.script.push(new Promise<void>((r) => (release = r)));
    await w.push({ type: "start", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    await w.push({ type: "start-step" });
    await w.push({ type: "tool-input-available", toolCallId: "c1", toolName: "t", input: {} });
    await w.push({ type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" });
    const flushed = w.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(log.appends).toHaveLength(0);
    release();
    expect(await flushed).toBe(4);
    expect(log.maxInFlight).toBe(1);
    expect(log.appends.map((a) => a.drafts.length)).toEqual([1, 3]);
  });

  it("a lost lease calls onLeaseLost once and drops everything after", async () => {
    const { w, onLeaseLost } = track(writer());
    await w.push({ type: "text-start", id: "0" });
    await w.flush();
    log.script.push("lost");
    await w.push({ type: "start-step" });
    expect(await w.flush()).toBe(1);
    expect(w.leaseLost).toBe(true);
    await w.push({ type: "finish" });
    await w.flush();
    await w.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(log.appends).toHaveLength(1);
  });

  it("a cancel request seen on a fence calls onCancel once", async () => {
    const { w, onCancel, onLeaseLost } = track(writer());
    log.script.push(new Date(), new Date());
    await w.push({ type: "start", messageId: "m1" });
    await w.flush();
    await w.push({ type: "finish" });
    await w.flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).not.toHaveBeenCalled();
  });

  it("retries a failed write with backoff, then gives the run up like a lost lease", async () => {
    const a = track(writer());
    log.script.push("throw", "throw");
    await a.w.push({ type: "start", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(199);
    expect(log.appends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(401);
    expect(log.appends).toHaveLength(1);
    expect(a.onLeaseLost).not.toHaveBeenCalled();

    // A database down for longer than about half the stale period: the run is given up (the sweeper takes it over).
    await a.w.close(); // its heartbeats would take the scripted failures meant for b
    const b = track(writer());
    log.script.push(...Array.from({ length: 11 }, () => "throw" as const));
    await b.w.push({ type: "start", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(31_199);
    expect(b.onLeaseLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(b.onLeaseLost).toHaveBeenCalledTimes(1);
    expect(b.w.leaseLost).toBe(true);
  });

  it("a batch Postgres refuses as data (SQLSTATE 22) is dropped once; the run keeps its lease and goes on", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = track(writer());
    log.script.push("bad-data");
    await a.w.push({ type: "start", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.appends).toHaveLength(0);
    await a.w.push({ type: "finish" });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.appends.map(chunksOf)).toEqual([[{ type: "finish" }]]);
    expect(a.onLeaseLost).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("keeps the heartbeat fresh with an empty fenced append when idle", async () => {
    const { w } = track(writer());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.appends.map((a) => a.drafts)).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(5_000);
    await w.push({ type: "start", messageId: "m1" });
    await vi.advanceTimersByTimeAsync(5_000);
    // Written 5 s ago: no heartbeat yet.
    expect(log.appends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.appends).toHaveLength(3);
    expect(log.appends[2].drafts).toEqual([]);
  });

  it("a heartbeat that finds the lease lost stops the writer", async () => {
    const { w, onLeaseLost } = track(writer());
    log.script.push("lost");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(w.leaseLost).toBe(true);
  });

  it("close flushes what is buffered and stops the heartbeat", async () => {
    const { w } = writer();
    await w.push({ type: "text-start", id: "0" });
    await w.push(delta("a"));
    await w.close();
    expect(log.appends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.appends).toHaveLength(1);
  });

  it("applies back-pressure above the buffer limit", async () => {
    process.env.RUN_MAX_BUFFER_BYTES = "1000";
    const { w } = track(writer());
    let release!: () => void;
    log.script.push(new Promise<void>((r) => (release = r)));
    await w.push({ type: "start", messageId: "m1" });
    await w.push({ type: "text-start", id: "0" });
    let done = false;
    const pushed = w.push(delta("y".repeat(1500))).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    release();
    await pushed;
    expect(log.appends.map((a) => a.drafts.length)).toEqual([1, 2]);
  });

  it("knows which text and reasoning streams are still open", async () => {
    const { w } = track(writer());
    await w.push({ type: "text-start", id: "0" });
    await w.push({ type: "reasoning-start", id: "r" });
    await w.push({ type: "text-end", id: "0" });
    await w.push({ type: "text-start", id: "1" });
    expect(w.openStreamIds()).toEqual({ text: ["1"], reasoning: ["r"] });
  });
});
