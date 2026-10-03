import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, aiApps, botTools, conversations, groups, toolGrants, mcpServers, type BotToolConfig, type McpServer } from "@/db/schema";
import type { AgentCtx } from "@/lib/agent/types";
import { loadPrincipal } from "@/lib/auth/groups";
import { getUsableBot, HttpError, listAccessibleMcpServers } from "@/lib/authz";
import { activeServiceGrants, assertServicePublished } from "@/lib/bots/service";
import { assertArgumentConstraints } from "@/lib/bots/service-policy";
import { sha256Hex } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { assertDelegationPath } from "@/lib/coordinator/delegation";
import { canonicalJson, toolHash } from "./snapshot";
import { offeredTools } from "./servers";
import type { McpToolDef } from "./kinds";

export type ServiceGrant = Awaited<ReturnType<typeof activeServiceGrants>>[number];

/** Opaque binding only: secrets are hashed, never placed in model definitions, messages or audit records. */
export async function mcpAuthorityBinding(ctx: AgentCtx, server: McpServer, config: BotToolConfig | null, grants: ServiceGrant[], identityGroups?: string[]) {
  const u = ctx.principal.user;
  const approvals = await db.select({ name: toolGrants.toolName }).from(toolGrants).where(and(
    eq(toolGrants.userId, u.id), eq(toolGrants.botId, ctx.bot!.id),
  ));
  const names = identityGroups ?? (ctx.principal.groupIds.length && server.identityHeader
    ? (await db.select({ name: groups.name }).from(groups).where(inArray(groups.id, ctx.principal.groupIds))).map(g => g.name).sort() : []);
  return sha256Hex(canonicalJson({
    actor: { id: u.id, upn: u.upn, email: u.email, name: u.name, session: u.sessionVersion,
      groups: [...ctx.principal.groupIds].sort(), admin: ctx.principal.isAdmin },
    identityGroups: names, rememberedApprovals: approvals.map(a => a.name).sort(),
    bot: ctx.bot, app: ctx.app, config, settings: ctx.toolSettings,
    server, grants: [...grants].sort((a, b) => a.id.localeCompare(b.id)),
    conversation: ctx.conversationId, run: ctx.usage?.runId ?? null,
  }));
}

export async function assertDirectServiceContext(ctx: AgentCtx) {
  if (ctx.bot?.executionMode !== "service") return;
  if (ctx.depth !== 0 || ctx.inGroup || ctx.background)
    throw new HttpError(403, "Service bots can only run in direct chats. Delegation, group chats and routines are not supported.");
  const [conv] = await db.select().from(conversations).where(and(
    eq(conversations.id, ctx.conversationId), eq(conversations.userId, ctx.principal.user.id),
  ));
  if (!conv || conv.source !== "chat" || conv.isGroup || conv.botId !== ctx.bot.id)
    throw new HttpError(403, "This service bot requires its own direct chat.");
  if (ctx.usage?.runId) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, ctx.usage.runId));
    if (!run || run.routineRunId || run.background || run.userId !== ctx.principal.user.id ||
        run.botId !== ctx.bot.id || run.conversationId !== conv.id)
      throw new HttpError(403, "Service bots cannot run from routines or another bot.");
  }
  await assertServicePublished(ctx.bot);
}

export function checkedServiceGrant(server: McpServer, grants: ServiceGrant[], def: McpToolDef, revision: number) {
  const grant = grants.find((g) => g.toolName === def.name && g.serverId === server.id && g.botRevision === revision && !g.revokedAt);
  if (!grant || grant.serverRevision !== server.policyRevision || grant.toolHash !== toolHash(def) ||
      !server.identityHeader || !server.identitySecretEnc || server.trust !== "trusted")
    throw new HttpError(403, "This service tool needs a new admin review and publication.");
  return grant;
}

/** Every MCP dispatch, including reused clients and approved continuations, passes this gate. */
export async function authorizeMcpInvocation(
  ctx: AgentCtx, expected: string, original: McpServer, def: McpToolDef, input: unknown,
) {
  const principal = await loadPrincipal(ctx.principal.user.id);
  if (!principal || principal.user.sessionVersion !== ctx.principal.user.sessionVersion)
    throw new HttpError(403, "Your account or session changed. Start a new chat turn.");
  const bot = ctx.bot ? await getUsableBot(principal, ctx.bot.id) : null;
  if (!bot) throw new HttpError(403, "MCP tools require an authorized bot.");
  const [[server], [configured], [app], toolSettings] = await Promise.all([
    db.select().from(mcpServers).where(eq(mcpServers.id, original.id)),
    db.select().from(botTools).where(and(eq(botTools.botId, bot.id), eq(botTools.toolKey, `mcp:${original.id}`))),
    db.select().from(aiApps).where(eq(aiApps.id, bot.appId ?? "")),
    getSetting("tools"),
  ]);
  if (!server || !["enabled", "needs_review"].includes(server.status) || !configured || !app?.enabled ||
      !app.supportsTools || toolSettings.disabledTools.includes("mcp") || toolSettings.disabledTools.includes(`mcp:${server.id}`))
    throw new HttpError(403, "This MCP tool is no longer available.");
  const fresh: AgentCtx = { ...ctx, principal, bot, app, toolSettings };
  let grants: ServiceGrant[] = [];
  if (bot.executionMode === "service") {
    await assertDirectServiceContext(fresh);
    grants = (await activeServiceGrants(bot.id)).filter((g) => g.serverId === server.id);
  } else if (!(await listAccessibleMcpServers(principal)).some((s) => s.id === server.id)) {
    throw new HttpError(403, "You no longer have access to this MCP server.");
  }
  // The legacy pre-snapshot path still uses its discovered definitions. Service grants always require a snapshot.
  const current = server.toolsSnapshot ? offeredTools(server).find((t) => t.name === def.name) : def;
  if (!current || toolHash(current) !== toolHash(def) || server.toolPolicy[def.name]?.enabled === false ||
      (configured.config?.tools && !configured.config.tools.includes(def.name)))
    throw new HttpError(403, "This tool is no longer approved for this bot.");
  if (ctx.delegationPath?.length) await assertDelegationPath(ctx);
  const binding = await mcpAuthorityBinding(fresh, server, configured.config ?? null, grants);
  if (binding !== expected)
    throw new HttpError(403, "Tool permissions or configuration changed. Start a new turn and review the new request.");
  const grant = bot.executionMode === "service" ? checkedServiceGrant(server, grants, current, bot.revision) : null;
  if (grant) assertArgumentConstraints(input, grant.constraints, principal.user);
  return { principal, server, grant };
}
