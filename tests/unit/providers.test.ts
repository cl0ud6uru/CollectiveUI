import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApp } from "@/db/schema";

vi.mock("@/db", () => ({ db: {} }));

import { QUIET_FALLBACK_ENV, VENDOR_FALLBACK_ENV } from "@/lib/env-guard";
import { resolveModel } from "@/lib/llm/resolve";
import { PROVIDERS } from "@/lib/llm/providers";
import { sealAppSecret } from "@/lib/llm/secrets";
import { setUsageWriter } from "@/lib/llm/usage";

type Call = { url: string; headers: Record<string, string>; body: string };
let calls: Call[] = [];

/** Canned non-streaming responses per wire format. */
function reply(url: string): Response {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/chat/completions"))
    return json({
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
  if (url.endsWith("/responses"))
    return json({
      id: "resp_1",
      created_at: 1,
      model: "m",
      output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 } },
    });
  if (url.includes("/converse"))
    return json({ output: { message: { role: "assistant", content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
  // Anthropic Messages (direct, Foundry, Bedrock InvokeModel, Vertex rawPredict)
  return json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  });
}

const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  calls.push({ url, headers, body: typeof init?.body === "string" ? init.body : "" });
  return reply(url);
}) as typeof fetch;

let seq = 0;
function app(provider: AiApp["provider"], over: Partial<AiApp> & { secret?: string } = {}): AiApp {
  const id = `app${++seq}`;
  const { secret, ...rest } = over;
  return {
    id,
    name: `App ${id}`,
    description: null,
    icon: null,
    kind: "model",
    provider,
    providerConfig: {},
    credentialMode: "org",
    baseUrl: null,
    providerConnectionId: null,
    apiKeyEnc: secret ? sealAppSecret(id, secret) : null,
    model: "m",
    systemPrompt: null,
    temperature: null,
    maxTokens: null,
    supportsVision: false,
    supportsTools: true,
    embeddingModel: null,
    isPublic: true,
    enabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...rest,
  };
}

async function run(a: AiApp, opts: Parameters<typeof generateText>[0] extends infer O ? Partial<O> : never = {}) {
  const { model } = await resolveModel(a, { purpose: "chat", userId: "u1", conversationId: "c1" });
  await generateText({ model, prompt: "hi", maxRetries: 0, ...(opts as object) });
  return calls.at(-1)!;
}

// Every variable an SDK could fall back to, set to values that must never appear in a request.
const SENTINEL_ENV: Record<string, string> = Object.fromEntries(
  [...VENDOR_FALLBACK_ENV, ...QUIET_FALLBACK_ENV].map((k) => [k, /URL|ENDPOINT/.test(k) ? "http://env-leak.invalid" : `ENVLEAK_${k}`]),
);
SENTINEL_ENV.AWS_ACCESS_KEY_ID = "AKIAENVLEAK000000000";
SENTINEL_ENV.AWS_REGION = "eu-leak-9";

