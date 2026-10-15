import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  aiApps, appAccess, botAccess, botDelegates, botMcpGrants, bots, botTools, botUserAccess, groupMappings, groupMembers, groups,
  mcpServers, providerConnections, routines, skills, users,
} from "@/db/schema";
import { resolvePrincipal, type Principal } from "@/lib/auth/groups";
import { assertAdmin, notFound } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import { safeUrl } from "./secret-safe";
import { providerConnectionUpdatedAtToken } from "./provider-connection-write";
import { groupRevision } from "./architect-people";

/*
 * Read-only admin inventory for The Architect (and any other admin surface). Every function checks assertAdmin itself
 * and selects explicit, non-secret columns: credentials are reported only as presence (hasKey, hasHeaders, ...).
 */

const personalRuntimeHidden = (p: Principal) => sql`${aiApps.providerConfig}->'docker' is null or ${bots.ownerId} = ${p.user.id}`;

async function builtinIds() {
  const [architect, office, coordinator] = await Promise.all([getSetting("architectBot"), getSetting("officeBot"), getSetting("coordinator")]);
  return { architect: architect.botId, office: office.botId, coordinator: coordinator.enabled ? coordinator.defaultBotId : null };
}

const botSummary = {
  id: bots.id, revision: bots.revision, name: bots.name, label: bots.label, enabled: bots.enabled, visibility: bots.visibility, executionMode: bots.executionMode,
  hermesTeam: bots.hermesTeam, coordinatorEligible: bots.coordinatorEligible, maxSteps: bots.maxSteps, updatedAt: bots.updatedAt,
  ownerId: bots.ownerId, ownerName: users.name, modelId: aiApps.id, modelName: aiApps.name, modelProvider: aiApps.provider, modelEnabled: aiApps.enabled,
  tools: sql<string[]>`coalesce((select array_agg(tool_key order by tool_key) from bot_tools t where t.bot_id = ${bots.id}), '{}')`,
  routines: sql<number>`(select count(*)::int from routines r where r.bot_id = ${bots.id})`,
};

type BotRow = { id: string; revision: number; name: string; label: string | null; enabled: boolean; visibility: string; executionMode: string; hermesTeam: boolean;
  coordinatorEligible: boolean; maxSteps: number; updatedAt: Date; ownerName: string; modelId: string | null; modelName: string | null;
  modelProvider: string | null; modelEnabled: boolean | null; tools: string[]; routines: number; ownerId: string };

function botView(r: BotRow, ids: Awaited<ReturnType<typeof builtinIds>>) {
  return {
    id: r.id, revision: r.revision, name: r.name, label: r.label, enabled: r.enabled, visibility: r.visibility, executionMode: r.executionMode,
    hermesTeam: r.hermesTeam, coordinatorEligible: r.coordinatorEligible, maxSteps: r.maxSteps, updatedAt: r.updatedAt, owner: r.ownerName,
    model: r.modelId ? { id: r.modelId, name: r.modelName, provider: r.modelProvider, enabled: r.modelEnabled } : null,
    toolGroups: r.tools, routines: r.routines,
    builtin: r.id === ids.architect ? "architect" : r.id === ids.office ? "office" : null,
    defaultCoordinator: r.id === ids.coordinator,
  };
}

export async function adminListBots(p: Principal, opts: { query?: string; limit?: number } = {}) {
  assertAdmin(p);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const q = opts.query?.trim();
  const [rows, ids, [{ total }]] = await Promise.all([
    db.select(botSummary).from(bots).innerJoin(users, eq(users.id, bots.ownerId)).leftJoin(aiApps, eq(aiApps.id, bots.appId))
      .where(and(personalRuntimeHidden(p), q ? or(ilike(bots.name, `%${q}%`), ilike(bots.label, `%${q}%`)) : undefined))
      .orderBy(desc(bots.updatedAt)).limit(limit),
    builtinIds(),
    db.select({ total: sql<number>`count(*)::int` }).from(bots).leftJoin(aiApps, eq(aiApps.id, bots.appId)).where(personalRuntimeHidden(p)),
  ]);
  return { total, shown: rows.length, bots: rows.map(r => botView(r, ids)) };
}

