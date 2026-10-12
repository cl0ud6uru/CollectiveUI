import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { loadPrincipal } from "@/lib/auth/groups";
import { getOwnedConversation, HttpError } from "@/lib/authz";
import { resolveTurnTarget } from "@/lib/agent/target";
import { activeRunOf, getRun } from "@/lib/runs/state";
import { OPEN_STATUSES } from "@/lib/runs/types";
import { auth } from "@/auth";
import { activeWebSession, webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { resolveWorkspace } from "@/lib/workspaces/instances";
import type { AgentBrowserScope, BrowserSessionSource } from "./contracts";

/**
 * The W4 browser-runtime owner installs the server-side resolver. It must address its private broker using
 * server-controlled credentials and the admitted owner/bot/run scope; this module never accepts a CDP URL or
 * browser-provided session handle. No resolver means the feature is unavailable, not a reason to start a browser.
 */
export type BrowserSessionSourceResolver = (
  scope: AgentBrowserScope,
  signal: AbortSignal,
) => Promise<BrowserSessionSource | null>;

const resolverKey = "__collectiveAgentBrowserViewerSourceResolver__" as const;
type ProcessGlobal = typeof globalThis & { [resolverKey]?: BrowserSessionSourceResolver };
const processGlobal = globalThis as ProcessGlobal;

/** Called only by the server-side browser runtime integration. Returns an unregister hook for shutdown/tests. */
export function registerBrowserSessionSourceResolver(resolver: BrowserSessionSourceResolver) {
  const current = processGlobal[resolverKey];
  if (current && current !== resolver) throw new Error("An agent browser source resolver is already registered.");
  processGlobal[resolverKey] = resolver;
  return () => { if (processGlobal[resolverKey] === resolver) delete processGlobal[resolverKey]; };
}

export async function resolveBrowserSessionSource(scope: AgentBrowserScope, signal: AbortSignal): Promise<BrowserSessionSource | null> {
  const resolver = processGlobal[resolverKey];
  if (!resolver || signal.aborted) return null;
  const source = await resolver(scope, signal);
  if (!source || signal.aborted) return null;
  // Fail closed if an adapter resolves a different owner's page, run, bot or instance.
  if (source.ownerUserId !== scope.ownerUserId || source.botId !== scope.botId || source.runId !== scope.runId ||
      source.workspaceInstanceId !== scope.workspaceInstanceId || typeof source.sessionId !== "string" ||
      !source.sessionId || source.sessionId.length > 256 || typeof source.status !== "function" ||
      typeof source.subscribeFrames !== "function") return null;
  return source;
}

export type AuthorizedBrowserView = {
  scope: AgentBrowserScope;
  source: BrowserSessionSource;
  authorize: () => Promise<void>;
};

/** Resolve only this signed-in owner's direct chat run. No request-supplied bot/run/session selector is trusted. */
export async function browserViewForConversation(principal: Principal, conversationId: string, signal: AbortSignal): Promise<AuthorizedBrowserView | null> {
  const conversation = await getOwnedConversation(principal, conversationId);
  if (conversation.source !== "chat" || conversation.isGroup || !conversation.botId) return null;

  const target = await resolveTurnTarget(principal, conversation);
  if (!target.bot || target.bot.id !== conversation.botId) return null;

  let run = await activeRunOf(conversation.id);
  if (!run) {
    const [recent] = await db.select().from(agentRuns)
      .where(and(eq(agentRuns.conversationId, conversation.id), eq(agentRuns.userId, principal.user.id)))
      .orderBy(desc(agentRuns.createdAt)).limit(1);
    run = recent ?? null;
  }
  if (!run || !(OPEN_STATUSES as readonly string[]).includes(run.status) || run.userId !== principal.user.id ||
      run.conversationId !== conversation.id || run.botId !== target.bot.id) return null;

  const workspace = await resolveWorkspace({ principal, botId: target.bot.id, createIfMissing: false });
  if (workspace && (workspace.ownerUserId !== principal.user.id || workspace.botId !== target.bot.id)) return null;
  const scope: AgentBrowserScope = { ownerUserId: principal.user.id, botId: target.bot.id, runId: run.id, workspaceInstanceId: workspace?.instanceId ?? null };
  const source = await resolveBrowserSessionSource(scope, signal);
  if (!source) return null;
  const authorize = () => reauthorizeBrowserView(principal, conversationId, scope);
  await authorize();
  return { scope, source, authorize };
}

/** Recheck account/session version, conversation ownership, bot access and run binding during long-lived streams. */
export async function reauthorizeBrowserView(principal: Principal, conversationId: string, scope: AgentBrowserScope): Promise<void> {
  // requirePrincipal is React-cached per request and would keep returning the initial stream principal.
  // Re-read Auth.js directly so absolute expiry, provider disablement and password-change state are rechecked.
  const session = await auth();
  if (!session?.user?.id || session.user.id !== principal.user.id || session.user.mustChangePassword ||
      session.user.sessionVersion !== principal.user.sessionVersion) throw new HttpError(401, "Unauthorized");
  if (!webSessionRegistryEnabled() || !await activeWebSession({ userId: session.user.id, sessionId: session.user.sessionId,
    sessionVersion: session.user.sessionVersion })) throw new HttpError(401, "Unauthorized");
  const fresh = await loadPrincipal(principal.user.id);
  if (!fresh || fresh.user.sessionVersion !== principal.user.sessionVersion) throw new HttpError(401, "Unauthorized");
  const conversation = await getOwnedConversation(fresh, conversationId);
  if (conversation.source !== "chat" || conversation.isGroup || conversation.botId !== scope.botId) throw new HttpError(404, "Conversation not found.");
  const target = await resolveTurnTarget(fresh, conversation);
  const workspace = await resolveWorkspace({ principal: fresh, botId: scope.botId, createIfMissing: false });
  if ((workspace?.instanceId ?? null) !== scope.workspaceInstanceId || workspace && (workspace.ownerUserId !== fresh.user.id || workspace.botId !== scope.botId)) throw new HttpError(404, "Browser session not found.");
  const run = await getRun(scope.runId);
  if (!target.bot || target.bot.id !== scope.botId || !run || !(OPEN_STATUSES as readonly string[]).includes(run.status) || run.userId !== fresh.user.id ||
      run.conversationId !== conversation.id || run.botId !== scope.botId || scope.ownerUserId !== fresh.user.id) {
    throw new HttpError(404, "Browser session not found.");
  }
}
