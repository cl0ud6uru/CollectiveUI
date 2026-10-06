import { nativeSearchAvailability } from "@/lib/agent/native-search";
import { isDockerHermes, dockerAllowed } from "@/lib/docker-hermes/policy";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments, botMcpGrants, groups, users, knowledgeChunks, type ApprovalMode } from "@/db/schema";
import { servicePublicationStatus } from "@/lib/bots/service";
import type { McpToolDef } from "@/lib/mcp/kinds";
import { toolHash } from "@/lib/mcp/snapshot";
import type { Principal } from "@/lib/auth/groups";
import { BUILTIN_TOOLS } from "@/lib/agent/types";
import { getAccessibleBot, listAccessibleApps, listAccessibleBots, listAccessibleMcpServers } from "@/lib/authz";
import { availableBuiltinKeys } from "@/lib/bots/available-tools";
import { isAgentServer } from "@/lib/llm/catalog";
import { cleanDescription } from "@/lib/mcp/hygiene";
import { offeredTools } from "@/lib/mcp/servers";
import { getSetting } from "@/lib/settings";
import { truncate } from "@/lib/utils";
import { listCatalog } from "@/lib/pets/catalog";
import { listEditableCoordinators } from "@/lib/coordinator/roles";

import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { isLocalHermes } from "@/lib/local-hermes/config";
import { teamBotsEnabled } from "@/lib/hermes-team/policy";
import { hermesTeamDefinitions, hermesTeamMaintainers } from "@/db/schema";
import { loadPrincipal } from "@/lib/auth/groups";
import type { HermesTeamPolicyValue, HermesTeamModelOption } from "@/components/bots/hermes-team-policy";

export type McpToolOption = { name: string; description: string; readOnly: boolean; destructive: boolean; hash: string; definition?: McpToolDef };
export type ToolOption = {
  key: string;
  label: string;
  description: string;
  defaultApproval: ApprovalMode;
  trusted?: boolean;
  mcpTools?: McpToolOption[];
  serverRevision?: number;
  serviceReady?: boolean;
};

export async function loadBuilderData(p: Principal, botId?: string) {
  const [apps, groupRows, servers, bots, toolSettings, builtin, currentBot, petCatalog] = await Promise.all([
    listAccessibleApps(p),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    listAccessibleMcpServers(p),
    listAccessibleBots(p),
    getSetting("tools"),
    availableBuiltinKeys(p),
    botId ? getAccessibleBot(p, botId) : null,
    listCatalog(p),
  ]);
  const disabled = new Set(toolSettings.disabledTools);
  const tools: ToolOption[] = [
    ...BUILTIN_TOOLS.filter((t) => builtin.has(t.key)),
    ...(disabled.has("mcp")
      ? []
      : servers.filter((s) => !disabled.has(`mcp:${s.id}`)).map((s) => ({
          key: `mcp:${s.id}`,
          label: `${s.name} (MCP)`,
          description: s.description ?? s.url,
          defaultApproval: "smart" as const,
          trusted: s.trust === "trusted",
          serverRevision: s.policyRevision,
          serviceReady: s.trust === "trusted" && !!s.identityHeader && !!s.identitySecretEnc && !!s.toolsSnapshot,
          // Only the accepted tools the admin left on; empty for a server whose list hasn't been captured yet.
          mcpTools: offeredTools(s).map((t) => ({
            name: t.name,
            description: truncate(cleanDescription(t.description ?? t.title) ?? "", 160),
            readOnly: t.annotations?.readOnlyHint === true,
            destructive: t.annotations?.destructiveHint === true,
            hash: toolHash(t),
            ...(p.isAdmin ? { definition: t } : {}),
          })),
        }))),
  ];
  const knowledge = botId
    ? await db
        .select({ attachmentId: attachments.id, filename: attachments.filename, chunks: sql<number>`count(*)::int` })
        .from(knowledgeChunks)
        .innerJoin(attachments, eq(attachments.id, knowledgeChunks.attachmentId))
        .where(eq(knowledgeChunks.botId, botId))
        .groupBy(attachments.id, attachments.filename)
    : [];
  let teamConfig: HermesTeamPolicyValue | undefined;
  const teamMaintainers: {id: string; name: string}[] = [];
  const teamModelOptions: HermesTeamModelOption[] = ['admin_provided', 'admin_default_personal_allowed', 'personal_required'].map(value => ({ value: value as HermesTeamModelOption['value'], available: false, reason: 'This route has not been verified. Team chat stays paused until a supported gateway is tested.' }));
  if (p.isAdmin && teamBotsEnabled()) {
    const [definition] = botId ? await db.select().from(hermesTeamDefinitions).where(eq(hermesTeamDefinitions.botId, botId)) : [];
    const selected = definition ? await db.select().from(hermesTeamMaintainers).where(eq(hermesTeamMaintainers.botId, botId!)) : [];
    const candidates = await db.select({id:users.id,name:users.name}).from(users).where(eq(users.disabled,false));
    for (const candidate of candidates) if ((await loadPrincipal(candidate.id))?.isAdmin) teamMaintainers.push(candidate);
    teamConfig = { enabled: definition?.enabled ?? false, modelPolicy: definition?.modelPolicy.mode ?? 'personal_required', maintainerIds: selected.length ? selected.map(m => m.userId) : [p.user.id], expectedVersion: definition?.version ?? 0 };
  }
  return {
    teamConfig, teamMaintainers, teamModelOptions,
    delegators: botId ? [] : (await listEditableCoordinators(p)).map(b => ({ id: b.id, name: b.name, avatar: b.avatar })),
    petCatalog,
    personalHermesAvailable: await dockerAllowed(p),
    isAdmin: p.isAdmin,
    revision: currentBot?.revision,
    publishedRevision: currentBot?.publishedRevision,
    publicationStatus: currentBot?.executionMode === "service" ? await servicePublicationStatus(currentBot) : undefined,
    // Retain the last reviewed scope as an editable draft even after a save/revocation.
    serviceGrants: botId && p.isAdmin ? (await db.select().from(botMcpGrants).where(eq(botMcpGrants.botId, botId)).orderBy(desc(botMcpGrants.createdAt)).limit(1000)).map((g) => ({
      serverId: g.serverId, serverRevision: g.serverRevision, toolName: g.toolName, toolHash: g.toolHash,
      effect: g.effect, requireApproval: g.requireApproval, constraints: g.constraints,
    })) : [],
    apps: await Promise.all(apps.filter((a) => (!isManagedHermes(a) && !isLocalHermes(a)) || currentBot?.appId === a.id).map(async (a) => ({ nativeSearchReason: await nativeSearchAvailability(a, toolSettings), id: a.id, name: a.name, model: a.model, supportsTools: a.supportsTools, agentServer: isAgentServer(a.provider), managed: isManagedHermes(a) || isLocalHermes(a), local: isLocalHermes(a), docker: isDockerHermes(a) }))),
    groups: groupRows,
    users: await db.select({ id: users.id, name: users.name, email: users.email, upn: users.upn, disabled: users.disabled }).from(users).orderBy(users.name),
    tools,
    delegates: bots.filter((b) => b.id !== botId && b.executionMode !== "service" && !b.hermesTeam).map((b) => ({ id: b.id, name: b.name, avatar: b.avatar })),
    knowledge,
  };
}
