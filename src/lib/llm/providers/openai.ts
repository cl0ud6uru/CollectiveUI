import { openai as sdkOpenAI } from "@ai-sdk/openai";
import type { ProviderConfigMap } from "../catalog";
import { apiKeyOf } from "./shared";
import type { ProviderImpl } from "./types";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** OpenAI API via the Responses API. baseURL is always a string so OPENAI_BASE_URL is never read. */
export const openai: ProviderImpl = {
  async create(ctx) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const cfg = ctx.config as ProviderConfigMap["openai"];
    const provider = createOpenAI({
      apiKey: apiKeyOf(ctx),
      baseURL: ctx.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
      ...(cfg.organization ? { organization: cfg.organization } : {}),
      ...(cfg.project ? { project: cfg.project } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    return { chat: (id) => provider.responses(id), embedding: (id) => provider.embeddingModel(id) };
  },
};

/** Factory only: credentials and model requests still go through resolveModel. */
export const hostedSearchTool = (domains: string[]) => sdkOpenAI.tools.webSearch({ ...(domains.length ? { filters: { allowedDomains: domains } } : {}) });
