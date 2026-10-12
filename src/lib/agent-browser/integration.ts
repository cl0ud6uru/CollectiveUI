import "server-only";
import { auth } from "@/auth";
import { loadPrincipal } from "@/lib/auth/groups";
import { activeWebSession, webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { getOwnedConversation, getUsableBot, HttpError } from "@/lib/authz";
import { db } from "@/db";
import { botTools } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { webSessions } from "@/db/web-sessions";
import { getRun } from "@/lib/runs/state";
import { OPEN_STATUSES } from "@/lib/runs/types";
import { getSetting } from "@/lib/settings";
import { userMayUseWorkspace } from "@/lib/sandbox/policy";
import { selectedBrowserWorkspace } from "./native-integration";
import { registerBrowserSessionSourceResolver } from "./session-source";
import { installBrowserSessionSourceResolver, type ViewerBrowserScope } from "./viewer-source-adapter";

/** Re-evaluate the original request's durable session on EVERY lookup/status/frame poll. */
export async function admitIntegratedBrowserViewer(scope: ViewerBrowserScope) {
  if (!webSessionRegistryEnabled()) throw new HttpError(503, "Browser session prerequisites are unavailable");
  const session = await auth();
  if (!session?.user?.id || session.user.id !== scope.ownerUserId || session.user.mustChangePassword ||
      !await activeWebSession({ userId: session.user.id, sessionId: session.user.sessionId, sessionVersion: session.user.sessionVersion })) throw new HttpError(401, "Unauthorized");
  const principal = await loadPrincipal(scope.ownerUserId);
  if (!principal || principal.user.sessionVersion !== session.user.sessionVersion) throw new HttpError(401, "Unauthorized");
  const settings = await getSetting("sandbox"); const tools = await getSetting("tools");
  if (!userMayUseWorkspace(principal, settings) || ["agent_browser", "workspace", "web_search", "fetch_url"].some(k => tools.disabledTools.includes(k))) throw new HttpError(403, "Browser view unavailable");
  const bot = await getUsableBot(principal, scope.botId); const run = await getRun(scope.runId);
  const [configured] = await db.select().from(botTools).where(and(eq(botTools.botId, scope.botId), eq(botTools.toolKey, "agent_browser")));
  if (!configured || bot.executionMode !== "caller" || bot.hermesTeam || !run || run.userId !== principal.user.id || run.botId !== bot.id ||
      !(OPEN_STATUSES as readonly string[]).includes(run.status) || run.cancelRequestedAt) throw new HttpError(404, "Browser session not found");
  const conversation = await getOwnedConversation(principal, run.conversationId);
  if (conversation.source !== "chat" || conversation.isGroup || conversation.botId !== scope.botId) throw new HttpError(404, "Browser session not found");
  const workspace = await selectedBrowserWorkspace(principal, scope.botId);
  if ((workspace?.instanceId ?? null) !== scope.workspaceInstanceId) throw new HttpError(403, "Workspace binding changed");
  return { ...scope, conversationId: conversation.id };
}

/** Web startup only. Missing migration/registry fails closed, never supplies a synthetic or unrelated source. */
export async function registerAgentBrowserViewerIntegration() {
  if (process.env.AGENT_BROWSER_ENABLED !== "1") return;
  if (!webSessionRegistryEnabled()) throw new Error("Agent browser requires the durable web-session registry");
  await db.select({ hash: webSessions.sessionIdHash }).from(webSessions).limit(0);
  installBrowserSessionSourceResolver(registerBrowserSessionSourceResolver, admitIntegratedBrowserViewer);
}
