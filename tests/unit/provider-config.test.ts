import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppInput, isAnthropicFamily, isEligibleEmbeddingApp, isEligibleUtilityApp, normalizeBaseUrl } from "@/lib/llm/catalog";

const base = {
  name: "App",
  model: "m",
  supportsVision: false,
  supportsTools: true,
  isPublic: true,
  enabled: true,
};

describe("base URL normalization", () => {
  it.each([
    ["azure", "https://res.openai.azure.com", "https://res.openai.azure.com/openai/v1"],
    ["azure", "https://res.openai.azure.com/openai/", "https://res.openai.azure.com/openai/v1"],
    ["azure", "https://res.cognitiveservices.azure.com/openai/v1", "https://res.cognitiveservices.azure.com/openai/v1"],
    ["azure", "https://apim.corp.example.com/aoai", "https://apim.corp.example.com/aoai"], // gateway kept verbatim
    ["anthropic", "https://res.services.ai.azure.com/anthropic", "https://res.services.ai.azure.com/anthropic/v1"],
    ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1"],
    ["anthropic", "", null],
    ["openai", "", null],
    ["openai", "http://localhost:4010/v1/", "http://localhost:4010/v1"],
    ["bedrock", "https://vpce-123.bedrock-runtime.us-east-1.vpce.amazonaws.com", "https://vpce-123.bedrock-runtime.us-east-1.vpce.amazonaws.com"],
    ["openai-compatible", "http://llm.internal:8000/v1/", "http://llm.internal:8000/v1/"], // stored as entered (unchanged behaviour)
  ] as const)("%s %s", (kind, input, expected) => {
    expect(normalizeBaseUrl(kind, input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["azure", ""],
    ["azure", "https://res.services.ai.azure.com/api/projects/p1"],
    ["openai", "http://api.example.com/v1"], // plain http only for localhost
    ["openai", "https://user:pass@api.example.com/v1"],
    ["anthropic", "https://api.anthropic.com/v1?x=1"],
    ["bedrock", "https://evil.example.com"],
    ["vertex-anthropic", "https://evil.example.com"], // no override: it would receive a Google access token
    ["openai-compatible", ""],
    ["openai-compatible", "ftp://x"],
  ] as const)("rejects %s %s", (kind, input) => {
    expect(normalizeBaseUrl(kind, input).ok).toBe(false);
  });
});

describe("AppInput", () => {
  it("accepts each enabled provider with its config", () => {
    expect(AppInput.safeParse({ ...base, provider: "openai-compatible", baseUrl: "http://x/v1" }).success).toBe(true);
    expect(AppInput.safeParse({ ...base, provider: "anthropic", model: "claude-sonnet-4-5" }).success).toBe(true);
    expect(AppInput.safeParse({ ...base, provider: "bedrock", config: { region: "us-east-1" }, model: "anthropic.claude-v2" }).success).toBe(true);
    expect(AppInput.safeParse({ ...base, provider: "vertex-anthropic", config: { project: "my-proj-1" } }).success).toBe(true);
  });

  it("accepts ChatGPT plan apps without credentials, and rejects invalid combinations", () => {
    const chatgpt = AppInput.safeParse({ ...base, provider: "chatgpt", model: "gpt-5.1-codex" });
    expect(chatgpt.success && chatgpt.data.config).toEqual({ reasoningEffort: "default" });
    expect(AppInput.safeParse({ ...base, provider: "chatgpt", embeddingModel: "text-embedding-3-small" }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "chatgpt", config: { reasoningEffort: "minimal" } }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "chatgpt", model: "../x" }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "anthropic", embeddingModel: "x" }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "anthropic", temperature: 1.5 }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "openai", maxTokens: 8 }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "bedrock", config: { region: "not a region" } }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "vertex-anthropic", config: { project: "X!" } }).success).toBe(false);
    expect(AppInput.safeParse({ ...base, provider: "bedrock", config: { region: "us-east-1" }, model: "../../x" }).success).toBe(false);
  });

  it("knows which apps speak the Anthropic Messages API", () => {
    expect(isAnthropicFamily("anthropic", {}, "x")).toBe(true);
    expect(isAnthropicFamily("bedrock", { api: "auto" }, "us.anthropic.claude-sonnet-4-5")).toBe(true);
    expect(isAnthropicFamily("bedrock", { api: "auto" }, "amazon.nova-pro-v1:0")).toBe(false);
    expect(isAnthropicFamily("bedrock", { api: "converse" }, "anthropic.claude-v2")).toBe(false);
  });
});

describe("background app eligibility", () => {
  const ok = { enabled: true, kind: "model", provider: "openai", credentialMode: "org", embeddingModel: "text-embedding-3-small" };
  it.each([
    [ok, true, true],
    [{ ...ok, enabled: false }, false, false],
    [{ ...ok, credentialMode: "user" }, false, false],
    [{ ...ok, provider: "chatgpt" }, false, false],
    [{ ...ok, kind: "runtime" }, false, false],
    [{ ...ok, provider: "anthropic" }, true, false], // no embeddings
    [{ ...ok, embeddingModel: null }, true, false],
  ])("%o", (appRow, utility, embedding) => {
    expect(isEligibleUtilityApp(appRow)).toBe(utility);
    expect(isEligibleEmbeddingApp(appRow)).toBe(embedding);
  });
});

describe("catalog stays client-safe", () => {
  it("imports only zod and ./kinds", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "../../src/lib/llm/catalog.ts"), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./kinds", "zod"]);
  });
});
