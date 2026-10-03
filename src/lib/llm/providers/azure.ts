import { ProviderConfigError } from "../errors";
import { apiKeyOf, noRedirectFetch } from "./shared";
import type { ProviderImpl } from "./types";

/**
 * Azure OpenAI via the v1 Responses API. The base URL is always set (…/openai/v1), so AZURE_RESOURCE_NAME is
 * never read and no api-version is needed. The key goes in the api-key header, so redirects are refused.
 */
export const azure: ProviderImpl = {
  async create(ctx) {
    if (!ctx.baseUrl) throw new ProviderConfigError(ctx.appName, "azure: endpoint missing");
    const { createAzure } = await import("@ai-sdk/azure");
    const provider = createAzure({ apiKey: apiKeyOf(ctx), baseURL: ctx.baseUrl, fetch: noRedirectFetch(ctx) });
    return { chat: (id) => provider.responses(id), embedding: (id) => provider.embedding(id) };
  },
};
