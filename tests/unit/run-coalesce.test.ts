import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { chunkBytes, createCoalescer, isTransientChunk, isUrgentChunk } from "@/lib/runs/coalesce";
import { reduce, stored } from "./helpers/run-streams";

const delta = (id: string, d: string, extra: Record<string, unknown> = {}): UIMessageChunk => ({ type: "text-delta", id, delta: d, ...extra });

/** Pushes chunks and collects everything the coalescer releases, in order (then drains the rest). */
function run(chunks: { chunk: UIMessageChunk; transient?: boolean }[]) {
  const c = createCoalescer();
  const out: { chunk: UIMessageChunk; transient: boolean }[] = [];
  for (const { chunk, transient } of chunks) out.push(...c.push(chunk, transient));
  out.push(...c.drain());
  return { c, out };
}

describe("coalescer", () => {
  it("merges consecutive deltas of the same stream (text, reasoning, tool input)", () => {
    const { out } = run(
      [
        delta("0", "Hel"),
        delta("0", "lo"),
        { type: "reasoning-delta", id: "r", delta: "a" },
        { type: "reasoning-delta", id: "r", delta: "b" },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"a":' },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: "1}" },
      ].map((chunk) => ({ chunk: chunk as UIMessageChunk })),
    );
    expect(out.map((d) => d.chunk)).toEqual([
      delta("0", "Hello"),
      { type: "reasoning-delta", id: "r", delta: "ab" },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"a":1}' },
    ]);
  });

  it("never merges across ids, types or other chunks (order is kept)", () => {
    const chunks: UIMessageChunk[] = [
      delta("0", "a"),
      delta("1", "b"),
      { type: "reasoning-delta", id: "1", delta: "c" },
      delta("1", "d"),
      { type: "text-end", id: "1" },
      delta("1", "e"),
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: "x" },
      { type: "tool-input-delta", toolCallId: "c2", inputTextDelta: "y" },
    ];
    expect(run(chunks.map((chunk) => ({ chunk }))).out.map((d) => d.chunk)).toEqual(chunks);
  });

  it("the last providerMetadata wins (like the reducer: a delta without metadata keeps it)", () => {
    const m1 = { p: { sig: "1" } };
    const m2 = { p: { sig: "2" } };
    expect(run([{ chunk: delta("0", "a", { providerMetadata: m1 }) }, { chunk: delta("0", "b") }]).out[0].chunk).toEqual(
      delta("0", "ab", { providerMetadata: m1 }),
    );
    expect(run([{ chunk: delta("0", "a", { providerMetadata: m1 }) }, { chunk: delta("0", "b", { providerMetadata: m2 }) }]).out[0].chunk).toEqual(
      delta("0", "ab", { providerMetadata: m2 }),
    );
  });

  it("urgent and transient chunks release the buffer at once, in order", () => {
    const c = createCoalescer();
    expect(c.push(delta("0", "a"))).toEqual([]);
    expect(c.push(delta("0", "b"))).toEqual([]);
    const title = { type: "data-title", data: { title: "T" }, transient: true } as UIMessageChunk;
    expect(c.push(title, true)).toEqual([
      { chunk: delta("0", "ab"), transient: false },
      { chunk: title, transient: true },
    ]);
    expect(c.size).toBe(0);
    c.push(delta("0", "c"));
    const req: UIMessageChunk = { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" };
    expect(c.push(req).map((d) => d.chunk)).toEqual([delta("0", "c"), req]);
    expect(c.drain()).toEqual([]);
  });

  it("tracks the buffered JSON size", () => {
    const c = createCoalescer();
    c.push({ type: "text-start", id: "0" });
    c.push(delta("0", "abc"));
    c.push(delta("0", "def"));
    expect(c.size).toBe(2);
    expect(c.bytes).toBe(chunkBytes({ type: "text-start", id: "0" }) + chunkBytes(delta("0", "abcdef")));
    c.drain();
    expect([c.bytes, c.size]).toEqual([0, 0]);
  });

  it("the coalesced stream reduces to the same message", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "m1" },
      { type: "start-step" },
      { type: "reasoning-start", id: "r" },
      ...[..."thinking"].map((ch) => ({ type: "reasoning-delta", id: "r", delta: ch }) as UIMessageChunk),
      { type: "reasoning-end", id: "r" },
      { type: "text-start", id: "0" },
      ...[..."Hello there"].map((ch) => delta("0", ch)),
      { type: "text-end", id: "0" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "weather" },
      ...[...'{"city":"Paris"}'].map((ch) => ({ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: ch }) as UIMessageChunk),
      { type: "tool-input-available", toolCallId: "c1", toolName: "weather", input: { city: "Paris" } },
      { type: "finish-step" },
      { type: "finish" },
    ];
    const { out } = run(chunks.map((chunk) => ({ chunk })));
    expect(out.length).toBeLessThan(chunks.length / 2);
    expect(stored(await reduce(out.map((d) => d.chunk)))).toEqual(stored(await reduce(chunks)));
  });

  it("classifies urgent and transient chunks", () => {
    for (const type of [
      "start",
      "finish",
      "abort",
      "error",
      "tool-approval-request",
      "tool-input-available",
      "tool-output-available",
      "tool-output-error",
      "tool-output-denied",
    ])
      expect(isUrgentChunk({ type } as UIMessageChunk)).toBe(true);
    for (const type of ["text-delta", "text-start", "reasoning-delta", "tool-input-delta", "tool-input-start", "start-step", "finish-step"])
      expect(isUrgentChunk({ type } as UIMessageChunk)).toBe(false);
    const notice = { type: "data-notice", data: {}, transient: true } as UIMessageChunk;
    const kept = { type: "data-chart", data: {} } as UIMessageChunk;
    expect([isTransientChunk(notice), isUrgentChunk(notice)]).toEqual([true, true]);
    expect([isTransientChunk(kept), isUrgentChunk(kept)]).toEqual([false, false]);
  });
});
