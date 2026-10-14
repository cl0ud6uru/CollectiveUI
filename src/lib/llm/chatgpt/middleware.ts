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
 * Shapes calls for the public Responses API: carry the full locally assembled history, avoid server storage, and
 * keep the existing local function-tool loop. The native adapter supports streaming chat only.
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
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        ...(opts.conversationId ? { promptCacheKey: opts.conversationId.slice(0, 64) } : {}),
      };
      return {
        ...params,
        prompt: params.prompt.filter((m) => m.role !== "system"),
        providerOptions: { ...params.providerOptions, openai },
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
