import { embed, embedMany } from "ai";
import { embeddingApp } from "./apps";
import { resolveEmbeddingModel } from "./resolve";
import { recordUsage } from "./usage";

export type EmbedContext = { userId?: string | null; conversationId?: string | null; botId?: string | null };

/** Embeds texts with the configured embedding app, or returns null when none is configured. */
export async function embedTexts(texts: string[], ctx: EmbedContext = {}): Promise<number[][] | null> {
  const app = await embeddingApp();
  if (!app || !texts.length) return null;
  const model = await resolveEmbeddingModel(app);
  let vectors: number[][];
  let tokens: number | undefined;
  if (texts.length === 1) {
    const r = await embed({ model, value: texts[0] });
    vectors = [r.embedding];
    tokens = r.usage?.tokens;
  } else {
    const r = await embedMany({ model, values: texts });
    vectors = r.embeddings;
    tokens = r.usage?.tokens;
  }
  void recordUsage(
    { purpose: "embedding", billingSource: "org", providerKind: app.provider, model: app.embeddingModel!, appId: app.id, ...ctx },
    {
      // Many OpenAI-compatible embedding servers omit usage (the SDK reports NaN).
      inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
  );
  return vectors;
}
