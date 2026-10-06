import { assertLocalBot } from "@/lib/local-hermes/policy";
import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { and, eq, isNotNull, isNull, inArray } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { aiApps, botAccess, botUserAccess, botDelegates, botMcpGrants, bots, botTools, mcpServers, type AiApp, type Bot } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { sha256Hex } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { offeredTools } from "@/lib/mcp/servers";
import { canonicalJson, toolHash } from "@/lib/mcp/snapshot";

export const canEditBot = (p: Principal, bot: Pick<Bot, "ownerId" | "executionMode">) =>
  p.isAdmin || (bot.executionMode !== "service" && bot.ownerId === p.user.id);

type ServiceInputs = {
  app: AiApp | undefined;
  access: (typeof botAccess.$inferSelect)[];
  userAccess: (typeof botUserAccess.$inferSelect)[];
  tools: (typeof botTools.$inferSelect)[];
  delegates: (typeof botDelegates.$inferSelect)[];
};

async function serviceBotInputs(bot: Bot, q: DbOrTx) {
  const [access, tools, delegates, userAccess] = await Promise.all([
    q.select().from(botAccess).where(eq(botAccess.botId, bot.id)),
    q.select().from(botTools).where(eq(botTools.botId, bot.id)),
    q.select().from(botDelegates).where(eq(botDelegates.botId, bot.id)),
    q.select().from(botUserAccess).where(eq(botUserAccess.botId, bot.id)),
  ]);
  return { access, tools, delegates, userAccess };
}

function serviceConfigDigest(bot: Bot, { app, access, tools, delegates, userAccess }: ServiceInputs) {
  if (!app?.enabled || app.provider === "hermes" || app.credentialMode !== "org" || !app.supportsTools)
    throw new HttpError(400, "Service bots require an enabled native company model with tools.");
  if (tools.some((t) => !t.toolKey.startsWith("mcp:")) || delegates.length)
    throw new HttpError(400, "Service bots support only explicitly granted MCP tools, without delegation.");
  return sha256Hex(canonicalJson({
    bot: { id: bot.id, ownerId: bot.ownerId, revision: bot.revision, mode: bot.executionMode, name: bot.name,
      instructions: bot.instructions, boundaries: bot.boundaries, description: bot.description,
      appId: bot.appId, visibility: bot.visibility, maxSteps: bot.maxSteps, enabled: bot.enabled },
    app: { id: app.id, provider: app.provider, providerConfig: app.providerConfig, baseUrl: app.baseUrl,
      apiKeyEnc: app.apiKeyEnc, ...(app.providerConnectionId ? { providerConnectionId: app.providerConnectionId } : {}), model: app.model, systemPrompt: app.systemPrompt,
      credentialMode: app.credentialMode, supportsTools: app.supportsTools, enabled: app.enabled },
    groups: access.map((a) => a.groupId).sort(),
    // Preserve existing publication hashes when there are no individual grants.
    ...(userAccess.length ? { users: userAccess.map(a => a.userId).sort() } : {}),
    tools: [...tools].sort((a, b) => a.toolKey.localeCompare(b.toolKey)),
  }));
}

/** Publication includes model/platform guidance and all audience/tool/delegation state, not just the prompt. */
export async function serviceConfigHash(bot: Bot, q: DbOrTx = db) {
  const [[app], inputs] = await Promise.all([q.select().from(aiApps).where(eq(aiApps.id, bot.appId ?? "")), serviceBotInputs(bot, q)]);
  return serviceConfigDigest(bot, { app, ...inputs });
}

/**
 * Keeps service publications valid across a credential move that changes nothing else (the same key moved from a
 * model to a saved provider connection). Only a publication that was current against `before` is re-stamped for
 * `after`; a stale one stays stale. Both digests come from one read of each bot's dependencies, under a lock on
 * the bot row (and the caller's lock on the model row), so a concurrent edit can never be blessed: it either
 * lands before the read (the old digest no longer matches) or after it (the new digest no longer matches).
 */
