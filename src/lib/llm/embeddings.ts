import { embed, embedMany, wrapEmbeddingModel } from "ai";
import type { DbOrTx } from '@/db';
import { embeddingApp } from "./apps";
import { resolveEmbeddingDispatch } from "./resolve";
import { newUsageScope, recordUsage, type UsageScope } from "./usage";
import { nativeEmbeddingBudgetMiddleware } from "./run-budget-middleware";
import { nativeRunBudgetPolicy, NativeRunBudgetError } from "./run-budget-policy";

export type EmbedContext = { userId?: string | null; conversationId?: string | null; botId?: string | null };

/** Embeds texts with the configured embedding app, or returns null when none is configured. */
export async function embedTexts(texts: string[], ctx: EmbedContext = {}, options: { abortSignal?: AbortSignal; maxRetries?: number; q?: DbOrTx; usage?: UsageScope } = {}): Promise<number[][] | null> {
  const { q, usage, ...sdkOptions } = options;
  const app = await embeddingApp(q);
  if (!app || !texts.length) return null;
  const { model: unwrapped, attribution } = await resolveEmbeddingDispatch(app, q);
  const budgetEnabled = !!usage?.rootBudgetId && !!nativeRunBudgetPolicy();
  if (unwrapped.specificationVersion === "v2" && budgetEnabled) throw new NativeRunBudgetError("This embedding adapter has no supported native budget contract.");
  const model = !budgetEnabled || unwrapped.specificationVersion === "v2" ? unwrapped : wrapEmbeddingModel({ model: unwrapped, middleware: nativeEmbeddingBudgetMiddleware({ purpose: "embedding", billingSource: "org", providerKind: app.provider, model: app.embeddingModel!, appId: app.id, ...attribution, ...ctx, scope: usage }) });
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
  const write = budgetEnabled ? Promise.resolve() : recordUsage(
    { purpose: "embedding", billingSource: "org", providerKind: app.provider, model: app.embeddingModel!, appId: app.id, ...attribution, ...ctx, scope: usage ?? (q ? newUsageScope({}, q) : undefined) },
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
