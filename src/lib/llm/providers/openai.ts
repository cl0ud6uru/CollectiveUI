import { openai as sdkOpenAI } from "@ai-sdk/openai";
import type { ProviderConfigMap } from "../catalog";
import { apiKeyOf } from "./shared";
import type { ProviderImpl } from "./types";
import { generateImage } from "ai";
import type { ProviderConnection } from "../provider-connections";
import { openProviderCredential } from "../provider-connections";

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

/** One no-retry image request through an existing, official OpenAI company connection. */
export async function generatePetImage(input: { connection: ProviderConnection; modelId: "gpt-image-2.5-sunburst"; prompt: string; reference?: Buffer; abortSignal?: AbortSignal }) {
  const { connection } = input;
  if (!connection.enabled || connection.provider !== "openai" ||
    (connection.baseUrl !== null && connection.baseUrl !== OPENAI_DEFAULT_BASE_URL)) {
    throw new Error("Pet generation requires an enabled saved OpenAI connection using the official API endpoint.");
  }
  const provider = await import("@ai-sdk/openai").then(({ createOpenAI }) => createOpenAI({
    apiKey: openProviderCredential(connection),
    baseURL: OPENAI_DEFAULT_BASE_URL,
    ...(connection.organization ? { organization: connection.organization } : {}),
    ...(connection.project ? { project: connection.project } : {}),
  }));
  const result = await generateImage({
    model: provider.image(input.modelId),
    prompt: input.reference ? { text: input.prompt, images: [new Uint8Array(input.reference)] } : input.prompt,
    n: 1,
    size: "1024x1024",
    maxRetries: 0,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    providerOptions: { openai: { quality: "low", background: "transparent", output_format: "png" } },
  });
  return { image: Buffer.from(result.image.uint8Array), inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
}