export async function carryServicePublications(tx: Tx, before: AiApp, after: AiApp): Promise<string[]> {
  if (before.id !== after.id) throw new Error("A publication can only be carried for the same model.");
  const published = await tx.select().from(bots)
    .where(and(eq(bots.appId, before.id), eq(bots.executionMode, "service"), isNotNull(bots.publishedConfigHash)))
    .orderBy(bots.id).for("update");
  const carried: string[] = [];
  for (const bot of published) {
    if (bot.publishedRevision !== bot.revision) continue;
    const inputs = await serviceBotInputs(bot, tx);
    let current: string;
    try { current = serviceConfigDigest(bot, { app: before, ...inputs }); } catch { continue; }
    if (current !== bot.publishedConfigHash) continue;
    const next = serviceConfigDigest(bot, { app: after, ...inputs });
    const updated = await tx.update(bots).set({ publishedConfigHash: next })
      .where(and(eq(bots.id, bot.id), eq(bots.revision, bot.revision), eq(bots.publishedConfigHash, current))).returning({ id: bots.id });
    if (updated.length) carried.push(bot.id);
  }
  return carried;
}

export async function assertServicePublished(bot: Bot, q: DbOrTx = db) {
  if (bot.executionMode !== "service") return;
  if (bot.publishedRevision !== bot.revision || !bot.publishedConfigHash ||
      bot.publishedConfigHash !== await serviceConfigHash(bot, q))
    throw new HttpError(403, "This service bot needs an admin to review and publish its current configuration.");
  const [configured, grants, settings] = await Promise.all([
    q.select().from(botTools).where(eq(botTools.botId, bot.id)), activeServiceGrants(bot.id, q), getSetting("tools", q),
  ]);
  const ids = configured.map(t => t.toolKey.slice(4));
  const servers = ids.length ? await q.select().from(mcpServers).where(inArray(mcpServers.id, ids)) : [];
  if (!ids.length || !grants.length) throw new HttpError(403, "This service bot has no active capabilities. Ask an admin to review it.");
  for (const selected of configured) {
    const server = servers.find(s => selected.toolKey === `mcp:${s.id}`);
    const names = selected.config?.tools;
    if (!server || !names?.length || !["enabled", "needs_review"].includes(server.status) ||
        server.trust !== "trusted" || !server.identityHeader || !server.identitySecretEnc ||
        settings.disabledTools.includes("mcp") || settings.disabledTools.includes(selected.toolKey))
      throw new HttpError(403, "A published connector is unavailable. Ask an admin to review this bot.");
    for (const name of names) {
      const def = offeredTools(server).find(t => t.name === name);
      const grant = grants.find(g => g.serverId === server.id && g.toolName === name && g.botRevision === bot.revision);
      if (!def || !grant || grant.serverRevision !== server.policyRevision || grant.toolHash !== toolHash(def))
        throw new HttpError(403, "A published tool was revoked or changed. Ask an admin to review this bot.");
    }
  }
}

export async function activeServiceGrants(botId: string, q: DbOrTx = db) {
  return q.select().from(botMcpGrants).where(and(eq(botMcpGrants.botId, botId), isNull(botMcpGrants.revokedAt)));
}

/** Lock with every profile/dependency mutation, so conversion/publication cannot race owner authorization. */
export async function lockEditableBot(p: Principal, botId: string, q: Tx, assertAdditional?: (fresh: Principal, bot: Bot) => void | Promise<void>) {
  const [bot] = await q.select().from(bots).where(eq(bots.id, botId)).for("update");
  const fresh = await loadPrincipal(p.user.id, q);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion || !bot || !canEditBot(fresh, bot))
    throw new HttpError(403, "Only an authorized bot editor can change this bot.");
  const [app] = bot.appId ? await q.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  if (app && isDockerHermes(app)) await assertLocalBot(fresh, app, bot);
  await assertAdditional?.(fresh, bot);
  return bot;
}

/** Safe status text for discovery/profile UI; runtime still checks again. */
export async function servicePublicationStatus(bot: Bot) {
  try {
    if (!bot.enabled) return { published: false, reason: "Bot is disabled." };
    await assertServicePublished(bot);
    return { published: true, reason: "Published" };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { published: false, reason: err.message };
  }
}
