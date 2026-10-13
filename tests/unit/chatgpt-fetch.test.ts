import { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatgptFetch } from "@/lib/llm/chatgpt/fetch";
import { chatgptMiddleware } from "@/lib/llm/chatgpt/middleware";
import { ChatGPTPlanError, ChatGPTReauthRequiredError, ChatGPTUnavailableError, ChatGPTUsageLimitError } from "@/lib/llm/chatgpt/errors";
import type { ChatGPTAuth } from "@/lib/llm/chatgpt/store";
import { chatgpt } from "@/lib/llm/providers/chatgpt";
import { wrapLanguageModel } from "ai";
import { OPENAI_API_BASE_URL } from "@/lib/llm/chatgpt/constants";

const auth = (token = "tok-1"): ChatGPTAuth => ({
  credentialId: "cred-1", accessToken: token, accountId: "account-1", planType: "plus", residency: null, isFedramp: false,
});

type Call = { url: string; headers: Headers; body?: string; cache?: RequestCache };
let calls: Call[] = [];
let replies: (() => Response)[] = [];
const base: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body as string | undefined, cache: init?.cache });
  const next = replies.shift();
  if (!next) throw new Error("no reply queued");
  return next();
};
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { calls = []; replies = []; });
afterEach(() => vi.restoreAllMocks());

describe("SIWC public API transport", () => {
  it("uses only the fixed public Responses endpoint, attaches the OAuth token, and removes private headers", async () => {
    replies.push(json(200, { ok: true }));
    const f = chatgptFetch({ conversationId: "conv-1", getAuth: async () => auth(), baseFetch: base });
    await f(`${OPENAI_API_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer attacker", "chatgpt-account-id": "private", "session-id": "private",
        "x-codex-turn-state": "private", "x-openai-internal-codex-residency": "eu", "x-openai-fedramp": "true",
      },
      body: JSON.stringify({ model: "m", input: [], store: true, previous_response_id: "prior" }),
    });
    const call = calls[0];
    expect(call.url).toBe(`${OPENAI_API_BASE_URL}/responses`);
    expect(call.headers.get("authorization")).toBe("Bearer tok-1");
    expect(call.headers.get("originator")).toBe("ai_portal");
    expect(call.headers.get("user-agent")).toMatch(/^AIPortal\//);
    for (const h of ["chatgpt-account-id", "session-id", "x-codex-turn-state", "x-openai-internal-codex-residency", "x-openai-fedramp"]) expect(call.headers.get(h)).toBeNull();
    expect(call.cache).toBe("no-store");
    expect(JSON.parse(call.body!)).toMatchObject({ store: false, stream: true });
    expect(JSON.parse(call.body!)).not.toHaveProperty("previous_response_id");
  });

  it("refuses arbitrary origins, backend URLs, lookalike hosts, and unapproved API paths before reading auth", async () => {
    const getAuth = vi.fn(async () => auth());
    const f = chatgptFetch({ conversationId: null, getAuth, baseFetch: base });
    for (const url of [
      "https://evil.example/codex/responses", "https://chatgpt.com/backend-api/codex/responses",
      "https://api.openai.com.evil.example/v1/responses", "https://api.openai.com/v1/admin/keys",
      "https://api.openai.com/v1/responses?redirect=https://evil.example",
    ]) await expect(f(url, { method: "GET" })).rejects.toThrow(/outside the public OpenAI API/);
    expect(getAuth).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refreshes once on 401 and asks the person to reconnect after a second 401", async () => {
    const getAuth = vi.fn(async ({ rejectedToken }: { rejectedToken?: string }) => (rejectedToken ? auth("tok-2") : auth("tok-1")));
    const f = chatgptFetch({ conversationId: null, getAuth, baseFetch: base });
    replies.push(json(401, {}), json(200, { ok: true }));
    expect((await f(`${OPENAI_API_BASE_URL}/responses`, { method: "POST", body: JSON.stringify({ input: [] }) })).status).toBe(200);
    expect(getAuth).toHaveBeenLastCalledWith({ rejectedToken: "tok-1" });
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(calls[0].body).toBe(calls[1].body);
    replies.push(json(401, {}), json(401, {}));
    await expect(f(`${OPENAI_API_BASE_URL}/responses`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ChatGPTReauthRequiredError);
  });

  it("preserves recognized plan errors and passes ordinary API errors through", async () => {
    const f = chatgptFetch({ conversationId: null, getAuth: async () => auth(), baseFetch: base });
    replies.push(json(429, { error: { type: "subscription_sharing_usage_limit_exceeded", resets_at: 1_900_000_000 } }));
    const limited = await f(`${OPENAI_API_BASE_URL}/responses`, { method: "POST", body: "{}" }).catch((e) => e);
    expect(limited).toBeInstanceOf(ChatGPTUsageLimitError);
    expect((limited as ChatGPTUsageLimitError).resetsAt).toEqual(new Date(1_900_000_000_000));
    replies.push(json(403, { error: { type: "subscription_sharing_user_not_eligible" } }));
    await expect(f(`${OPENAI_API_BASE_URL}/responses`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ChatGPTPlanError);
    replies.push(json(503, { error: { type: "subscription_sharing_usage_unavailable" } }));
    await expect(f(`${OPENAI_API_BASE_URL}/responses`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ChatGPTUnavailableError);
    replies.push(json(429, { error: { type: "rate_limit_exceeded" } }));
    expect((await f(`${OPENAI_API_BASE_URL}/responses`, { method: "POST", body: "{}" })).status).toBe(429);
  });
});

function sse(events: object[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("ChatGPT model through the public Responses API", () => {
  const completed = [
    { type: "response.created", response: { id: "r1", created_at: 1, model: "m" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] } },
    { type: "response.completed", response: { id: "r1", created_at: 1, model: "m", status: "completed", usage: { input_tokens: 5, output_tokens: 1 } } },
  ];

  async function model() {
    const f = chatgptFetch({ conversationId: "conv-1", getAuth: async () => auth(), baseFetch: base });
    const p = await chatgpt.create({ baseURL: OPENAI_API_BASE_URL, fetch: f });
    return wrapLanguageModel({ model: p.chat("gpt-4o"), middleware: chatgptMiddleware({ conversationId: "conv-1" }) });
  }

  it("sends the assembled history to /v1/responses and never chains through previous_response_id", async () => {
    replies.push(sse(completed));
    const result = streamText({
      model: await model(), instructions: "You are the portal assistant.",
      messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "earlier answer" }, { role: "user", content: "again" }],
      temperature: 0.3, maxOutputTokens: 4000,
    });
    expect(await result.text).toBe("hi");
    expect(calls[0].url).toBe(`${OPENAI_API_BASE_URL}/responses`);
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({ instructions: "You are the portal assistant.", store: false, stream: true });
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.input).toHaveLength(3);
    expect(body.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] });
    for (const field of ["max_output_tokens", "temperature", "top_p"]) expect(body).not.toHaveProperty(field);
  });

  it("refuses non-streaming calls", async () => {
    const { generateText } = await import("ai");
    await expect(generateText({ model: await model(), prompt: "x", maxRetries: 0 })).rejects.toThrow(/streaming chat/);
    expect(calls).toHaveLength(0);
  });
});
