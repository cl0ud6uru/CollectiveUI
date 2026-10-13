import { stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OPENAI_API_BASE_URL } from "@/lib/llm/chatgpt/constants";
import { chatgptFetch } from "@/lib/llm/chatgpt/fetch";
import { chatgptMiddleware } from "@/lib/llm/chatgpt/middleware";
import { chatgpt } from "@/lib/llm/providers/chatgpt";
import type { ChatGPTAuth } from "@/lib/llm/chatgpt/store";

function stream(events: object[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const functionCallResponse = stream([
  { type: "response.created", response: { id: "resp-tool", created_at: 1, model: "gpt-4o" } },
  {
    type: "response.output_item.added", output_index: 0,
    item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "uppercase", namespace: "collectiveui", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 0, delta: '{"value":"hello"}' },
  { type: "response.function_call_arguments.done", item_id: "fc-1", output_index: 0, arguments: '{"value":"hello"}' },
  {
    type: "response.output_item.done", output_index: 0,
    item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "uppercase", namespace: "collectiveui", arguments: '{"value":"hello"}', status: "completed" },
  },
  { type: "response.completed", response: { id: "resp-tool", created_at: 1, model: "gpt-4o", status: "completed", usage: { input_tokens: 3, output_tokens: 1 } } },
]);

const finalResponse = stream([
  { type: "response.created", response: { id: "resp-final", created_at: 2, model: "gpt-4o" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "HELLO" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "HELLO", annotations: [] }] } },
  { type: "response.completed", response: { id: "resp-final", created_at: 2, model: "gpt-4o", status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } },
]);

describe("SIWC OpenAI SDK local tool round trip", () => {
  it("executes a namespaced local function and resends full history without server conversation state", async () => {
    const ownerId = "user-owner-fixture";
    const auth: ChatGPTAuth = {
      credentialId: "credential-fixture", accessToken: "sentinel-oauth-token", accountId: "account-fixture",
      planType: "plus", residency: null, isFedramp: false,
    };
    const authRequests: Array<{ owner: string; rejectedToken?: string }> = [];
    const getAuth = vi.fn(async (options: { rejectedToken?: string }) => {
      authRequests.push({ owner: ownerId, rejectedToken: options.rejectedToken });
      return auth;
    });
    const replies = [functionCallResponse, finalResponse];
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const baseFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected third inference request");
      return reply;
    };

    const fetch = chatgptFetch({ conversationId: "conversation-fixture", getAuth, baseFetch });
    const provider = await chatgpt.create({ baseURL: OPENAI_API_BASE_URL, fetch });
    const execute = vi.fn(async ({ value }: { value: string }) => ({ upper: value.toUpperCase() }));
    const model = wrapLanguageModel({
      model: provider.chat("gpt-4o"),
      middleware: [chatgptMiddleware({ conversationId: "conversation-fixture" })],
    });

    const result = streamText({
      model,
      prompt: "Use the local uppercase tool on hello, then return its result.",
      tools: {
        uppercase: tool({
          description: "Uppercase a string locally.",
          inputSchema: z.object({ value: z.string() }),
          execute,
        }),
      },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });

    expect(await result.text).toBe("HELLO");
    expect(execute).toHaveBeenCalledWith({ value: "hello" }, expect.anything());
    expect(requests).toHaveLength(2);
    expect(replies).toHaveLength(0);
    expect(authRequests).toHaveLength(2);
    expect(authRequests.every((call) => call.owner === ownerId && call.rejectedToken === undefined)).toBe(true);

    for (const request of requests) {
      expect(request.url).toBe(`${OPENAI_API_BASE_URL}/responses`);
      expect(request.headers.get("authorization")).toBe("Bearer sentinel-oauth-token");
      expect(request.body).toMatchObject({ store: false, stream: true });
      expect(request.body).not.toHaveProperty("previous_response_id");
      for (const key of ["max_output_tokens", "temperature", "top_p", "metadata", "user", "include"]) {
        expect(request.body).not.toHaveProperty(key);
      }
    }

    const firstBody = requests[0].body;
    expect(firstBody.tools).toEqual([{
      type: "namespace", name: "collectiveui", description: "CollectiveUI local tools",
      tools: [expect.objectContaining({ type: "function", name: "uppercase" })],
    }]);
    expect(JSON.stringify(firstBody)).not.toContain("tool_search");

    const secondInput = requests[1].body.input as Array<Record<string, unknown>>;
    const callItem = secondInput.find((item) => item.type === "function_call");
    const outputItem = secondInput.find((item) => item.type === "function_call_output");
    expect(secondInput).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));
    expect(callItem).toMatchObject({ type: "function_call", call_id: "call-1", name: "uppercase", namespace: "collectiveui" });
    expect(outputItem).toMatchObject({ type: "function_call_output", call_id: "call-1" });
    expect(JSON.stringify(outputItem)).toContain("HELLO");
  });
});
