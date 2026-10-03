import { isAnthropicFamily, type ProviderConfigMap } from "../catalog";
import { requireSecret } from "./shared";
import type { ProviderContext, ProviderImpl } from "./types";

export const bedrockDefaultBaseUrl = (region: string) => `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;

/**
 * Credentials for both Bedrock factories. Every field is a string: the SDK reads AWS_* variables (including
 * AWS_BEARER_TOKEN_BEDROCK and AWS_SESSION_TOKEN) for anything left undefined.
 */
function credentials(ctx: ProviderContext) {
  const cfg = ctx.config as ProviderConfigMap["bedrock"];
  const common = {
    region: cfg.region,
    baseURL: ctx.baseUrl ?? bedrockDefaultBaseUrl(cfg.region),
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  };
  if (cfg.auth === "access-keys") {
    const s = requireSecret(ctx, "aws-keys");
    // Empty apiKey = use SigV4; an empty session token is ignored by the signer.
    return { ...common, apiKey: "", accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken ?? "" };
  }
  const s = requireSecret(ctx, "api-key");
  return { ...common, apiKey: s.apiKey, accessKeyId: "", secretAccessKey: "", sessionToken: "" };
}

/** Amazon Bedrock: Claude through the Anthropic Messages API (InvokeModel), everything else through Converse. */
export const bedrock: ProviderImpl = {
  async create(ctx) {
    const cfg = ctx.config as ProviderConfigMap["bedrock"];
    const creds = credentials(ctx);
    const [{ createAmazonBedrock }, { createAmazonBedrockAnthropic }] = await Promise.all([
      import("@ai-sdk/amazon-bedrock"),
      import("@ai-sdk/amazon-bedrock/anthropic"),
    ]);
    const converse = createAmazonBedrock(creds);
    const claude = createAmazonBedrockAnthropic(creds);
    return {
      chat: (id) => (isAnthropicFamily("bedrock", cfg, id) ? claude(id) : converse(id)),
      embedding: (id) => converse.embedding(id),
    };
  },
};
