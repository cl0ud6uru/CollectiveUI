import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { streamText, wrapLanguageModel, toUIMessageStream, readUIMessageStream, type ToolSet } from "ai";
import type { AiApp, UsageEvent } from "@/db/schema";
import type { ToolSettings } from "@/lib/settings";
import { nativeSearchCapability, nativeSearchPolicy, nativeSearchSettingsSchema, NATIVE_SEARCH_KEY } from "@/lib/native-search-policy";
import { nativeSearchMiddleware, type SearchBudget } from "@/lib/llm/native-search";
import { newUsageScope, setUsageWriter } from "@/lib/llm/usage";
import { usageMiddleware } from "@/lib/llm/middleware";
import { searchResponse } from "../fixtures/openai-search";

vi.mock("@/db", () => ({ db: {} }));
const app = { provider: "openai", model: "gpt-4.1", credentialMode: "org", supportsTools: true } as AiApp;
const policy = { disabledTools: [], enforcedApproval: [], fetchAllowlist: [], nativeSearch: { enabled: true, maxCalls: 2, allowedDomains: [] } } as unknown as ToolSettings;
afterEach(() => setUsageWriter(null));

describe("native search policy before hosted dispatch", () => {
  it("requires verified official API models and endpoints", () => {
    expect(nativeSearchCapability(app, null)).toBeNull();
    expect(nativeSearchCapability(app, "https://api.openai.com/v1/")).toBeNull();
    for (const provider of ["azure", "openai-compatible", "chatgpt", "hermes", "anthropic"] as const) expect(nativeSearchCapability({ ...app, provider }, null)).toBeTruthy();
    for (const model of ["gpt-4.1-nano", "gpt-5-nano", "gpt-future", "gpt-4o-search-preview", "gpt-5-search-api", "gpt-4.1-custom"]) expect(nativeSearchCapability({ ...app, model }, null)).toBeTruthy();
    for (const url of ["http://api.openai.com/v1", "https://proxy.test/v1", "https://api.openai.com.evil.test/v1", "https://api.openai.com/v1?proxy=x", "https://user@api.openai.com/v1"]) expect(nativeSearchCapability(app, url)).toBeTruthy();
    expect(nativeSearchCapability({ ...app, supportsTools: false }, null)).toBeTruthy();
    expect(nativeSearchCapability({ ...app, credentialMode: "user" }, null)).toBeTruthy();
  });
  it("fails closed on restrictions and unsupported per-call approvals", () => {
    expect(nativeSearchPolicy(policy)).toBeNull();
    expect(nativeSearchPolicy({ ...policy, nativeSearch: undefined })).toBeTruthy();
    expect(nativeSearchPolicy(policy, "ask")).toContain("cannot pause");
    for (const key of [NATIVE_SEARCH_KEY, "web_search", "fetch_url"]) {
      expect(nativeSearchPolicy({ ...policy, disabledTools: [key] })).toBeTruthy();
      expect(nativeSearchPolicy({ ...policy, enforcedApproval: [key] })).toBeTruthy();
    }
    expect(nativeSearchPolicy({ ...policy, fetchAllowlist: ["example.com"] })).toContain("local web-page allowlist");
  });
  it("validates hosted domains and finite call caps", () => {
    expect(nativeSearchSettingsSchema.safeParse({ enabled: true, maxCalls: 2, allowedDomains: ["example.com"] }).success).toBe(true);
    for (const maxCalls of [0, -1, 11, 1.5, NaN]) expect(nativeSearchSettingsSchema.safeParse({ enabled: true, maxCalls, allowedDomains: [] }).success).toBe(false);
    for (const domain of ["https://example.com", "example.com/path", "*.example.com", "localhost", "127.0.0.1", "example.com:80"]) expect(nativeSearchSettingsSchema.safeParse({ enabled: true, maxCalls: 1, allowedDomains: [domain] }).success).toBe(false);
  });
});

