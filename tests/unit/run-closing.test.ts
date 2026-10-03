import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import type { PortalUIMessage } from "@/lib/chat/store";
import { closeOpenParts, openStreamIdsOf } from "@/lib/runs/replay";
import type { AgentRunStatus } from "@/lib/runs/types";
import { reduce, stored } from "./helpers/run-streams";

// The SDK warns (once per closing here) that a static tool's tool-input-error input lands in the deprecated rawInput.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const S: UIMessageChunk[] = [{ type: "start", messageId: "m1" }, { type: "start-step" }];
const input = { city: "Paris" };
const staticCall: UIMessageChunk = { type: "tool-input-available", toolCallId: "c1", toolName: "weather", input };
const hermesCall: UIMessageChunk = {
  type: "tool-input-available",
  toolCallId: "h1",
  toolName: "hermes__terminal",
  input: { command: "rm x" },
  providerExecuted: true,
  dynamic: true,
};
const ask = (toolCallId: string, approvalId: string): UIMessageChunk[] => [
  { type: "tool-approval-request", approvalId, toolCallId },
  { type: "finish-step" },
  { type: "finish", finishReason: "tool-calls" },
];
const answer = (approvalId: string, approved: boolean, reason?: string): UIMessageChunk => ({
  type: "tool-approval-response",
  approvalId,
  approved,
  ...(reason ? { reason } : {}),
});

/**
 * Closes the message the reducer makes of `log` and checks the invariant the run layer relies on: the reducer, fed
 * the log plus the closing chunks (what a replay sees), produces exactly the returned (saved) message.
 */
async function close(log: UIMessageChunk[], status: AgentRunStatus, opts: { deniedReason?: string; stoppedText?: string; endNote?: string } = {}) {
  const before = stored(await reduce(log));
  const snapshot = structuredClone(before);
  const res = closeOpenParts(before, status, { openIds: openStreamIdsOf(log), ...opts });
  expect(before).toEqual(snapshot);
  expect(stored(await reduce([...log, ...res.chunks]))).toEqual(stored(res.message));
  // Tool closings need no stream state: the reducer applies them to the saved message as well.
  if (!res.chunks.some((c) => c.type === "text-end" || c.type === "reasoning-end")) {
    expect(stored(await reduce(res.chunks.length ? res.chunks : [{ type: "start", messageId: "m1" }], before))).toEqual(stored(res.message));
  }
  return res;
}

const toolPart = (m: PortalUIMessage, id: string) => m.parts.find((p) => "toolCallId" in p && p.toolCallId === id) as Record<string, unknown>;

