import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { UsageEvent } from "@/db/schema";
vi.mock("@/db", () => ({ db: {} }));
import { usageMiddleware } from "@/lib/llm/middleware";
import { newUsageScope, setUsageWriter, type UsageContext } from "@/lib/llm/usage";

const rows: UsageEvent[] = [];
const usage = { inputTokens: { total: 11, noCache: 6, cacheRead: 5, cacheWrite: 0 }, outputTokens: { total: 4, text: 3, reasoning: 1 } };
const params = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Synthetic prompt" }] }] };
const context = (extra: Partial<UsageContext> = {}): UsageContext => ({ purpose: "chat", providerKind: "openai", model: "requested-model", billingSource: "org", billingRoute: "api:openai", providerConnectionId: "historical-connection", providerOrganization: "org-one", providerProject: "project-one", userId: "owner", appId: "app", conversationId: "chat", scope: newUsageScope({ runId: "run", messageId: "reply" }), ...extra });
const model = (stream: Parameters<typeof convertArrayToReadableStream>[0] | ReadableStream, ctx = context(), skipUnknown = false) =>
  wrapLanguageModel({ model: new MockLanguageModelV4({ doStream: async () => ({ stream: Array.isArray(stream) ? convertArrayToReadableStream(stream) : stream }) }), middleware: usageMiddleware(ctx, { skipUnknown }) });
const drain = async (stream: ReadableStream) => { const reader = stream.getReader(); const parts = []; for (;;) { const part = await reader.read(); if (part.done) return parts; parts.push(part.value); } };
beforeEach(() => { rows.length = 0; setUsageWriter(async row => { rows.push(row); }); });
afterEach(() => { setUsageWriter(null); });

describe("usage stream terminal accounting", () => {
  it("records a finish exactly once and forwards its reported counters and original stream parts", async () => {
    const parts = [{ type: "text-delta", id: "t", delta: "answer" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
    const result = await model(parts).doStream(params);
    expect(await drain(result.stream)).toEqual(parts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "complete", inputTokens: 11, outputTokens: 4, cacheReadTokens: 5, reasoningTokens: 1, messageId: "reply", runId: "run", providerConnectionId: "historical-connection", providerOrganization: "org-one", providerProject: "project-one" });
  });
  it("records null counters when the source closes without a finish", async () => {
    await drain((await model([{ type: "text-delta", id: "t", delta: "partial" }]).doStream(params)).stream);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "incomplete", inputTokens: null, outputTokens: null, cacheReadTokens: null, reasoningTokens: null });
  });
  it("records a source error without swallowing or duplicating it", async () => {
    let calls = 0;
    const source = new ReadableStream({ pull(controller) { if (calls++ === 0) controller.enqueue({ type: "text-delta", id: "t", delta: "partial" }); else controller.error(new Error("synthetic upstream drop")); } });
    await expect(drain((await model(source).doStream(params)).stream)).rejects.toThrow("synthetic upstream drop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "incomplete", inputTokens: null, outputTokens: null });
  });
  it("records cancellation once, forwards its reason, and never estimates the partial text's tokens", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream({ start(controller) { controller.enqueue({ type: "text-delta", id: "t", delta: "partial" }); }, cancel });
    const result = await model(source).doStream(params), reader = result.stream.getReader();
    await reader.read();
    await reader.cancel("synthetic Stop");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("synthetic Stop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "incomplete", inputTokens: null, outputTokens: null });
  });
  it("records even if the upstream cancellation itself rejects", async () => {
    const source = new ReadableStream({ cancel() { throw new Error("synthetic cancel failure"); } });
    const result = await model(source).doStream(params);
    await expect(result.stream.cancel()).rejects.toThrow("synthetic cancel failure");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "incomplete", inputTokens: null });
  });
  it("keeps valid partial counters from an error finish and records no second terminal row", async () => {
    const parts = [{ type: "error", error: new Error("synthetic error") }, { type: "finish", finishReason: { unified: "error", raw: "error" }, usage }];
    await drain((await model(parts).doStream(params)).stream);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "incomplete", inputTokens: 11, outputTokens: 4 });
  });
  it("does not overwrite a finish if a later source failure occurs", async () => {
    let calls = 0;
    const source = new ReadableStream({ pull(controller) { if (calls++ === 0) controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }); else controller.error(new Error("after finish")); } });
    await expect(drain((await model(source).doStream(params)).stream)).rejects.toThrow("after finish");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "complete", inputTokens: 11 });
  });
  it("preserves unknown Hermes identity and its intentional skipUnknown pause policy", async () => {
    const ctx = context({ providerKind: "hermes", model: "profile-alias", billingSource: "hermes", billingRoute: "unknown:hermes" });
    await drain((await model([], ctx).doStream(params)).stream);
    expect(rows).toMatchObject([{ model: "unreported", completionStatus: "incomplete", inputTokens: null, outputTokens: null, costMicros: null }]);
    rows.length = 0;
    await drain((await model([], ctx, true).doStream(params)).stream);
    expect(rows).toHaveLength(0);
  });
  it("keeps subscription attribution and null API costs on interruption", async () => {
    await drain((await model([], context({ providerKind: "chatgpt", billingSource: "chatgpt_plan", billingRoute: "subscription:chatgpt", credentialId: "personal-binding" })).doStream(params)).stream);
    expect(rows).toMatchObject([{ completionStatus: "incomplete", billingSource: "chatgpt_plan", billingRoute: "subscription:chatgpt", credentialId: "personal-binding", costMicros: null, searchToolCostEstimateMicros: null }]);
  });
});
