import { apiKeyOf, noRedirectFetch } from "./shared";
import type { ProviderImpl } from "./types";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Claude via the Anthropic API or Microsoft Foundry (…/anthropic/v1), with a company API key sent as x-api-key.
 * The OAuth bearer-token option is never used (Claude.ai credentials are not allowed; see policy I4).
 * No `name`, so provider options stay under the "anthropic" key.
 */
export const anthropic: ProviderImpl = {
  async create(ctx) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const provider = createAnthropic({
      apiKey: apiKeyOf(ctx),
      baseURL: ctx.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL,
      fetch: noRedirectFetch(ctx),
    });
    return { chat: (id) => provider(id) };
  },
};
