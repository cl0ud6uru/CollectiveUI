import { APICallError, RetryError, streamText, wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { chatgptPlanErrorFrom, ChatGPTPlanError, ChatGPTReauthRequiredError, ChatGPTUsageLimitError, userFacingMessage } from "@/lib/llm/chatgpt/errors";
import { chatgptFetch } from "@/lib/llm/chatgpt/fetch";
import { chatgptMiddleware } from "@/lib/llm/chatgpt/middleware";
import { chatgpt } from "@/lib/llm/providers/chatgpt";
import { ProviderConfigError, ProviderUnavailableError } from "@/lib/llm/errors";

describe("errors people can act on", () => {
  it("are found through the SDK's RetryError; anything else stays generic", () => {
    const typed = new ChatGPTReauthRequiredError();
    expect(userFacingMessage(typed)).toBe(typed.message);
    const wrapped = new RetryError({ message: "Failed after 2 attempts", reason: "errorNotRetryable", errors: [new Error("500"), typed] });
    expect(userFacingMessage(wrapped)).toBe(typed.message);
    expect(userFacingMessage(new Error("upstream said: sk-secret"))).toBeUndefined();
  });

  it("provider refusals and config problems are shown too (their messages are written for people)", () => {
    expect(userFacingMessage(new ProviderUnavailableError("Personal ChatGPT plans (Plus) aren't allowed here."))).toMatch(/Personal ChatGPT plans/);
    const config = new ProviderConfigError("Claude", "anthropic: no credentials stored");
    expect(userFacingMessage(config)).toBe("Claude is not configured correctly. Ask an admin to check it.");
    expect(userFacingMessage(config)).not.toContain("no credentials");
  });

  it("maps plan errors reported inside the stream", () => {
    const frame = { type: "response.failed", response: { error: { code: "usage_not_included", message: "no codex" } } };
    const apiError = new APICallError({ message: "no codex", url: "x", requestBodyValues: {}, statusCode: 500, responseBody: JSON.stringify(frame), data: frame, isRetryable: true });
    expect(chatgptPlanErrorFrom(apiError)).toBeInstanceOf(ChatGPTPlanError);
    const limit = chatgptPlanErrorFrom({ type: "error", error: { type: "usage_limit_reached", resets_at: 1_900_000_000 } });
    expect(limit).toBeInstanceOf(ChatGPTUsageLimitError);
    expect((limit as ChatGPTUsageLimitError).resetsAt).toEqual(new Date(1_900_000_000_000));
    expect(chatgptPlanErrorFrom(new Error("boom"))).toBeUndefined();
    // A frame that failed the SDK's schema check is still recognised.
    expect(chatgptPlanErrorFrom({ name: "AI_TypeValidationError", value: { type: "response.failed", response: { error: { code: "usage_not_included" } } } })).toBeInstanceOf(
      ChatGPTPlanError,
    );
  });

  it("a response.failed usage_not_included frame is shown as a plan error and not retried", async () => {
    let calls = 0;
    const sse = [
      { type: "response.created", response: { id: "r1", created_at: 1, model: "m" } },
      { type: "response.failed", sequence_number: 1, response: { error: { code: "usage_not_included", message: "Your plan does not include Codex" } } },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    const base: typeof fetch = async () => {
      calls++;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const f = chatgptFetch({
      conversationId: "c1",
      getAuth: async () => ({ credentialId: "c", accessToken: "t", accountId: "a", planType: "plus", residency: null, isFedramp: false }),
      baseFetch: base,
    });
    const p = await chatgpt.create({ baseURL: "https://chatgpt.com/backend-api/codex", fetch: f });
    const errors: unknown[] = [];
    const result = streamText({
      model: wrapLanguageModel({ model: p.chat("gpt-codex"), middleware: chatgptMiddleware({ conversationId: "c1" }) }),
      prompt: "hi",
      onError: ({ error }) => void errors.push(error),
    });
    await result.consumeStream();
    expect(calls).toBe(1);
    expect(errors.map((e) => userFacingMessage(e))).toContain(new ChatGPTPlanError().message);
  });
});