describe("closeOpenParts", () => {
  it("endNote: a reply that ended early keeps a data-run-error part saying why, after its closings", async () => {
    const why = "The worker running this reply stopped. Try again.";
    const log: UIMessageChunk[] = [...S, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "Half" }, staticCall];
    const res = await close(log, "interrupted", { endNote: why });
    expect(res.chunks.at(-1)).toEqual({ type: "data-run-error", data: { message: why } });
    expect(res.message.parts.at(-1)).toEqual({ type: "data-run-error", data: { message: why } });
    expect(toolPart(res.message, "c1")).toMatchObject({ state: "output-error", errorText: "Interrupted." });
    // Without a note nothing is added.
    const plain = await close(log, "interrupted");
    expect(plain.message.parts.some((p) => p.type === "data-run-error")).toBe(false);
  });

  it("approved but not run → output-error 'Stopped before it ran.' (static and provider-executed dynamic)", async () => {
    const res = await close([...S, staticCall, ...ask("c1", "a1"), answer("a1", true)], "cancelled");
    expect(res.chunks).toEqual([{ type: "tool-output-error", toolCallId: "c1", errorText: "Stopped before it ran." }]);
    expect(toolPart(res.message, "c1")).toMatchObject({
      state: "output-error",
      errorText: "Stopped before it ran.",
      input,
      approval: { id: "a1", approved: true },
    });

    const dyn = await close([...S, hermesCall, ...ask("h1", "a2"), answer("a2", true)], "failed", { stoppedText: "Couldn't continue: the app was removed." });
    expect(dyn.chunks).toEqual([{ type: "tool-output-error", toolCallId: "h1", errorText: "Couldn't continue: the app was removed.", dynamic: true }]);
    expect(toolPart(dyn.message, "h1")).toMatchObject({ type: "dynamic-tool", state: "output-error", providerExecuted: true, input: { command: "rm x" } });
  });

  it("denied → output-denied, keeping the reason", async () => {
    const res = await close([...S, staticCall, ...ask("c1", "a1"), answer("a1", false, "nope")], "cancelled");
    expect(res.chunks).toEqual([{ type: "tool-output-denied", toolCallId: "c1" }]);
    expect(toolPart(res.message, "c1")).toMatchObject({ state: "output-denied", approval: { id: "a1", approved: false, reason: "nope" } });
  });

  it("input-available and preliminary output → output-error 'Interrupted.'", async () => {
    const res = await close(
      [
        ...S,
        staticCall,
        hermesCall,
        { type: "tool-input-available", toolCallId: "c2", toolName: "search", input: { q: "x" } },
        { type: "tool-output-available", toolCallId: "c2", output: { partial: true }, preliminary: true },
      ],
      "interrupted",
    );
    expect(res.chunks).toEqual([
      { type: "tool-output-error", toolCallId: "c1", errorText: "Interrupted." },
      { type: "tool-output-error", toolCallId: "h1", errorText: "Interrupted.", dynamic: true },
      { type: "tool-output-error", toolCallId: "c2", errorText: "Interrupted." },
    ]);
    for (const id of ["c1", "h1", "c2"]) expect(toolPart(res.message, id)).toMatchObject({ state: "output-error", errorText: "Interrupted." });
    expect(toolPart(res.message, "c2").output).toBeUndefined();
    expect(toolPart(res.message, "c2").preliminary).toBeUndefined();
  });

  it("input-streaming → output-error 'Interrupted.' with the input so far (static, dynamic, none yet)", async () => {
    const res = await close(
      [
        ...S,
        { type: "tool-input-start", toolCallId: "c1", toolName: "weather" },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"city":"Pa' },
        { type: "tool-input-start", toolCallId: "h1", toolName: "hermes__terminal", dynamic: true, providerExecuted: true },
        { type: "tool-input-delta", toolCallId: "h1", inputTextDelta: '{"command":"ls' },
        { type: "tool-input-start", toolCallId: "c3", toolName: "search" },
        { type: "tool-input-start", toolCallId: "h2", toolName: "hermes__read", dynamic: true },
      ],
      "cancelled",
    );
    expect(res.chunks.map((c) => c.type)).toEqual(["tool-output-error", "tool-output-error", "tool-input-error", "tool-input-error"]);
    expect(toolPart(res.message, "h2")).toMatchObject({ type: "dynamic-tool", toolName: "hermes__read", state: "output-error", input: {} });
    expect(toolPart(res.message, "c1")).toMatchObject({ state: "output-error", errorText: "Interrupted.", input: { city: "Pa" } });
    expect(toolPart(res.message, "h1")).toMatchObject({ state: "output-error", errorText: "Interrupted.", input: { command: "ls" } });
    // No input streamed yet: {} (the SDK keeps a static tool's tool-input-error input as rawInput).
    expect(toolPart(res.message, "c3")).toMatchObject({ state: "output-error", errorText: "Interrupted.", rawInput: {} });
  });

  it("input-streaming in an earlier step is closed with tool-output-error (tool-input-error only sees the current step)", async () => {
    const res = await close(
      [
        ...S,
        { type: "tool-input-start", toolCallId: "c1", toolName: "weather" },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"city":"Paris"}' },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "hi" },
        { type: "text-end", id: "t" },
      ],
      "failed",
    );
    expect(res.chunks).toEqual([{ type: "tool-output-error", toolCallId: "c1", errorText: "Interrupted." }]);
    expect(res.message.parts.filter((p) => "toolCallId" in p)).toHaveLength(1);
  });

  it("streaming text and reasoning end (with the stream ids the log left open)", async () => {
    const log: UIMessageChunk[] = [
      ...S,
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "hmm" },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "Hel" },
    ];
    expect(openStreamIdsOf(log)).toEqual({ text: ["0"], reasoning: ["r1"] });
    const res = await close(log, "cancelled");
    expect(res.chunks).toEqual([
      { type: "text-end", id: "0" },
      { type: "reasoning-end", id: "r1" },
    ]);
    expect(res.message.parts.filter((p) => p.type === "text" || p.type === "reasoning").map((p) => (p as { state: string }).state)).toEqual(["done", "done"]);
    // Without the ids (a saved message only), the parts are still marked done; no end is guessed.
    const bare = closeOpenParts(await reduce(log), "cancelled");
    expect(bare.chunks).toEqual([]);
    expect(bare.changed).toBe(true);
    expect(bare.message.parts.every((p) => !("state" in p) || p.state === "done")).toBe(true);
  });

  it("openStreamIdsOf follows ends and reset-step like the reducer", () => {
    expect(
      openStreamIdsOf([
        { type: "text-start", id: "a" },
        { type: "reasoning-start", id: "r" },
        { type: "reset-step" },
        { type: "text-start", id: "b" },
        { type: "text-start", id: "c" },
        { type: "text-end", id: "c" },
      ]),
    ).toEqual({ text: ["b"], reasoning: [] });
  });

  it("approval-requested is kept while waiting, else denied with a reason", async () => {
    const log = [...S, staticCall, hermesCall, ...ask("c1", "a1"), { type: "tool-approval-request", approvalId: "a2", toolCallId: "h1" } as UIMessageChunk];
    const waiting = await close(log, "waiting");
    expect(waiting).toMatchObject({ chunks: [], changed: false });
    expect(toolPart(waiting.message, "c1").state).toBe("approval-requested");

    const cancelled = await close(log, "cancelled");
    expect(cancelled.chunks).toEqual([
      { type: "tool-approval-response", approvalId: "a1", approved: false, reason: "Not answered." },
      { type: "tool-output-denied", toolCallId: "c1" },
      { type: "tool-approval-response", approvalId: "a2", approved: false, reason: "Not answered." },
      { type: "tool-output-denied", toolCallId: "h1" },
    ]);
    const superseded = await close(log, "cancelled", { deniedReason: "Not answered before the next message." });
    expect(toolPart(superseded.message, "h1")).toMatchObject({
      state: "output-denied",
      approval: { id: "a2", approved: false, reason: "Not answered before the next message." },
    });
  });

  it("a finished message is left alone", async () => {
    const res = await close(
      [
        ...S,
        staticCall,
        { type: "tool-output-available", toolCallId: "c1", output: { temp: 20 } },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "20" },
        { type: "text-end", id: "0" },
        { type: "finish-step" },
        { type: "finish" },
      ],
      "succeeded",
    );
    expect(res).toMatchObject({ chunks: [], changed: false });
  });
});
