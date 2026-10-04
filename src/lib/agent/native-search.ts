import type { ToolSet } from "ai";
import type { NativeSearchOptions } from "@/lib/llm/native-search";
import { and, eq } from "drizzle-orm";
import { hostedSearchTool } from "@/lib/llm/native-search";
import { db } from "@/db";
import { aiApps, conversations, botTools, type AiApp, type Bot, type ApprovalMode } from "@/db/schema";
import { activeProviderConnection } from "@/lib/llm/provider-connections";
import { nativeSearchCapability, nativeSearchPolicy, NATIVE_SEARCH_KEY, type NativeSearchMode } from "@/lib/native-search-policy";
import { ProviderUnavailableError } from "@/lib/llm/errors";
import { getSetting, type ToolSettings } from "@/lib/settings";
import type { AgentCtx } from "./types";

export async function nativeSearchAvailability(app: AiApp, settings: ToolSettings, approval: ApprovalMode = "auto") {
  let endpoint = app.baseUrl;
  if (app.providerConnectionId) {
    const connection = await activeProviderConnection(app.providerConnectionId).catch(() => null);
    if (!connection || connection.provider !== app.provider) return "The saved provider connection is unavailable.";
    endpoint = connection.baseUrl;
  }
  return nativeSearchCapability(app, endpoint) ?? nativeSearchPolicy(settings, approval);
}
export async function nativeSearchSelection(app: AiApp, bot: Bot | null, settings: ToolSettings, mode?: NativeSearchMode | null, configured?: { approval: ApprovalMode } | null) {
  const [stored] = bot && configured === undefined ? await db.select().from(botTools).where(and(eq(botTools.botId, bot.id), eq(botTools.toolKey, NATIVE_SEARCH_KEY))) : [];
  const choice = configured === undefined ? stored : configured;
  const reason = bot?.executionMode === "service" ? "Service bots support reviewed MCP tools only."
    : bot && !choice ? "This bot has not enabled OpenAI native search. Enable it in the bot's Tools settings."
    : await nativeSearchAvailability(app, settings, choice?.approval);
  return { reason, mode: mode ?? (choice ? "auto" : "off") as NativeSearchMode };
}
export async function nativeSearchFor(ctx: AgentCtx, configured?: { toolKey: string; approval: ApprovalMode }[]): Promise<{ tools: ToolSet; warnings: string[]; nativeSearch?: NativeSearchOptions }> {
  const selection = await nativeSearchSelection(ctx.app, ctx.bot, ctx.toolSettings, ctx.nativeSearchMode, configured ? configured.find(t => t.toolKey === NATIVE_SEARCH_KEY) ?? null : undefined);
  if (selection.mode !== "auto") return { tools: {}, warnings: [] };
  if (selection.reason) return { tools: {}, warnings: [`OpenAI native search unavailable: ${selection.reason} No automatic fallback was selected.`] };
  const settings = ctx.toolSettings.nativeSearch!;
  return {
    tools: { [NATIVE_SEARCH_KEY]: hostedSearchTool(settings.allowedDomains) },
    warnings: [],
    nativeSearch: { maxCalls: settings.maxCalls, authorize: async () => {
      const freshSettings = await getSetting("tools");
      const [app] = await db.select().from(aiApps).where(eq(aiApps.id, ctx.app.id));
      const [conversation] = await db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
      if (!app?.enabled || !conversation || conversation.userId !== ctx.principal.user.id) throw new ProviderUnavailableError("Native search access is no longer available.");
      const identity = (a: AiApp) => JSON.stringify([a.provider, a.model, a.baseUrl, a.credentialMode, a.providerConnectionId, a.supportsTools]);
      if (identity(app) !== identity(ctx.app)) throw new ProviderUnavailableError("The model connection changed. Start a new request.");
      if (conversation.nativeSearchMode === "off") throw new ProviderUnavailableError("Native search was switched off for this chat.");
      if (JSON.stringify(freshSettings.nativeSearch) !== JSON.stringify(settings)) throw new ProviderUnavailableError("Hosted search policy changed. Start a new request to apply the current limits and domain filter.");
      const current = await nativeSearchSelection(ctx.app, ctx.bot, freshSettings, ctx.nativeSearchMode);
      if (current.reason || current.mode !== "auto") throw new ProviderUnavailableError(current.reason ?? "Native search was disabled.");
    } },
  };
}
