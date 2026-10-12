import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, botTools } from "@/db/schema";
import { loadPrincipal } from "@/lib/auth/groups";
import { getOwnedConversation, getUsableBot, HttpError } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import { userMayUseWorkspace } from "@/lib/sandbox/policy";
import type { AgentCtx } from "@/lib/agent/types";
import type { BrowserScope } from "./provider-contract";

/** Rechecked on every operation. Native direct durable caller runs only in this bounded first adapter. */
export async function assertBrowserAdmission(ctx: AgentCtx, scope: BrowserScope) {
  if (!ctx.bot || ctx.depth !== 0 || ctx.inGroup || ctx.bot.executionMode !== "caller" ||
      ctx.bot.hermesTeam || ctx.app.provider === "hermes" || ctx.app.providerConfig?.codexHarness === true || !ctx.app.supportsTools || !ctx.usage?.runId ||
      scope.ownerUserId !== ctx.principal.user.id || scope.botId !== ctx.bot.id ||
      scope.conversationId !== ctx.conversationId || scope.runId !== ctx.usage.runId)
    throw new HttpError(403, "Agent browser run is not admitted");
  const principal = await loadPrincipal(ctx.principal.user.id);
  const settings = await getSetting("sandbox"); const tools = await getSetting("tools");
  if (!principal || principal.user.sessionVersion !== ctx.principal.user.sessionVersion || !userMayUseWorkspace(principal, settings) ||
      ["agent_browser", "workspace", "web_search", "fetch_url"].some(k => tools.disabledTools.includes(k)))
    throw new HttpError(403, "Agent browser access is unavailable");
  const bot = await getUsableBot(principal, scope.botId);
  const conv = await getOwnedConversation(principal, scope.conversationId);
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, scope.runId), eq(agentRuns.userId, scope.ownerUserId)));
  const [configured] = await db.select().from(botTools).where(and(eq(botTools.botId, scope.botId), eq(botTools.toolKey, "agent_browser")));
  if (!configured || bot.executionMode !== "caller" || conv.botId !== scope.botId || !run || run.botId !== scope.botId ||
      run.conversationId !== scope.conversationId || run.status !== "running" || run.cancelRequestedAt ||
      (ctx.execution && run.holder !== ctx.execution.holder)) throw new HttpError(403, "Agent browser run is no longer admitted");
}
