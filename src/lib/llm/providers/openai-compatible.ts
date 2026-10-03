import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderImpl } from "./types";

/**
 * OpenAI-compatible endpoints (vLLM, LiteLLM, Ollama, internal services). Kept byte-identical to the original
 * single provider: same options, no fetch wrapper, no defaults. This package never reads environment variables.
 */
export const openaiCompatible: ProviderImpl = {
  async create(ctx) {
    const provider = createOpenAICompatible({
      name: `app-${ctx.appId}`,
      baseURL: (ctx.baseUrl ?? "").replace(/\/+$/, ""),
      apiKey: ctx.secret?.type === "api-key" ? ctx.secret.apiKey : undefined,
      includeUsage: true,
      // Most OpenAI-compatible servers (Azure OpenAI, vLLM, LiteLLM, recent Ollama) accept json_schema.
      supportsStructuredOutputs: process.env.OPENAI_COMPAT_STRUCTURED_OUTPUTS !== "false",
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    return { chat: (id) => provider.chatModel(id), embedding: (id) => provider.embeddingModel(id) };
  },
};
