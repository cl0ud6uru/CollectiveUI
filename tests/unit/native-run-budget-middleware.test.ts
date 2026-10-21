import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, embed, generateText, tool, wrapEmbeddingModel, wrapLanguageModel } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, embeddingApp: vi.fn(), embeddingDispatch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite"); const { drizzle } = await import("drizzle-orm/pglite"); const schema = await import("@/db/schema");
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/llm/apps", () => ({ embeddingApp: fixture.embeddingApp }));
vi.mock("@/lib/llm/resolve", () => ({ resolveEmbeddingDispatch: fixture.embeddingDispatch }));
import { embedTexts } from "@/lib/llm/embeddings";
import { db, schema } from "@/db";
import { nativeEmbeddingBudgetMiddleware, nativeRunBudgetMiddleware } from "@/lib/llm/run-budget-middleware";
import { usageMiddleware } from "@/lib/llm/middleware";
import { newUsageScope, type UsageContext } from "@/lib/llm/usage";
import { requestDecision } from "@/lib/llm/providers/decisions";
import { nativeBudgetEnvelope } from "@/lib/llm/run-budget-policy";
import type { ProviderContext } from "@/lib/llm/providers/types";
import type { NativeRunBudgetPolicy } from "@/lib/llm/run-budget-policy";

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const response = () => ({ content: [{ type: "text" as const, text: "Fixture result" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const policy: NativeRunBudgetPolicy = { enabled: true, maxTokens: 100_000, maxCostMicros: 1_000_000, maxInputTokensPerCall: 50_000, maxOutputTokensPerCall: 64,
  routes: [{ provider: "openai", model: "gpt-6-luna", inputContract: "conservative-text-v1", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 }, { provider: "openai", model: "fixture", inputContract: "conservative-text-v1", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
    { provider: "openai", model: "fixture-embed", inputContract: "conservative-text-v1", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 0 }] };
const context = (runId = "root", rootBudgetId = "root-reply"): UsageContext => ({ purpose: "chat", providerKind: "openai", model: "fixture", billingSource: "org", billingRoute: "api:openai", userId: "actor", appId: "app", scope: newUsageScope({ runId, messageId: `${runId}-reply`, rootBudgetId }) });
const wrapped = (model: MockLanguageModelV4, ctx: UsageContext) => wrapLanguageModel({ model, middleware: [usageMiddleware(ctx), nativeRunBudgetMiddleware(ctx)] });
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(file => file.endsWith(".sql")).sort()) await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 60000);
beforeEach(async () => {
  await fixture.client!.exec("TRUNCATE users CASCADE");
  await db.insert(schema.users).values({ id: "actor", name: "Actor", upn: "actor@fixture.invalid", authSource: "ldap" });
  vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify(policy));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected live provider request"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await fixture.client!.close(); });

describe("native budget admission around the actual AI SDK dispatch", () => {
  it("counts real Zod .describe metadata after SDK JSON Schema conversion before dispatch", async () => {
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, maxInputTokensPerCall: 10_000 }));
    const dispatch = vi.fn(async (_params: unknown) => { void _params; return response(); });
    const model = wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), context());
    await expect(generateText({ model, instructions: "System instructions", prompt: "Fixture", maxRetries: 0,
      tools: { lookup: tool({ description: "Lookup fixture", inputSchema: z.object({ query: z.string().describe("provider-visible-description ".repeat(800)) }) }) },
    })).rejects.toThrow("per-call budget ceiling");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.select().from(schema.nativeRunBudgetAttempts)).toHaveLength(0);
  });
  it("clamps output before the provider and settles actual usage, preserving default-off requests", async () => {
    const dispatch = vi.fn(async (_params: unknown) => { void _params; return response(); }); const ctx = context();
    const model = wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), ctx);
    await generateText({ model, prompt: "Fixture", maxOutputTokens: 9_999, maxRetries: 0 });
    await Promise.all(ctx.scope!.pending);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 64 });
    expect((await db.select().from(schema.nativeRunBudgets))[0]).toMatchObject({ usedTokens: 5, usedCostMicros: 7, reservedTokens: 0 });
    vi.stubEnv("NATIVE_RUN_BUDGET", "");
    const off = vi.fn(async (_params: unknown) => { void _params; return response(); });
    await generateText({ model: wrapped(new MockLanguageModelV4({ doGenerate: off }), context("off", "off-root")), prompt: "Fixture", maxOutputTokens: 9_999 });
    expect(off.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 9_999 });
  });
  it("dispatches child attempts with the persisted root cap even after process configuration is disabled", async () => {
    const dispatch = vi.fn(async (_params: unknown) => { void _params; return response(); });
    await generateText({ model: wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), context()), prompt: "Fixture", maxRetries: 0 });
    vi.stubEnv("NATIVE_RUN_BUDGET", "");
    const child = wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), context("child"));
    await generateText({ model: child, prompt: "Fixture", maxOutputTokens: 9999, maxRetries: 0 });
    expect(dispatch.mock.calls[1][0]).toMatchObject({ maxOutputTokens: 64 });
    expect((await db.select().from(schema.nativeRunBudgets))[0]).toMatchObject({ usedTokens: 10, reservedTokens: 0 });
    await db.update(schema.nativeRunBudgets).set({ exhausted: true });
    await expect(generateText({ model: child, prompt: "Fixture", maxRetries: 0 })).rejects.toThrow("configured company model budget");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("gives SDK retries separate receipts and retains the failed attempt instead of refunding it", async () => {
    const dispatch = vi.fn().mockRejectedValueOnce(new APICallError({ message: "Synthetic retry", url: "https://fixture.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true, responseHeaders: { "retry-after": "0" } })).mockResolvedValueOnce(response());
    const ctx = context();
    await generateText({ model: wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), ctx), prompt: "Fixture", maxRetries: 1 });
    await Promise.all(ctx.scope!.pending);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const receipts = await db.select().from(schema.nativeRunBudgetAttempts);
    expect(receipts.map(row => row.state).sort()).toEqual(["settled", "uncertain"]);
    const root = (await db.select().from(schema.nativeRunBudgets))[0];
    expect(root.usedTokens).toBe(5); expect(root.reservedTokens).toBeGreaterThan(0);
    expect(await db.select().from(schema.usageEvents)).toHaveLength(2);
  });
  it("keeps an interrupted stream reserved and settles a completed stream with reported counters", async () => {
    const ctx = context();
    const interrupted = wrapped(new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "text-delta", id: "t", delta: "partial" }); } }) }) }), ctx);
    const first = await interrupted.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Fixture" }] }] });
    const reader = first.stream.getReader(); await reader.read(); await reader.cancel();
    await Promise.all(ctx.scope!.pending);
    expect(await db.select().from(schema.usageEvents)).toMatchObject([{ completionStatus: "incomplete", inputTokens: null, outputTokens: null }]);
    expect(await db.select().from(schema.usageEvents)).toHaveLength(1);
    await vi.waitFor(async () => expect((await db.select().from(schema.nativeRunBudgetAttempts))[0].state).toBe("uncertain"));
    expect((await db.select().from(schema.nativeRunBudgets))[0].reservedTokens).toBeGreaterThan(0);
    const completed = wrapped(new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) }) }), context("child"));
    const second = await completed.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Fixture" }] }] });
    const completedReader = second.stream.getReader(); while (!(await completedReader.read()).done) { /* Drain completion. */ }
    await Promise.all(ctx.scope!.pending);
    expect(await db.select().from(schema.usageEvents)).toHaveLength(2);
    expect((await db.select().from(schema.nativeRunBudgets))[0]).toMatchObject({ usedTokens: 5 });
  });
  it("holds an error-finished stream while recording its partial usage once", async () => {
    const ctx = context();
    const model = wrapped(new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: "error", error: new Error("Synthetic stream failure") },
      { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
    ]) }) }), ctx);
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Fixture" }] }] });
    const reader = result.stream.getReader(); while (!(await reader.read()).done) { /* Drain error finish. */ }
    await Promise.all(ctx.scope!.pending);
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: "uncertain", inputTokens: 3, outputTokens: 2 });
    expect((await db.select().from(schema.nativeRunBudgets))[0].reservedTokens).toBeGreaterThan(0);
    expect(await db.select().from(schema.usageEvents)).toHaveLength(1);
    expect((await db.select().from(schema.usageEvents))[0]).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });
  it("includes embedding calls in the same root and settles their actual token counts", async () => {
    const ctx = { ...context("embedding"), purpose: "embedding" as const, model: "fixture-embed" };
    const model = wrapEmbeddingModel({ model: new MockEmbeddingModelV4({ doEmbed: async () => ({ embeddings: [[0.2]], usage: { tokens: 7 }, warnings: [] }) }), middleware: nativeEmbeddingBudgetMiddleware(ctx) });
    await embed({ model, value: "Fixture", maxRetries: 0 });
    expect((await db.select().from(schema.nativeRunBudgets))[0]).toMatchObject({ usedTokens: 7, usedCostMicros: 7, reservedTokens: 0 });
  });
  it("accounts each actual embedTexts batch on the same selected connection and root", async () => {
    fixture.embeddingApp.mockResolvedValue({ id: "embedding-app", provider: "openai", embeddingModel: "fixture-embed" });
    const model = new MockEmbeddingModelV4({ maxEmbeddingsPerCall: 1, doEmbed: async () => ({ embeddings: [[0.2]], usage: { tokens: 7 }, warnings: [] }) });
    fixture.embeddingDispatch.mockResolvedValue({ model, attribution: { billingRoute: "api:openai", providerConnectionId: "embedding-connection", providerOrganization: "fixture-org", providerProject: "fixture-project" } });
    const ctx = context("memory");
    await expect(embedTexts(["first", "second"], { userId: "actor", conversationId: null }, { usage: ctx.scope, maxRetries: 0 })).resolves.toEqual([[0.2], [0.2]]);
    vi.stubEnv("NATIVE_RUN_BUDGET", "");
    await embedTexts(["third"], { userId: "actor" }, { usage: ctx.scope, maxRetries: 0 });
    expect((await db.select().from(schema.nativeRunBudgets))[0]).toMatchObject({ rootMessageId: "root-reply", usedTokens: 21, reservedTokens: 0 });
    const receipts = await db.select().from(schema.nativeRunBudgetAttempts);
    expect(receipts).toHaveLength(3); expect(receipts.every(row => row.state === "settled")).toBe(true);
    const rows = await db.select().from(schema.usageEvents);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.providerConnectionId === "embedding-connection" && row.messageId === "memory-reply" && row.inputTokens === 7)).toBe(true);
  });
  it("reserves direct decision calls and retains known input with unreported output", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: "gpt-6-luna", usage: { input_tokens: 11 }, answers: [{ type: "predicate", name: "fixture", probability: 0.95 }] }));
    const provider: ProviderContext = { kind: "openai", appId: "decision-app", appName: "Fixture API", baseUrl: null, config: { store: false, reasoning: false }, secret: { type: "api-key", apiKey: "fixture-key" }, fetch: fetcher };
    const ctx = context("decision");
    expect(await requestDecision(provider, "Fixture", [{ type: "predicate", name: "fixture", instructions: "Classify fixture" }], { usage: ctx, maxOutputTokens: 64 })).toMatchObject({ status: "ok", inputTokens: 11 });
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: "uncertain", purpose: "decision", model: "gpt-6-luna", inputTokens: 11, outputTokens: null });
    expect((await db.select().from(schema.nativeRunBudgets))[0].reservedTokens).toBeGreaterThan(0);
    expect((await db.select().from(schema.usageEvents))[0]).toMatchObject({ purpose: "decision", appId: "decision-app", model: "gpt-6-luna", inputTokens: 11, outputTokens: null, messageId: "decision-reply" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).max_output_tokens).toBe(64);
    vi.stubEnv("NATIVE_RUN_BUDGET", "");
    await requestDecision(provider, "Fixture", [{ type: "predicate", name: "fixture", instructions: "Classify fixture" }], { usage: context("decision-child"), maxOutputTokens: 64 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await db.select().from(schema.nativeRunBudgetAttempts)).toHaveLength(2);
    expect((await db.select().from(schema.nativeRunBudgets))[0].reservedTokens).toBeGreaterThan(0);
  });
  it.each([undefined, 2])("retains valid decision usage independently of malformed classifier answers (output=%s)", async output => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: "gpt-6-luna", usage: { input_tokens: 3, ...(output === undefined ? {} : { output_tokens: output }) }, answers: [{ type: "predicate", name: "fixture", probability: 4 }] }));
    const provider: ProviderContext = { kind: "openai", appId: "decision-app", appName: "Fixture API", baseUrl: null, config: { store: false, reasoning: false }, secret: { type: "api-key", apiKey: "fixture-key" }, fetch: fetcher };
    expect(await requestDecision(provider, "Fixture", [{ type: "predicate", name: "fixture", instructions: "Classify fixture" }], { usage: context("decision"), maxOutputTokens: 64 })).toMatchObject({ status: "invalid", inputTokens: 3 });
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: output === undefined ? "uncertain" : "settled", inputTokens: 3, outputTokens: output ?? null });
    expect((await db.select().from(schema.usageEvents))[0]).toMatchObject({ purpose: "decision", inputTokens: 3, outputTokens: output ?? null });
    const root = (await db.select().from(schema.nativeRunBudgets))[0];
    if (output === undefined) expect(root.reservedTokens).toBeGreaterThan(0);
    else expect(root).toMatchObject({ usedTokens: 5, usedCostMicros: 7, reservedTokens: 0 });
  });
  it("shares direct decision exhaustion with root/delegate calls and releases complete reported usage", async () => {
    const questions = [{ type: "predicate" as const, name: "fixture", instructions: "Classify fixture" }];
    const body = { model: "gpt-6-luna", input: "Fixture", questions, max_output_tokens: 64 };
    const quote = nativeBudgetEnvelope(policy, policy.routes[0], body, 64);
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, maxTokens: quote.tokens, maxCostMicros: null }));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ model: "gpt-6-luna", usage: { input_tokens: 3, output_tokens: 2 }, answers: [{ type: "predicate", name: "fixture", probability: 0.95 }] }));
    const provider: ProviderContext = { kind: "openai", appId: "decision-app", appName: "Fixture API", baseUrl: null, config: { store: false, reasoning: false }, secret: { type: "api-key", apiKey: "fixture-key" }, fetch: fetcher };
    await requestDecision(provider, "Fixture", questions, { usage: context("decision"), maxOutputTokens: 64 });
    expect((await db.select().from(schema.nativeRunBudgets))[0]).toMatchObject({ usedTokens: 5, reservedTokens: 0 });
    // A second equal-sized call cannot reserve on top of the first one's actual usage.
    await expect(requestDecision(provider, "Fixture", questions, { usage: context("child"), maxOutputTokens: 64 })).rejects.toThrow("configured company model budget");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(requestDecision(provider, "Fixture", questions, { maxOutputTokens: 64 })).rejects.toThrow("root budget context");
  });
  it("holds timed-out direct decisions and records the attempted call without a retry", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const provider: ProviderContext = { kind: "openai", appId: "decision-app", appName: "Fixture API", baseUrl: null, config: { store: false, reasoning: false }, secret: { type: "api-key", apiKey: "fixture-key" }, fetch: fetcher };
    expect(await requestDecision(provider, "Fixture", [{ type: "predicate", name: "fixture", instructions: "Classify fixture" }], { usage: context("decision"), maxOutputTokens: 64, timeoutMs: 5 })).toMatchObject({ status: "timeout" });
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: "uncertain", inputTokens: null, outputTokens: null });
    expect((await db.select().from(schema.usageEvents))[0]).toMatchObject({ purpose: "decision", inputTokens: null, outputTokens: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("denies oversize instructions and unknown model prices before any provider call", async () => {
    const dispatch = vi.fn(async (_params: unknown) => { void _params; return response(); });
    const model = wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), context());
    await expect(generateText({ model, instructions: "large ".repeat(10_000), prompt: "Fixture", maxRetries: 0 })).rejects.toThrow("per-call budget ceiling");
    const unknown = { ...context("unknown", "unknown-root"), model: "unpriced" };
    await expect(generateText({ model: wrapped(new MockLanguageModelV4({ doGenerate: dispatch }), unknown), prompt: "Fixture", maxRetries: 0 })).rejects.toThrow("no approved");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
