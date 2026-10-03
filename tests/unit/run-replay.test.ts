import { jsonSchema, lastAssistantMessageIsCompleteWithApprovalResponses, tool, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { applyApprovalDecisions } from "@/lib/agent/approval-merge";
import type { PortalUIMessage } from "@/lib/chat/store";
import { closeOpenParts, liveFilter, openStreamIdsOf, replayFilter } from "@/lib/runs/replay";
import { FINAL_STATUSES } from "@/lib/runs/types";
import { applyFilter, eventLog, finishPart, reduce, runSegment, stored, text, userMessage } from "./helpers/run-streams";

const MID = "msg_a";
const user = userMessage("u1", "What's the weather in Paris? Then delete /tmp/x.");

const weather = {
  weather: tool({
    inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
    execute: async ({ city }) => ({ city, temp: 20 }),
  }),
};

/** A portal tool that needs approval: segment 0 asks, segment 1 runs it (approved) or not, then the model answers. */
async function portalFlow(approved: boolean) {
  const seg0 = await runSegment({
    history: [user],
    messageId: MID,
    title: "Paris weather",
    tools: weather,
    toolApproval: { weather: "user-approval" },
    calls: [
      [
        ...text("0", "Let me check."),
        { type: "tool-input-start", id: "call_1", toolName: "weather" },
        { type: "tool-input-delta", id: "call_1", delta: '{"city":' },
        { type: "tool-input-delta", id: "call_1", delta: '"Paris"}' },
        { type: "tool-input-end", id: "call_1" },
        { type: "tool-call", toolCallId: "call_1", toolName: "weather", input: '{"city":"Paris"}' },
        finishPart("tool-calls"),
      ],
    ],
  });
  return continueFlow(seg0, approved, [[...text("0", approved ? "It is 20 degrees." : "OK, I won't check."), finishPart("stop")]], weather);
}

/** A Hermes-style provider-executed dynamic tool: the provider asks for approval and runs the tool itself. */
async function hermesFlow(approved: boolean) {
  const call: LanguageModelV4StreamPart = {
    type: "tool-call",
    toolCallId: "hc_1",
    toolName: "hermes__terminal",
    input: '{"command":"rm -rf /tmp/x"}',
    providerExecuted: true,
    dynamic: true,
  };
  const seg0 = await runSegment({
    history: [user],
    messageId: MID,
    calls: [[...text("0", "Deleting it."), call, { type: "tool-approval-request", approvalId: "hap_1", toolCallId: "hc_1" }, finishPart("tool-calls")]],
  });
  const result: LanguageModelV4StreamPart[] = approved
    ? [{ type: "tool-result", toolCallId: "hc_1", toolName: "hermes__terminal", result: { output: "done", exit_code: 0 }, dynamic: true }]
    : [];
  return continueFlow(seg0, approved, [[...result, ...text("0", approved ? "Deleted." : "OK, not deleting."), finishPart("stop")]]);
}

async function continueFlow(seg0: Awaited<ReturnType<typeof runSegment>>, approved: boolean, calls: LanguageModelV4StreamPart[][], tools?: typeof weather) {
  // The pause: nothing to close (the approval stays requested), then segment-end.
  const pause = closeOpenParts(seg0.message, "waiting", { openIds: openStreamIdsOf(seg0.chunks) });
  expect(pause.changed).toBe(false);
  const approvalId = (seg0.chunks.find((c) => c.type === "tool-approval-request") as { approvalId: string }).approvalId;
  // The web's continuation: the decision applied to the saved message, and appended as a chunk.
  const decisions = new Map([[approvalId, { approved, reason: approved ? undefined : "not now" }]]);
  const answered: PortalUIMessage = stored({ ...seg0.message, parts: applyApprovalDecisions(seg0.message.parts as never[], decisions).parts });
  const responses: UIMessageChunk[] = [{ type: "tool-approval-response", approvalId, approved, ...(approved ? {} : { reason: "not now" }) }];
  const seg1 = await runSegment({
    history: [user, answered],
    messageId: MID,
    calls,
    tools,
    toolApproval: tools ? { weather: "user-approval" } : undefined,
    createdAt: 2,
  });
  const finish = closeOpenParts(seg1.message, "succeeded", { openIds: openStreamIdsOf(seg1.chunks) });
  expect(finish.changed).toBe(false);

  const log = eventLog().chunks(0, seg0.chunks).chunks(0, pause.chunks).end(0).chunks(0, responses);
  const boundary = log.events.length;
  log.chunks(1, seg1.chunks).chunks(1, finish.chunks).end(1);
  return { seg0, seg1, answered, responses, boundary, events: log.events };
}

const starts = (chunks: UIMessageChunk[]) => chunks.filter((c) => c.type === "start").length;
const autoSends = (m: PortalUIMessage) => lastAssistantMessageIsCompleteWithApprovalResponses({ messages: [user, m] });

describe.each([
  ["portal tool", portalFlow],
  ["Hermes provider-executed dynamic tool", hermesFlow],
] as const)("replay: two-segment approval flow (%s)", (_name, flow) => {
  it.each([true, false])("approved=%s: the replay rebuilds the saved message with exactly one start", async (approved) => {
    const f = await flow(approved);
    const replay = applyFilter(replayFilter(1), f.events);
    expect(replay.ended).toBe(true);
    expect(starts(replay.chunks)).toBe(1);
    expect(replay.chunks.some((c) => c.type.startsWith("data-"))).toBe(false);
    // Earlier segments' finish is not the end of the message.
    expect(replay.chunks.filter((c) => c.type === "finish")).toHaveLength(1);
    const rebuilt = await reduce(replay.chunks);
    expect(stored(rebuilt)).toEqual(stored(f.seg1.message));
    expect(rebuilt.parts.find((p) => "toolCallId" in p)).toMatchObject({ state: approved ? "output-available" : "output-denied" });
    expect(rebuilt.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text)).toHaveLength(2);
    expect(rebuilt.metadata).toMatchObject({ createdAt: 2, model: "mock", outputTokens: expect.any(Number) });
    expect(autoSends(rebuilt)).toBe(false);
  });

  it("while waiting, the replay ends at the pause with the approval card", async () => {
    const f = await flow(true);
    const replay = applyFilter(replayFilter(0), f.events);
    expect(replay.ended).toBe(true);
    const rebuilt = await reduce(replay.chunks);
    expect(stored(rebuilt)).toEqual(stored(f.seg0.message));
    expect(rebuilt.parts.some((p) => "state" in p && p.state === "approval-requested")).toBe(true);
    expect(autoSends(rebuilt)).toBe(false);
  });

  it("the live tail of the continuation continues the answered message", async () => {
    const f = await flow(true);
    const live = applyFilter(liveFilter(1), f.events.slice(f.boundary));
    expect(live.ended).toBe(true);
    expect(stored(await reduce(live.chunks, f.answered))).toEqual(stored(f.seg1.message));
  });

  it.each(FINAL_STATUSES)("a queued continuation that ends %s before it ran replays closed (no auto-send)", async (status) => {
    const f = await flow(true);
    const closing = closeOpenParts(f.answered, status);
    expect(closing.changed).toBe(true);
    const log = eventLog().chunks(0, f.seg0.chunks).end(0).chunks(0, f.responses).chunks(1, closing.chunks).end(1);
    const replay = applyFilter(replayFilter(1), log.events);
    expect(starts(replay.chunks)).toBe(1);
    const rebuilt = await reduce(replay.chunks);
    expect(stored(rebuilt)).toEqual(stored(closing.message));
    expect(rebuilt.parts.find((p) => "toolCallId" in p)).toMatchObject({ state: "output-error", errorText: "Stopped before it ran." });
    expect(autoSends(rebuilt)).toBe(false);
  });

  it.each(FINAL_STATUSES)("a waiting run that ends %s replays with the approval denied", async (status) => {
    const f = await flow(true);
    const closing = closeOpenParts(f.seg0.message, status, { deniedReason: "Not answered before the next message." });
    const log = eventLog().chunks(0, f.seg0.chunks).chunks(0, closing.chunks).end(0);
    const rebuilt = await reduce(applyFilter(replayFilter(0), log.events).chunks);
    expect(stored(rebuilt)).toEqual(stored(closing.message));
    expect(rebuilt.parts.find((p) => "toolCallId" in p)).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: "Not answered before the next message." },
    });
    expect(autoSends(rebuilt)).toBe(false);
  });

  it("a continuation interrupted mid-text replays with the text ended", async () => {
    const f = await flow(true);
    const cut = f.seg1.chunks.findIndex((c) => c.type === "text-delta") + 1;
    const partial = f.seg1.chunks.slice(0, cut);
    const saved = await reduce(partial, f.answered);
    const closing = closeOpenParts(saved, "interrupted", { openIds: openStreamIdsOf(partial) });
    expect(closing.chunks).toContainEqual({ type: "text-end", id: "0" });
    const log = eventLog().chunks(0, f.seg0.chunks).end(0).chunks(0, f.responses).chunks(1, partial).chunks(1, closing.chunks).end(1);
    const rebuilt = await reduce(applyFilter(replayFilter(1), log.events).chunks);
    expect(stored(rebuilt)).toEqual(stored(closing.message));
    expect(rebuilt.parts.every((p) => !("state" in p) || p.state !== "streaming")).toBe(true);
    expect(autoSends(rebuilt)).toBe(false);
  });
});

