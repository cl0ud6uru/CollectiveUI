import { generateText } from "ai";
import type { AiApp } from "@/db/schema";
import { resolveModel } from "./resolve";
import type { UsageScope } from "./usage";

export type TitleContext = { userId: string; conversationId: string; botId?: string | null; usage?: UsageScope; abortSignal?: AbortSignal };

export const TITLE_TIMEOUT_MS = 5_000;

export async function generateTitle(app: AiApp, userText: string, ctx: TitleContext): Promise<string> {
  const { abortSignal, ...context } = ctx;
  const timeout = new AbortController();
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(new Error("Title generation timed out")), TITLE_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Bound resolution too, and stop waiting even if a provider ignores cancellation. The caller already
    // falls back to the user's text; optional title generation must not hold a completed reply open.
    return await Promise.race([aborted, (async () => {
      const { model } = await resolveModel(app, { purpose: "title", ...context });
      signal.throwIfAborted();
      const { text } = await generateText({
        model,
        instructions:
          "Write a short title (max 6 words) for a chat that starts with the user's message below. Reply with the title only — no quotes or punctuation at the end.",
        prompt: userText.slice(0, 2000),
        maxOutputTokens: 30,
        temperature: 0.3,
        abortSignal: signal,
        maxRetries: 0,
      });
      return text.replace(/^["'\s#*]+|["'\s.]+$/g, "").slice(0, 80) || "New chat";
    })()]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
