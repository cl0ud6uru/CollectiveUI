import type { ChatModel } from "./types";

/**
 * ChatGPT Codex backend (a person's own ChatGPT plan) through the OpenAI Responses implementation. The API key is a
 * placeholder so OPENAI_API_KEY is never read; the per-turn fetch (src/lib/llm/chatgpt/fetch.ts) replaces the
 * Authorization header with the person's token and refuses any other destination.
 */
export const chatgpt = {
  async create(opts: { baseURL: string; fetch: typeof fetch }): Promise<{ chat(modelId: string): ChatModel }> {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const provider = createOpenAI({ name: "chatgpt", baseURL: opts.baseURL, apiKey: "chatgpt-connection", fetch: opts.fetch });
    return { chat: (id) => provider.responses(id) };
  },
};