describe("replay and live filters", () => {
  const chunk = (seq: number, segment: number, c: UIMessageChunk, transient = false) => ({ seq, segment, kind: "chunk" as const, chunk: c, transient });
  const end = (seq: number, segment: number) => ({ seq, segment, kind: "segment-end" as const, chunk: null, transient: false });
  const title: UIMessageChunk = { type: "data-title", data: { title: "T" }, transient: true } as never;

  it("transient chunks are dropped in replay only", () => {
    const events = [chunk(1, 0, { type: "start", messageId: MID }), chunk(2, 0, title, true), end(3, 0)];
    expect(applyFilter(replayFilter(0), events).chunks.map((c) => c.type)).toEqual(["start"]);
    expect(applyFilter(liveFilter(0), events).chunks.map((c) => c.type)).toEqual(["start", "data-title"]);
  });

  it("a replay drops only the backlog's transient chunks: one written after it started arrives live", () => {
    const events = [chunk(1, 0, { type: "start", messageId: MID }), chunk(2, 0, title, true), chunk(3, 0, title, true), end(4, 0)];
    // The replay started when the log ended at seq 2: the title at seq 3 is new.
    expect(applyFilter(replayFilter(0, 2), events).chunks.map((c) => c.type)).toEqual(["start", "data-title"]);
  });

  it("skips earlier segment ends and ends at the target segment's end", () => {
    const events = [
      chunk(1, 0, { type: "start", messageId: MID }),
      chunk(2, 0, { type: "abort" }),
      end(3, 0),
      chunk(4, 1, { type: "start", messageId: MID }),
      chunk(5, 1, { type: "finish" }),
      end(6, 1),
      chunk(7, 2, { type: "start", messageId: MID }),
    ];
    expect(applyFilter(replayFilter(1), events)).toEqual({ chunks: [{ type: "start", messageId: MID }, { type: "finish" }], ended: true });
    // A target below the run's segment still ends at the first segment-end at or above it.
    expect(applyFilter(replayFilter(0), events).ended).toBe(true);
    expect(applyFilter(replayFilter(0), events).chunks).toEqual([{ type: "start", messageId: MID }, { type: "abort" }]);
  });

  it("a dropped start or finish keeps its metadata", () => {
    const events = [
      chunk(1, 0, { type: "start", messageId: MID, messageMetadata: { createdAt: 1 } }),
      chunk(2, 0, { type: "finish", messageMetadata: { outputTokens: 3 } }),
      end(3, 0),
      chunk(4, 1, { type: "start", messageId: MID, messageMetadata: { createdAt: 2 } }),
      chunk(5, 1, { type: "start", messageId: MID }),
    ];
    expect(applyFilter(replayFilter(1), events).chunks).toEqual([
      { type: "start", messageId: MID, messageMetadata: { createdAt: 1 } },
      { type: "message-metadata", messageMetadata: { outputTokens: 3 } },
      { type: "message-metadata", messageMetadata: { createdAt: 2 } },
    ]);
  });

  it("filters are stateful per stream", () => {
    const events = [chunk(1, 0, { type: "start", messageId: MID }), end(2, 0)];
    const f = replayFilter(0);
    expect(f(events[0])).toEqual(events[0].chunk);
    expect(f(events[0])).toBeNull();
    expect(replayFilter(0)(events[0])).toEqual(events[0].chunk);
  });
});