describe("provider registry", () => {
  const rows: unknown[] = [];
  beforeEach(() => {
    calls = [];
    rows.length = 0;
    for (const [k, v] of Object.entries(SENTINEL_ENV)) vi.stubEnv(k, v);
    vi.stubGlobal("fetch", recordingFetch);
    setUsageWriter(async (row) => void rows.push(row));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    setUsageWriter(null);
    const leaked = calls.filter((c) => /env-leak|ENVLEAK|eu-leak/.test(JSON.stringify(c)));
    expect(leaked).toEqual([]);
  });

  it("OpenAI: Responses API, bearer key, org/project headers, store:false by default", async () => {
    const c = await run(app("openai", { secret: "sk-test-openai", providerConfig: { organization: "org-1", project: "proj_1" } }));
    expect(c.url).toBe("https://api.openai.com/v1/responses");
    expect(c.headers.authorization).toBe("Bearer sk-test-openai");
    expect(c.headers["openai-organization"]).toBe("org-1");
    expect(c.headers["openai-project"]).toBe("proj_1");
    expect(JSON.parse(c.body).store).toBe(false);
  });

  it("OpenAI: reasoning flag strips temperature", async () => {
    const c = await run(app("openai", { secret: "sk-test", providerConfig: { reasoning: true } }), { temperature: 0.7 });
    expect(JSON.parse(c.body).temperature).toBeUndefined();
  });

  it("Azure: v1 Responses path with the api-key header", async () => {
    const c = await run(app("azure", { secret: "azure-key", baseUrl: "https://res.openai.azure.com/openai/v1", model: "gpt5-prod" }));
    expect(c.url).toBe("https://res.openai.azure.com/openai/v1/responses");
    expect(c.headers["api-key"]).toBe("azure-key");
    expect(c.headers.authorization).toBeUndefined();
  });

  it("Anthropic: x-api-key, no Authorization, cache breakpoint on the stable system block", async () => {
    const a = app("anthropic", { secret: "sk-ant-api03-test", model: "claude-sonnet-4-5" });
    const { model } = await resolveModel(a, { purpose: "chat" });
    await generateText({
      model,
      instructions: [
        { role: "system", content: "stable", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
        { role: "system", content: "dynamic" },
      ],
      prompt: "hi",
      maxRetries: 0,
    });
    const c = calls.at(-1)!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.headers["x-api-key"]).toBe("sk-ant-api03-test");
    expect(c.headers["anthropic-version"]).toBeTruthy();
    expect(c.headers.authorization).toBeUndefined();
    const body = JSON.parse(c.body);
    expect(body.system[0]).toMatchObject({ text: "stable", cache_control: { type: "ephemeral" } });
    expect(body.system[1].cache_control).toBeUndefined();
    expect(body.max_tokens).toBe(8192);
  });

  it("Anthropic on Microsoft Foundry: uses the Foundry base URL", async () => {
    const c = await run(app("anthropic", { secret: "foundry-key", baseUrl: "https://res.services.ai.azure.com/anthropic/v1", model: "my-claude" }));
    expect(c.url).toBe("https://res.services.ai.azure.com/anthropic/v1/messages");
  });

  it("Bedrock: SigV4 with IAM keys, Claude via InvokeModel, no session token header", async () => {
    const secret = JSON.stringify({ v: 1, accessKeyId: "AKIATESTTESTTESTTEST", secretAccessKey: "secret" });
    const c = await run(
      app("bedrock", { secret, providerConfig: { region: "us-east-1", auth: "access-keys" }, model: "us.anthropic.claude-sonnet-4-5-v1:0" }),
    );
    expect(c.url).toMatch(/^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/.+\/invoke$/);
    expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\/\d+\/us-east-1\/bedrock\/aws4_request/);
    expect(c.headers["x-amz-security-token"]).toBeUndefined();
  });

  it("Bedrock: API key as bearer; non-Claude models use Converse", async () => {
    const c = await run(app("bedrock", { secret: "ABSKtesttesttesttesttest", providerConfig: { region: "eu-west-1" }, model: "amazon.nova-pro-v1:0" }));
    expect(c.url).toMatch(/^https:\/\/bedrock-runtime\.eu-west-1\.amazonaws\.com\/model\/.+\/converse$/);
    expect(c.headers.authorization).toBe("Bearer ABSKtesttesttesttesttest");
  });

  it("Vertex AI (Claude): project/location from config, token from the service account hook", async () => {
    const instance = await PROVIDERS["vertex-anthropic"].create({
      appId: "v1",
      appName: "Vertex",
      kind: "vertex-anthropic",
      baseUrl: null,
      config: { project: "my-project-1", location: "us-east5", reasoning: false, promptCaching: true },
      secret: { type: "service-account", clientEmail: "sa@my-project-1.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" },
      fetch: recordingFetch,
      generateAuthToken: async () => "test-token",
    });
    await generateText({ model: instance.chat("claude-sonnet-4-5@20250929"), prompt: "hi", maxRetries: 0 });
    const c = calls.at(-1)!;
    expect(c.url).toContain("/projects/my-project-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict");
    expect(c.headers.authorization).toBe("Bearer test-token");
  });

  it("native providers refuse to run without stored credentials", async () => {
    await expect(resolveModel(app("openai"), { purpose: "chat" })).rejects.toThrow(/not configured correctly/);
    await expect(resolveModel(app("anthropic"), { purpose: "chat" })).rejects.toThrow(/not configured correctly/);
  });

  it("ChatGPT plan apps need an acting person; company kinds can't run on personal credentials", async () => {
    await expect(resolveModel(app("chatgpt"), { purpose: "chat" })).rejects.toThrow(/own ChatGPT plan/);
    await expect(resolveModel(app("chatgpt"), { purpose: "memory", userId: "u1" })).rejects.toThrow(/background work/);
    await expect(resolveModel(app("openai", { secret: "sk-x", credentialMode: "user" }), { purpose: "chat" })).rejects.toThrow(/personal connection/);
  });

  it("Claude.ai tokens stored in any app are refused at use time", async () => {
    await expect(resolveModel(app("openai-compatible", { baseUrl: "http://x/v1", secret: "sk-ant-oat01-abcdefghij" }), { purpose: "chat" })).rejects.toThrow(
      /not configured correctly/,
    );
  });

  it("records one usage row per call, with cache tokens", async () => {
    await run(app("anthropic", { secret: "sk-ant-api03-test", model: "claude-sonnet-4-5" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "chat", providerKind: "anthropic", userId: "u1", conversationId: "c1", billingSource: "org", cacheReadTokens: 5 });
  });

  it("title calls turn reasoning off and raise the output floor for Claude", async () => {
    const a = app("anthropic", { secret: "sk-ant-api03-test", model: "claude-sonnet-4-5" });
    const { model } = await resolveModel(a, { purpose: "title" });
    await generateText({ model, prompt: "hi", maxOutputTokens: 30, maxRetries: 0 });
    const body = JSON.parse(calls.at(-1)!.body);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(body.thinking).toMatchObject({ type: "disabled" });
  });
});

describe("OpenAI-compatible stays byte-identical", () => {
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", recordingFetch);
    setUsageWriter(async () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setUsageWriter(null);
  });

  it("sends the same request as the original single provider", async () => {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const a = app("openai-compatible", { baseUrl: "http://llm.internal/v1/", secret: "sk-internal", model: "my-model" });
    await run(a, { temperature: 0.3, maxOutputTokens: 100 });
    const viaRegistry = calls.at(-1)!;

    const legacy = createOpenAICompatible({
      name: `app-${a.id}`,
      baseURL: "http://llm.internal/v1",
      apiKey: "sk-internal",
      includeUsage: true,
      supportsStructuredOutputs: true,
    });
    await generateText({ model: legacy.chatModel("my-model"), prompt: "hi", maxRetries: 0, temperature: 0.3, maxOutputTokens: 100 });
    const direct = calls.at(-1)!;

    expect(viaRegistry.url).toBe(direct.url);
    expect(viaRegistry.body).toBe(direct.body);
    expect(viaRegistry.headers).toEqual(direct.headers);
  });
});
