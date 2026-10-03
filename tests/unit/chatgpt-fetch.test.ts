import { streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatgptFetch, readRateLimitHeaders } from "@/lib/llm/chatgpt/fetch";
import { chatgptMiddleware } from "@/lib/llm/chatgpt/middleware";
import { ChatGPTPlanError, ChatGPTReauthRequiredError, ChatGPTUsageLimitError } from "@/lib/llm/chatgpt/errors";
import type { ChatGPTAuth } from "@/lib/llm/chatgpt/store";
import { chatgpt } from "@/lib/llm/providers/chatgpt";
import { wrapLanguageModel } from "ai";

const BACKEND = "https://chatgpt.com/backend-api";
const auth = (token = "tok-1"): ChatGPTAuth => ({
  credentialId: "cred-1",
  accessToken: token,
  accountId: "ws-1",
  planType: "business",
  residency: null,
  isFedramp: false,
});

type Call = { url: string; headers: Headers; body?: string };
let calls: Call[] = [];
let replies: (() => Response)[] = [];
const base: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body as string | undefined });
  const next = replies.shift();
  if (!next) throw new Error("no reply queued");
  return next();
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  calls = [];
  replies = [];
  delete process.env.CHATGPT_BACKEND_URL;
});
afterEach(() => vi.restoreAllMocks());

