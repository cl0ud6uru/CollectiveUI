import { hostedSearchTool } from "./providers/openai";
export { hostedSearchTool };
import { createHash } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { hostedSearchBudgets } from "@/db/schema";
import { NATIVE_SEARCH_KEY, SEARCH_CALL_MICROS } from "@/lib/native-search-policy";
import { ProviderUnavailableError } from "./errors";
import { mapUsage, recordUsage, type UsageContext } from "./usage";

export type NativeSearchOptions = { maxCalls: number; authorize: () => Promise<void> };
export type SearchBudget = { reserve: () => Promise<number>; settle: (reserved: number, observed: number) => Promise<void> };
export function durableSearchBudget(ctx: UsageContext, maxCalls: number): SearchBudget {
  const messageId = ctx.scope?.messageId;
  const conversationId = ctx.conversationId;
  if (!messageId || !conversationId) throw new ProviderUnavailableError("Native search requires a persisted conversation and reply budget.");
  return {
    reserve: () => db.transaction(async tx => {
      await tx.insert(hostedSearchBudgets).values({ messageId, conversationId, maxCalls }).onConflictDoNothing();
      const [row] = await tx.select().from(hostedSearchBudgets).where(eq(hostedSearchBudgets.messageId, messageId)).for("update");
      if (!row || row.conversationId !== conversationId) throw new ProviderUnavailableError("Native search budget is unavailable.");
      const remaining = Math.max(0, Math.min(row.maxCalls, maxCalls) - row.reservedCalls);
      if (remaining) await tx.update(hostedSearchBudgets).set({ reservedCalls: row.reservedCalls + remaining }).where(eq(hostedSearchBudgets.messageId, messageId));
      return remaining;
    }),
    // Only a completed provider response proves unused capacity. Interrupted calls retain the entire reservation.
    settle: async (reserved, observed) => {
      if (observed > reserved) throw new ProviderUnavailableError("OpenAI exceeded the native-search call limit. Search stopped; no fallback was selected.");
      await db.update(hostedSearchBudgets).set({ reservedCalls: sql`${hostedSearchBudgets.reservedCalls} - ${reserved - observed}` }).where(eq(hostedSearchBudgets.messageId, messageId));
    },
  };
}

/** max_tool_calls is sent before execution; local approval callbacks cannot intercept hosted tools. */
export function nativeSearchMiddleware(ctx: UsageContext, options: NativeSearchOptions, budget = durableSearchBudget(ctx, options.maxCalls)): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapStream: async ({ params, doStream }) => {
      if (!params.tools?.some(t => t.type === "provider" && t.id === "openai.web_search" && t.name === NATIVE_SEARCH_KEY)) return doStream();
      await options.authorize();
      const reserved = await budget.reserve();
      if (!reserved) {
        params.tools = params.tools.filter(t => t.name !== NATIVE_SEARCH_KEY);
        return doStream();
      }
      params.providerOptions = { ...params.providerOptions, openai: { ...params.providerOptions?.openai, maxToolCalls: reserved } };
      const { stream, ...rest } = await doStream();
      const seen = new Set<string>();
      let failed = false;
      return { ...rest, stream: stream.pipeThrough(new TransformStream({
        async transform(part, controller) {
          if (part.type === "error") failed = true;
          if (part.type === "tool-call" && part.providerExecuted && part.toolName === NATIVE_SEARCH_KEY && !seen.has(part.toolCallId)) {
            seen.add(part.toolCallId);
            // Counts observed executions, including calls before cancellation. Never infer calls from citations.
            const id = createHash("sha256").update(`${ctx.scope?.messageId}:${part.toolCallId}`).digest("hex");
            void recordUsage(ctx, mapUsage(undefined), { id: `search-${id}`, toolCallId: part.toolCallId, hostedSearchCalls: 1, searchToolCostEstimateMicros: SEARCH_CALL_MICROS });
            if (seen.size > reserved) {
              failed = true;
              controller.enqueue({ type: "error", error: new ProviderUnavailableError("OpenAI exceeded the native-search call limit. Search stopped; no fallback was selected.") });
              controller.terminate();
              return;
            }
          }
          if (part.type === "finish" && !failed && ["stop", "length", "tool-calls"].includes(part.finishReason.unified) && part.usage.inputTokens.total !== undefined) await budget.settle(reserved, seen.size);
          controller.enqueue(part);
        },
      })) };
    },
    // The feature is attached only to streaming chat turns. Refuse accidental generation paths.
    wrapGenerate: async () => { throw new ProviderUnavailableError("Native search is only available in streaming chats."); },
  };
}
