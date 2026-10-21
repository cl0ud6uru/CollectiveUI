import type { LanguageModelMiddleware } from "ai";
import { isAnthropicFamily, speaksResponses, type AnyProviderConfig, type EnabledKind } from "./catalog";
import { mapUsage, recordUsage, type ProviderUsage, type UsageContext } from "./usage";

type Purpose = UsageContext["purpose"] | "probe";
type StreamPart<S> = S extends ReadableStream<infer T> ? T : never;

/**
 * Provider defaults for native providers (never applied to OpenAI-compatible apps, which must stay byte-identical).
 * Values set by the call site win, except where a provider would otherwise reject the request.
 */
export function defaultsMiddleware(kind: EnabledKind, config: AnyProviderConfig, modelId: string, purpose: Purpose): LanguageModelMiddleware {
  const cfg = config as { store?: boolean; reasoning?: boolean };
  const anthropicFamily = isAnthropicFamily(kind, config, modelId);
  const responses = speaksResponses(kind);
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const p = { ...params };
      if (responses) {
        // Keep conversation state in the portal: no server-side storage or item_reference replay.
        const ns = kind === "azure" ? "azure" : "openai";
        const defaults = { store: cfg.store ?? false, ...(cfg.reasoning ? { forceReasoning: true } : {}) };
        p.providerOptions = { ...p.providerOptions, [ns]: { ...defaults, ...(p.providerOptions?.[ns] ?? {}) } };
      }
      if (cfg.reasoning) {
        // Deployment names hide that a model reasons; reasoning models reject sampling settings.
        p.temperature = undefined;
        p.topP = undefined;
        p.topK = undefined;
      }
      // Unknown Claude model ids (Foundry deployments, Bedrock ARNs) otherwise get a small default.
      if (anthropicFamily && p.maxOutputTokens == null) p.maxOutputTokens = 8192;
      if (purpose === "title" || purpose === "probe") {
        // Some models think by default, which would eat a small output budget and return nothing.
        p.reasoning = "none";
        const floor = anthropicFamily ? (purpose === "probe" ? 64 : 1024) : responses ? (purpose === "probe" ? 64 : 512) : 0;
        if ((p.maxOutputTokens ?? 0) < floor) p.maxOutputTokens = floor;
      }
      return p;
    },
  };
}

/**
 * Records one usage row per provider call (every step of a multi-step turn). Params are untouched, so the
 * request is identical with or without this middleware. Missing provider counters remain null.
 */
/**
 * `skipUnknown` omits clean finishes without counters (a Hermes approval pause;
 * its run reports whole-turn usage later). Interrupted streams still leave evidence.
 */
export function usageMiddleware(ctx: UsageContext, opts: { skipUnknown?: boolean } = {}): LanguageModelMiddleware {
  const record = (usage: ProviderUsage | undefined, metadata?: unknown, completionStatus: "complete" | "incomplete" = "complete") => {
    const tokens = mapUsage(usage);
    if (opts.skipUnknown && completionStatus === "complete" && tokens.inputTokens === null && tokens.outputTokens === null) return Promise.resolve();
    const reported = (metadata as { hermes?: { model?: unknown } } | undefined)?.hermes?.model;
    // A Hermes route/default is not necessarily the runtime it chose. Never label that fallback as reported usage.
    const model = ctx.providerKind === "hermes"
      ? typeof reported === "string" && reported.trim() && reported.length <= 300 ? reported.trim() : "unreported"
      : ctx.model;
    return recordUsage({ ...ctx, model, completionStatus }, tokens);
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      record(result.usage as ProviderUsage, result.providerMetadata);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      const reader = stream.getReader();
      let recorded: Promise<void> | undefined, failed = false;
      const once = (usage?: ProviderUsage, metadata?: unknown, status: "complete" | "incomplete" = "incomplete") =>
        recorded ??= record(usage, metadata, status);
      // TransformStream.flush misses source errors and consumer cancellation. Owning
      // the reader makes all terminal paths observable and forwards cancellation.
      const tracked = new ReadableStream<StreamPart<typeof stream>>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) { await once(); controller.close(); return; }
            if (part.value.type === "error") failed = true;
            if (part.value.type === "finish") await once(part.value.usage as ProviderUsage, part.value.providerMetadata,
              !failed && ["stop", "length", "tool-calls"].includes(part.value.finishReason.unified) ? "complete" : "incomplete");
            controller.enqueue(part.value);
          } catch (error) {
            await once();
            controller.error(error);
          }
        },
        async cancel(reason) { await once(); await reader.cancel(reason); },
      });
      return { stream: tracked, ...rest };
    },
  };
}