describe("ChatGPT model fetch", () => {
  it("sends the person's token and account headers with the portal's own identity, and rewrites the body", async () => {
    replies.push(json(200, { ok: true }, { "x-codex-turn-state": "ts-1" }), json(200, {}));
    const onRateLimits = vi.fn();
    const f = chatgptFetch({
      conversationId: "conv-1",
      getAuth: async () => ({ ...auth(), residency: "eu", isFedramp: true }),
      baseFetch: base,
      onRateLimits,
    });
    await f(`${BACKEND}/codex/responses`, {
      method: "POST",
      headers: { authorization: "Bearer chatgpt-connection", "OpenAI-Organization": "org-x" },
      body: JSON.stringify({ model: "m", input: [], max_output_tokens: 10, store: true }),
    });
    const h = calls[0].headers;
    expect(h.get("authorization")).toBe("Bearer tok-1");
    expect(h.get("chatgpt-account-id")).toBe("ws-1");
    expect(h.get("originator")).toBe("ai_portal");
    expect(h.get("user-agent")).toMatch(/^AIPortal\//);
    expect(h.get("session-id")).toBe("conv-1");
    expect(h.get("x-client-request-id")).toBe("conv-1");
    expect(h.get("x-openai-internal-codex-residency")).toBe("eu");
    expect(h.get("x-openai-fedramp")).toBe("true");
    expect(h.get("openai-organization")).toBeNull();
    expect(h.get("x-codex-turn-state")).toBeNull();
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({ store: false, stream: true });
    expect(body).not.toHaveProperty("max_output_tokens");

    // The turn state is replayed on later requests of the same turn.
    await f(`${BACKEND}/codex/responses`, { method: "POST", body: JSON.stringify({ model: "m", input: [] }) });
    expect(calls[1].headers.get("x-codex-turn-state")).toBe("ts-1");
    expect(onRateLimits).not.toHaveBeenCalled();
  });

  it("never sends the token anywhere but the ChatGPT backend", async () => {
    const f = chatgptFetch({ conversationId: null, getAuth: async () => auth(), baseFetch: base });
    await expect(f("https://evil.example.com/codex/responses", { method: "POST", body: "{}" })).rejects.toThrow(/outside the ChatGPT backend/);
    await expect(f("https://chatgpt.com/backend-api.evil.com/x", { method: "GET" })).rejects.toThrow(/outside/);
    expect(calls).toHaveLength(0);
  });

  it("refreshes once after a 401 and retries; a second 401 asks the person to reconnect", async () => {
    const getAuth = vi.fn(async ({ rejectedToken }: { rejectedToken?: string }) => (rejectedToken ? auth("tok-2") : auth("tok-1")));
    const f = chatgptFetch({ conversationId: null, getAuth, baseFetch: base });
    replies.push(json(401, {}), json(200, { ok: true }));
    const res = await f(`${BACKEND}/codex/responses`, { method: "POST", body: JSON.stringify({ input: [] }) });
    expect(res.status).toBe(200);
    expect(getAuth).toHaveBeenLastCalledWith({ rejectedToken: "tok-1" });
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(calls[0].body).toBe(calls[1].body);

    replies.push(json(401, {}), json(401, {}));
    await expect(f(`${BACKEND}/codex/responses`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ChatGPTReauthRequiredError);
  });

  it("turns plan limits into typed errors and passes other errors to the SDK", async () => {
    const f = chatgptFetch({ conversationId: null, getAuth: async () => auth(), baseFetch: base });
    replies.push(json(429, { error: { type: "usage_limit_reached", plan_type: "plus", resets_at: 1_900_000_000 } }));
    const err = await f(`${BACKEND}/codex/responses`, { method: "POST", body: "{}" }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatGPTUsageLimitError);
    expect((err as ChatGPTUsageLimitError).resetsAt).toEqual(new Date(1_900_000_000_000));
    replies.push(json(429, { error: { type: "usage_not_included" } }));
    await expect(f(`${BACKEND}/codex/responses`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ChatGPTPlanError);
    replies.push(json(429, { error: { message: "slow down", type: "rate_limit_exceeded" } }));
    const res = await f(`${BACKEND}/codex/responses`, { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "slow down", type: "rate_limit_exceeded" } });
  });

  it("reads plan usage headers", () => {
    const h = new Headers({ "x-codex-primary-used-percent": "40", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "1700000000" });
    expect(readRateLimitHeaders(h)).toEqual({ primary: { usedPercent: 40, windowMinutes: 300, resetAt: 1_700_000_000 } });
    expect(readRateLimitHeaders(new Headers())).toBeNull();
  });
});

function sse(events: object[]) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("ChatGPT model through the AI SDK", () => {
  const completed = [
    { type: "response.created", response: { id: "r1", created_at: 1, model: "m" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
    },
    {
      type: "response.completed",
      response: { id: "r1", created_at: 1, model: "m", status: "completed", usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
    },
  ];

  async function model() {
    const f = chatgptFetch({ conversationId: "conv-1", getAuth: async () => auth(), baseFetch: base });
    const p = await chatgpt.create({ baseURL: `${BACKEND}/codex`, fetch: f });
    return wrapLanguageModel({ model: p.chat("gpt-codex"), middleware: chatgptMiddleware({ conversationId: "conv-1", reasoningEffort: "high" }) });
  }

  it("sends instructions at the top level with the backend's rules applied", async () => {
    replies.push(sse(completed));
    const result = streamText({
      model: await model(),
      instructions: "You are the portal assistant.",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "again" },
      ],
      temperature: 0.3,
      maxOutputTokens: 4000,
    });
    expect(await result.text).toBe("hi");
    expect(calls[0].url).toBe(`${BACKEND}/codex/responses`);
    const body = JSON.parse(calls[0].body!);
    expect(body.instructions).toBe("You are the portal assistant.");
    expect(body).toMatchObject({ store: false, stream: true, prompt_cache_key: "conv-1", reasoning: { effort: "high", summary: "auto" } });
    expect(body.include).toContain("reasoning.encrypted_content");
    for (const k of ["max_output_tokens", "temperature", "top_p"]) expect(body).not.toHaveProperty(k);
    expect(body.input.some((i: { role?: string }) => i.role === "system" || i.role === "developer")).toBe(false);
    for (const item of body.input) expect(typeof item.content).not.toBe("string");
    expect(body.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] });
  });

  it("refuses non-streaming calls (the backend only streams)", async () => {
    const { generateText } = await import("ai");
    await expect(generateText({ model: await model(), prompt: "x", maxRetries: 0 })).rejects.toThrow(/streaming chat/);
    expect(calls).toHaveLength(0);
  });
});
