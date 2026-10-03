import type { JSONValue, LanguageModelMiddleware } from "ai";
import { ProviderUnavailableError } from "../errors";
import { FALLBACK_INSTRUCTIONS } from "./body";
import { chatgptPlanErrorFrom } from "./errors";

type JSONObject = { [key: string]: JSONValue | undefined };

export type ChatGPTModelOptions = {
  conversationId: string | null;
  /** Admin-chosen reasoning effort; undefined = the model's default. */
  reasoningEffort?: string;
};

/**
 * Shapes calls for the ChatGPT Codex backend using the provider's own options: the portal's instructions go into the
 * top-level `instructions` field (not a developer message), nothing is stored upstream, encrypted reasoning is
 * requested so multi-step turns keep their reasoning, and sampling/length settings the backend rejects are dropped.
 * The backend only streams, so non-streaming calls are refused (ChatGPT apps are never used for background work).
 */
export function chatgptMiddleware(opts: ChatGPTModelOptions): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const instructions = params.prompt
        .flatMap((m) => (m.role === "system" && m.content.trim() ? [m.content] : []))
        .join("\n\n");
      const existing = (params.providerOptions?.openai ?? {}) as JSONObject;
      const openai: JSONObject = {
        ...existing,
        instructions: instructions || FALLBACK_INSTRUCTIONS,
        store: false,
        forceReasoning: true,
        include: ["reasoning.encrypted_content"],
        reasoningSummary: existing.reasoningSummary ?? "auto",
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        ...(opts.conversationId ? { promptCacheKey: opts.conversationId.slice(0, 64) } : {}),
      };
      return {
        ...params,
        prompt: params.prompt.filter((m) => m.role !== "system"),
        providerOptions: { ...params.providerOptions, openai },
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stopSequences: undefined,
        seed: undefined,
      };
    },
    wrapGenerate: async () => {
      throw new ProviderUnavailableError("ChatGPT plan models can only be used for streaming chat.");
    },
    // Plan limits reported inside the stream become the same typed errors as HTTP 429s: never retried, and shown
    // to the person as is.
    wrapStream: async ({ doStream }) => {
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await doStream();
      } catch (err) {
        throw chatgptPlanErrorFrom(err) ?? err;
      }
      const { stream, ...rest } = result;
      type Part = typeof stream extends ReadableStream<infer T> ? T : never;
      const mapped = stream.pipeThrough(
        new TransformStream<Part, Part>({
          transform(part, controller) {
            const planError = part.type === "error" ? chatgptPlanErrorFrom(part.error) : undefined;
            controller.enqueue(planError ? { type: "error", error: planError } : part);
          },
        }),
      );
      return { stream: mapped, ...rest };
    },
  };
}
