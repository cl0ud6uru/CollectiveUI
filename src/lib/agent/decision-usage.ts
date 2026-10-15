import { DECISIONS_MODEL } from "@/lib/decisions-policy";
import type { providerContextFor } from "@/lib/llm/resolve";
import type { UsageContext } from "@/lib/llm/usage";
import type { AgentCtx } from "./types";

/** A direct decision call pays on its selected API connection but shares the caller's root receipt budget. */
export function decisionUsage(ctx: AgentCtx, provider: Awaited<ReturnType<typeof providerContextFor>>): UsageContext {
  return { ...provider.usageAttribution, purpose: "decision", billingSource: "org", providerKind: "openai", model: DECISIONS_MODEL,
    appId: provider.appId, userId: ctx.principal.user.id, conversationId: ctx.conversationId, botId: ctx.bot?.id ?? null, scope: ctx.usage };
}
