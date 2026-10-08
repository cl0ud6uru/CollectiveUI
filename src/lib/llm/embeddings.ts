import { embed, embedMany } from "ai";
import type { DbOrTx } from '@/db';
import { embeddingApp } from "./apps";
import { apiUsageAttribution, resolveEmbeddingModel } from "./resolve";
import { newUsageScope, recordUsage, type UsageScope } from "./usage";

export type EmbedContext = { userId?: string | null; conversationId?: string | null; botId?: string | null };

/** Embeds texts with the configured embedding app, or returns null when none is configured. */
export async function embedTexts(texts: string[], ctx: EmbedContext = {}, options: { abortSignal?: AbortSignal; maxRetries?: number; q?: DbOrTx; usage?: UsageScope } = {}): Promise<number[][] | null> {
  const { q, usage, ...sdkOptions } = options;
  const app = await embeddingApp(q);
  if (!app || !texts.length) return null;
  const model = await resolveEmbeddingModel(app, q);
  let vectors: number[][];
  let tokens: number | undefined;
  if (texts.length === 1) {
    const r = await embed({ model, value: texts[0], ...sdkOptions });
    vectors = [r.embedding];
    tokens = r.usage?.tokens;
  } else {
    const r = await embedMany({ model, values: texts, ...sdkOptions });
    vectors = r.embeddings;
    tokens = r.usage?.tokens;
  }
  const write = recordUsage(
    { purpose: "embedding", billingSource: "org", providerKind: app.provider, model: app.embeddingModel!, appId: app.id, ...await apiUsageAttribution(app, q), ...ctx, scope: usage ?? (q ? newUsageScope({}, q) : undefined) },
    {
      // Many OpenAI-compatible embedding servers omit usage (the SDK reports NaN).
      inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
  );
  if (q) await write;
  return vectors;
}
