import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBudgetCost, nativeBudgetEnvelope, nativeBudgetRoute, nativeRunBudgetPolicy, nativeTextInputBound, type NativeRunBudgetPolicy } from "@/lib/llm/run-budget-policy";

const policy: NativeRunBudgetPolicy = { enabled: true, maxTokens: 100_000, maxCostMicros: 10_000, maxInputTokensPerCall: 50_000, maxOutputTokensPerCall: 2_000,
  routes: [{ provider: "openai", model: "fixture", inputContract: "conservative-text-v1", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 }] };
afterEach(() => vi.unstubAllEnvs());
describe("disabled native run-budget policy and input envelopes", () => {
  it("stays off by default and validates explicit configuration without leaking it", () => {
    vi.stubEnv("NATIVE_RUN_BUDGET", ""); expect(nativeRunBudgetPolicy()).toBeNull();
    expect(nativeRunBudgetPolicy('{"enabled":false}')).toBeNull();
    expect(nativeRunBudgetPolicy(JSON.stringify(policy))).toEqual(policy);
    for (const raw of ["private-invalid-config", "{}", JSON.stringify({ ...policy, maxTokens: null, maxCostMicros: null }), JSON.stringify({ ...policy, routes: [...policy.routes, ...policy.routes] })]) {
      expect(() => nativeRunBudgetPolicy(raw)).toThrow("configuration is invalid");
      try { nativeRunBudgetPolicy(raw); } catch (error) { expect(String(error)).not.toContain("private-invalid-config"); }
    }
  });
  it("requires an exact model contract and explicit monetary rates; token-only policies permit unknown prices", () => {
    expect(() => nativeBudgetRoute(policy, "openai", "different")).toThrow("no approved");
    const unknown = { ...policy, routes: [{ ...policy.routes[0], inputMicrosPerMillion: undefined, outputMicrosPerMillion: undefined }] };
    expect(() => nativeBudgetRoute(unknown, "openai", "fixture")).toThrow("price is unknown");
    expect(nativeBudgetRoute({ ...unknown, maxCostMicros: null }, "openai", "fixture").model).toBe("fixture");
    expect(nativeBudgetCost(1, 1, { ...policy.routes[0], inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 })).toBe(1);
  });
  it("rejects a partial price pair even for token-only policies", () => {
    for (const missing of ["inputMicrosPerMillion", "outputMicrosPerMillion"] as const) {
      const partial = { ...policy, maxCostMicros: null, routes: [{ ...policy.routes[0], [missing]: undefined }] };
      expect(() => nativeRunBudgetPolicy(JSON.stringify(partial))).toThrow("configuration is invalid");
    }
    const unknown = { ...policy, maxCostMicros: null, routes: [{ ...policy.routes[0], inputMicrosPerMillion: undefined, outputMicrosPerMillion: undefined }] };
    expect(nativeRunBudgetPolicy(JSON.stringify(unknown))).toEqual(unknown);
  });
  it("counts system instructions, tool schemas, tool choice, output schema, metadata and Unicode bytes", () => {
    const prompt = { prompt: [{ role: "system", content: "system instructions" }, { role: "user", content: [{ type: "text", text: "🌙" }] }] };
    const full = { ...prompt, tools: [{ type: "function", name: "lookup", inputSchema: { description: "schema ".repeat(100) } }], toolChoice: { type: "tool", toolName: "lookup" }, responseFormat: { schema: { description: "response shape" } }, providerOptions: { openai: { store: false } } };
    expect(nativeTextInputBound(full)).toBeGreaterThan(nativeTextInputBound(prompt));
    expect(nativeTextInputBound(prompt)).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(prompt)).byteLength);
    const bound = nativeBudgetEnvelope(policy, policy.routes[0], full, 2_000);
    expect(bound.tokens).toBe(bound.inputTokens + 2_000);
    expect(() => nativeBudgetEnvelope({ ...policy, maxInputTokensPerCall: bound.inputTokens - 1 }, policy.routes[0], full, 2_000)).toThrow("per-call budget ceiling");
  });
  it("counts literal SDK JSON tool output and schema property names without treating them as provider references", () => {
    const json = { conversationId: "synthetic-child", signature: "plain text", fileId: "a literal label" };
    const input = { prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "assignment", toolName: "ask_worker", output: { type: "json", value: json } }] }],
      tools: [{ type: "function", name: "lookup", inputSchema: { type: "object", properties: { conversationId: { type: "string" }, signature: { type: "string" } } } }] };
    expect(nativeTextInputBound(input)).toBeGreaterThan(nativeTextInputBound({ prompt: [] }));
    expect(nativeTextInputBound({ ...input, prompt: [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value: { ...json, text: "receipt ".repeat(100) } } }] }] })).toBeGreaterThan(nativeTextInputBound(input));
    expect(() => nativeTextInputBound({ ...input, providerOptions: { openai: { conversationId: "opaque-provider-state" } } })).toThrow("Opaque provider input");
    expect(() => nativeTextInputBound({ providerOptions: { openai: { type: "json", value: { previousResponseId: "opaque-provider-state" } } } })).toThrow("Opaque provider input");
  });
  it.each([{ type: "image", image: "data:image/png;base64,AA==" }, { type: "file", data: "private-data" }, { type: "provider", id: "openai.web_search" }, { encryptedContent: "opaque" }, { signature: "opaque" }, new Uint8Array([1])])("fails closed for unsupported modal/opaque input %j", input => {
    expect(() => nativeTextInputBound({ prompt: [input] })).toThrow(/budget|budgeted/);
  });
});
