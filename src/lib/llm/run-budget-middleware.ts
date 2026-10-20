import type { EmbeddingModelMiddleware, LanguageModelMiddleware } from "ai";
import { mapUsage, recordUsage, type UsageContext } from "./usage";
import { nativeBudgetEnvelope, nativeBudgetRoute, NativeRunBudgetError } from "./run-budget-policy";
import { markNativeBudgetDispatched, nativeBudgetHandle, releaseNativeBudget, reserveNativeBudget, retainNativeBudget, settleNativeBudget, type NativeBudgetReceipt } from "./run-budget-store";

type ModelParams = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
const inputOf = (params: ModelParams) => {
  const input = { ...params }; delete input.abortSignal; delete input.headers; delete input.includeRawChunks; return input;
};
const uncertain = async (receipt: NativeBudgetReceipt, ctx: UsageContext, record = true) => {
  // The committed reservation remains held even if the status annotation or best-effort ledger write fails.
  await retainNativeBudget(receipt).catch(() => {});
  if (record) await recordUsage(ctx, mapUsage(undefined), { id: `native-budget-${receipt.id}` });
};

/** Inner middleware sees defaults and all SDK-transformed prompt/tool fields. SDK retries enter it afresh. */
export function nativeRunBudgetMiddleware(ctx: UsageContext): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const handle = await nativeBudgetHandle(ctx);
      if (!handle) return params;
      const route = nativeBudgetRoute(handle.policy, ctx.providerKind, ctx.model);
      const maxOutputTokens = Math.min(params.maxOutputTokens ?? handle.policy.maxOutputTokensPerCall, handle.policy.maxOutputTokensPerCall);
      const bounded = { ...params, maxOutputTokens };
      nativeBudgetEnvelope(handle.policy, route, inputOf(bounded), maxOutputTokens);
      return bounded;
    },
    wrapGenerate: async ({ params, doGenerate }) => {
      const handle = await nativeBudgetHandle(ctx);
      if (!handle) return doGenerate();
      params.abortSignal?.throwIfAborted();
      const receipt = await reserveNativeBudget(handle, ctx, inputOf(params), params.maxOutputTokens!);
      let dispatched = false;
      try {
        params.abortSignal?.throwIfAborted();
        await markNativeBudgetDispatched(receipt); dispatched = true;
        const result = await doGenerate();
        await settleNativeBudget(receipt, result.usage.inputTokens.total, result.usage.outputTokens.total);
        return result;
      } catch (error) {
        if (dispatched) await uncertain(receipt, ctx); else await releaseNativeBudget(receipt);
        throw error;
      }
    },
    wrapStream: async ({ params, doStream }) => {
      const handle = await nativeBudgetHandle(ctx);
      if (!handle) return doStream();
      params.abortSignal?.throwIfAborted();
      const receipt = await reserveNativeBudget(handle, ctx, inputOf(params), params.maxOutputTokens!);
      let dispatched = false;
      try {
        params.abortSignal?.throwIfAborted(); await markNativeBudgetDispatched(receipt); dispatched = true;
        const { stream, ...rest } = await doStream(); const reader = stream.getReader();
        let completed = false; let failed = false; let sawFinish = false;
        return { ...rest, stream: new ReadableStream({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) { if (!completed) await uncertain(receipt, ctx, !sawFinish); controller.close(); return; }
              if (part.value.type === "error") failed = true;
              if (part.value.type === "finish") {
                sawFinish = true;
                const complete = !failed && ["stop", "length", "tool-calls"].includes(part.value.finishReason.unified);
                await settleNativeBudget(receipt, part.value.usage.inputTokens.total, part.value.usage.outputTokens.total, { complete });
                completed = complete;
              }
              controller.enqueue(part.value);
            } catch (error) { if (!completed) await uncertain(receipt, ctx, !sawFinish); controller.error(error); }
          },
          async cancel(reason) { if (!completed) await uncertain(receipt, ctx, !sawFinish); await reader.cancel(reason); },
        }) };
      } catch (error) {
        if (dispatched) await uncertain(receipt, ctx); else await releaseNativeBudget(receipt);
        throw error;
      }
    },
  };
}

/** Embedding batches and retries reserve separately, sharing the exact same root. */
export function nativeEmbeddingBudgetMiddleware(ctx: UsageContext): EmbeddingModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapEmbed: async ({ params, doEmbed }) => {
      const handle = await nativeBudgetHandle(ctx);
      if (!handle) return doEmbed();
      const route = nativeBudgetRoute(handle.policy, ctx.providerKind, ctx.model);
      if (route.outputMicrosPerMillion !== undefined && route.outputMicrosPerMillion !== 0) throw new NativeRunBudgetError("Embedding budget rates must explicitly use zero output cost.");
      params.abortSignal?.throwIfAborted();
      const receipt = await reserveNativeBudget(handle, ctx, { values: params.values, providerOptions: params.providerOptions }, 0);
      let dispatched = false;
      try {
        params.abortSignal?.throwIfAborted(); await markNativeBudgetDispatched(receipt); dispatched = true;
        const result = await doEmbed();
        await settleNativeBudget(receipt, result.usage?.tokens, 0);
        await recordUsage(ctx, mapUsage({ inputTokens: { total: result.usage?.tokens } }));
        return result;
      } catch (error) { if (dispatched) await uncertain(receipt, ctx); else await releaseNativeBudget(receipt); throw error; }
    },
  };
}