async function fixture({ calls = 1, interrupted = false, remaining = 2, denied = false, off = false } = {}) {
  const rows: UsageEvent[] = [];
  setUsageWriter(async row => { rows.push(row); });
  const bodies: Record<string, unknown>[] = [];
  const scope = newUsageScope({ messageId: "message", runId: "run" });
  const ctx = { purpose: "chat" as const, billingSource: "org" as const, providerKind: "openai" as const, model: "gpt-4.1", appId: "app", userId: "owner", conversationId: "conversation", scope };
  const settle = vi.fn(async () => {});
  const budget: SearchBudget = { reserve: vi.fn(async () => remaining), settle };
  const provider = createOpenAI({ apiKey: "fixture-only", baseURL: "https://api.openai.com/v1", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return searchResponse({ calls: off || !remaining ? 0 : calls, interrupted });
  } });
  const authorize = vi.fn(async () => { if (denied) throw new Error("Policy revoked"); });
  const model = wrapLanguageModel({ model: provider.responses("gpt-4.1"), middleware: [nativeSearchMiddleware(ctx, { maxCalls: 2, authorize }, budget), usageMiddleware(ctx)] });
  const tools: ToolSet = off ? {} : { [NATIVE_SEARCH_KEY]: openai.tools.webSearch({ filters: { allowedDomains: ["example.com"] } }) };
  const errors: unknown[] = [];
  const result = streamText({ model, prompt: "fixture only", tools, maxRetries: 0, onError: ({ error }) => { errors.push(error); } });
  let message;
  for await (const current of readUIMessageStream({ stream: toUIMessageStream({ stream: result.stream, tools, sendSources: true, onError: e => { errors.push(e); return "Fixture failure"; } }) })) message = current;
  await Promise.all(scope.pending);
  return { rows, bodies, message, errors, budget, authorize };
}

describe("SDK Responses wire fixtures", () => {
  it("sends hosted filters and max_tool_calls, streams citations and records calls apart from tokens", async () => {
    const f = await fixture();
    expect(f.bodies[0].max_tool_calls).toBe(2);
    expect(f.bodies[0].tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["example.com"] } }]);
    expect(f.message?.parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "source-url", url: "https://example.com/weather" }), expect.objectContaining({ type: "tool-openai_web_search", state: "output-available" })]));
    expect(f.rows.filter(r => r.hostedSearchCalls)).toEqual([expect.objectContaining({ hostedSearchCalls: 1, searchToolCostEstimateMicros: 10000, inputTokens: null, outputTokens: null, userId: "owner" })]);
    expect(f.rows.filter(r => !r.hostedSearchCalls)).toEqual([expect.objectContaining({ inputTokens: 100, outputTokens: 20 })]);
    expect(f.budget.settle).toHaveBeenCalledWith(2, 1);
  });
  it("off does not attach, reserve, authorize or charge search", async () => {
    const f = await fixture({ off: true });
    expect(f.bodies[0].tools).toBeUndefined();
    expect(f.budget.reserve).not.toHaveBeenCalled();
    expect(f.rows.some(r => r.hostedSearchCalls)).toBe(false);
  });
  it("auto may use zero calls and releases unused allowance", async () => {
    const f = await fixture({ calls: 0 });
    expect(f.budget.settle).toHaveBeenCalledWith(2, 0);
    expect(f.rows.some(r => r.hostedSearchCalls)).toBe(false);
  });
  it("exhausted budget removes hosted search", async () => {
    const f = await fixture({ remaining: 0 });
    expect(f.bodies[0].tools).toBeUndefined();
    expect(f.rows.some(r => r.hostedSearchCalls)).toBe(false);
  });
  it("revocation prevents dispatch", async () => {
    const f = await fixture({ denied: true });
    expect(f.bodies).toHaveLength(0);
    expect(f.budget.reserve).not.toHaveBeenCalled();
  });
  it("interruption keeps reservation and accounts for observed calls", async () => {
    const f = await fixture({ interrupted: true });
    expect(f.budget.settle).not.toHaveBeenCalled();
    expect(f.rows.filter(r => r.hostedSearchCalls)).toHaveLength(1);
  });
  it("provider overrun fails closed and retains the reservation", async () => {
    const f = await fixture({ calls: 3 });
    expect(f.errors.length).toBeGreaterThan(0);
    expect(f.budget.settle).not.toHaveBeenCalled();
    expect(f.rows.filter(r => r.hostedSearchCalls)).toHaveLength(3);
  });
});