export async function adminGetBot(p: Principal, botId: string) {
  assertAdmin(p);
  const [row] = await db.select({ ...botSummary, description: bots.description, instructions: bots.instructions, boundaries: bots.boundaries, starters: bots.starters })
    .from(bots).innerJoin(users, eq(users.id, bots.ownerId)).leftJoin(aiApps, eq(aiApps.id, bots.appId))
    .where(and(eq(bots.id, botId), personalRuntimeHidden(p)));
  if (!row) throw notFound("Bot not found");
  const [ids, tools, delegates, groupAccess, userAccess, grants, botRoutines, botSkills] = await Promise.all([
    builtinIds(),
    db.select({ key: botTools.toolKey, approval: botTools.approval, config: botTools.config }).from(botTools).where(eq(botTools.botId, botId)),
    db.select({ id: bots.id, name: bots.name }).from(botDelegates).innerJoin(bots, eq(bots.id, botDelegates.delegateBotId)).where(eq(botDelegates.botId, botId)),
    db.select({ id: groups.id, name: groups.name }).from(botAccess).innerJoin(groups, eq(groups.id, botAccess.groupId)).where(eq(botAccess.botId, botId)),
    db.select({ id: users.id, name: users.name }).from(botUserAccess).innerJoin(users, eq(users.id, botUserAccess.userId)).where(eq(botUserAccess.botId, botId)),
    db.select({ server: mcpServers.name, tool: botMcpGrants.toolName, effect: botMcpGrants.effect, requireApproval: botMcpGrants.requireApproval,
      needsReview: sql<boolean>`${botMcpGrants.serverRevision} <> ${mcpServers.policyRevision}` })
      .from(botMcpGrants).innerJoin(mcpServers, eq(mcpServers.id, botMcpGrants.serverId)).where(and(eq(botMcpGrants.botId, botId), isNull(botMcpGrants.revokedAt))),
    db.select({ id: routines.id, name: routines.name, enabled: routines.enabled, triggerType: routines.triggerType, cron: routines.cron,
      timezone: routines.timezone, nextRunAt: routines.nextRunAt, lastRunAt: routines.lastRunAt }).from(routines).where(eq(routines.botId, botId)),
    db.select({ id: skills.id, name: skills.name, description: skills.description, version: skills.version, botId: skills.botId })
      .from(skills).where(and(eq(skills.ownerId, row.ownerId), or(eq(skills.botId, botId), isNull(skills.botId)))).orderBy(asc(skills.name)),
  ]);
  const serverIds = tools.flatMap(t => t.key.startsWith("mcp:") ? [t.key.slice(4)] : []);
  const servers = serverIds.length ? await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(inArray(mcpServers.id, serverIds)) : [];
  return {
    ...botView(row, ids),
    description: row.description, instructions: row.instructions, boundaries: row.boundaries, starters: row.starters,
    tools: tools.map(t => ({
      group: t.key.startsWith("mcp:") ? `mcp:${servers.find(s => s.id === t.key.slice(4))?.name ?? "unknown server"}` : t.key,
      approval: t.approval,
      ...(t.config?.tools ? { selectedTools: t.config.tools } : {}),
    })),
    delegates, access: { groups: groupAccess, users: userAccess }, mcpGrants: grants, routines: botRoutines,
    skills: botSkills.map(skill => ({ ...skill, scope: skill.botId === botId ? "bot" as const : "shared" as const })),
  };
}

