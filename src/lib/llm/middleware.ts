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
 * request is identical with or without this middleware. A step aborted mid-stream has no usage to record.
 */
/**
 * Records every call's usage. `skipUnknown`: calls that report no token counts aren't recorded (a Hermes turn paused
 * for approval; its run reports the whole usage when it finishes).
 */
export function usageMiddleware(ctx: UsageContext, opts: { skipUnknown?: boolean } = {}): LanguageModelMiddleware {
  const record = (usage: ProviderUsage, metadata?: unknown) => {
    const tokens = mapUsage(usage);
    if (opts.skipUnknown && tokens.inputTokens === null && tokens.outputTokens === null) return;
    const reported = (metadata as { hermes?: { model?: unknown } } | undefined)?.hermes?.model;
    // A Hermes route/default is not necessarily the runtime it chose. Never label that fallback as reported usage.
    const model = ctx.providerKind === "hermes"
      ? typeof reported === "string" && reported.trim() && reported.length <= 300 ? reported.trim() : "unreported"
      : ctx.model;
    void recordUsage({ ...ctx, model }, tokens);
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
      const tap = new TransformStream<StreamPart<typeof stream>, StreamPart<typeof stream>>({
        transform(part, controller) {
          if (part.type === "finish") record(part.usage as ProviderUsage, part.providerMetadata);
          controller.enqueue(part);
        },
      });
      return { stream: stream.pipeThrough(tap), ...rest };
    },
  };
}