export async function adminListConnections(p: Principal) {
  assertAdmin(p);
  const [apps, connections, access, servers] = await Promise.all([
    db.select({ id: aiApps.id, name: aiApps.name, kind: aiApps.kind, provider: aiApps.provider, model: aiApps.model, baseUrl: aiApps.baseUrl,
      keyOwner: aiApps.credentialMode, hasKey: sql<boolean>`${aiApps.apiKeyEnc} is not null`, providerConnectionId: aiApps.providerConnectionId,
      enabled: aiApps.enabled, isPublic: aiApps.isPublic, supportsTools: aiApps.supportsTools, supportsVision: aiApps.supportsVision,
      embeddingModel: aiApps.embeddingModel, personalRuntime: sql<boolean>`${aiApps.providerConfig} ?| array['managed','local','docker']` })
      .from(aiApps).orderBy(asc(aiApps.sortOrder), asc(aiApps.name)),
    db.select({ id: providerConnections.id, name: providerConnections.name, provider: providerConnections.provider, baseUrl: providerConnections.baseUrl,
      organization: providerConnections.organization, project: providerConnections.project, enabled: providerConnections.enabled,
      hasKey: sql<boolean>`${providerConnections.credentialEnc} is not null`, updatedAt: providerConnectionUpdatedAtToken })
      .from(providerConnections).orderBy(asc(providerConnections.name)),
    db.select({ appId: appAccess.appId, groupId: appAccess.groupId }).from(appAccess),
    db.select({ id: mcpServers.id, name: mcpServers.name, url: mcpServers.url, transport: mcpServers.transport, status: mcpServers.status,
      trust: mcpServers.trust, isPublic: mcpServers.isPublic, hasHeaders: sql<boolean>`${mcpServers.headersEnc} is not null`,
      sendsIdentity: sql<boolean>`${mcpServers.identityHeader} is not null`, hasIdentitySecret: sql<boolean>`${mcpServers.identitySecretEnc} is not null`,
      toolCount: sql<number>`coalesce(jsonb_array_length(${mcpServers.toolsSnapshot}), 0)`, driftPending: sql<boolean>`${mcpServers.toolsDrift} is not null`,
      lastTestedAt: mcpServers.lastTestedAt, hasError: sql<boolean>`${mcpServers.lastError} is not null` })
      .from(mcpServers).orderBy(asc(mcpServers.name)),
  ]);
  const shared = apps.filter(a => !a.personalRuntime);
  return {
    models: shared.map(({ baseUrl, providerConnectionId, ...a }) => ({
      ...a, personalRuntime: undefined, baseUrl: safeUrl(baseUrl),
      providerConnection: providerConnectionId ? (connections.find(c => c.id === providerConnectionId)?.name ?? "missing") : null,
      audienceGroups: access.filter(x => x.appId === a.id).length,
    })),
    personalRuntimes: apps.length - shared.length,
    providerConnections: connections.map(c => ({ ...c, baseUrl: safeUrl(c.baseUrl), models: apps.filter(a => a.providerConnectionId === c.id).map(a => a.name) })),
    mcpServers: servers.map(s => ({ ...s, url: safeUrl(s.url) })),
  };
}

export async function adminListUsers(p: Principal, opts: { query?: string; limit?: number } = {}) {
  assertAdmin(p);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const q = opts.query?.trim();
  const where = q ? or(ilike(users.name, `%${q}%`), ilike(users.upn, `%${q}%`)) : undefined;
  const [rows, [{ total }], groupRows, members, mappings] = await Promise.all([
    db.select({ user: users, chats: sql<number>`(select count(*)::int from conversations c where c.user_id = ${users.id})` })
      .from(users).where(where).orderBy(desc(users.lastLoginAt)).limit(limit),
    db.select({ total: sql<number>`count(*)::int` }).from(users).where(where),
    db.select({ id: groups.id, name: groups.name, description: groups.description, isAdmin: groups.isAdmin, canCreateBots: groups.canCreateBots, createdAt: groups.createdAt }).from(groups).orderBy(asc(groups.name)),
    db.select({ groupId: groupMembers.groupId }).from(groupMembers),
    db.select({ groupId: groupMappings.groupId, source: groupMappings.source }).from(groupMappings),
  ]);
  // resolvePrincipal needs the full row; only listed fields leave this function.
  const principals = await Promise.all(rows.map(r => resolvePrincipal(r.user)));
  const groupName = new Map(groupRows.map(g => [g.id, g.name]));
  return {
    total, shown: rows.length,
    users: rows.map(({ user: u, chats }, i) => ({
      id: u.id, name: u.name, upn: u.upn, email: u.email, authSource: u.authSource, identityRealm: u.identityRealm, disabled: u.disabled, sessionVersion: u.sessionVersion,
      isAdmin: principals[i].isAdmin, adminVia: u.isAdmin ? "account" : principals[i].isAdmin ? "group or directory" : null,
      canCreateBots: principals[i].canCreateBots, groups: principals[i].groupIds.map(id => groupName.get(id) ?? id),
      chats, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
    })),
    groups: groupRows.map(({ createdAt: _createdAt, ...g }) => ({
      ...g, revision: groupRevision({ ...g, createdAt: _createdAt }), directMembers: members.filter(m => m.groupId === g.id).length,
      directoryMappings: mappings.filter(m => m.groupId === g.id).map(m => m.source),
    })),
  };
}
