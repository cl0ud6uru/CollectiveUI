import { isDockerHermes, dockerAllowed } from "@/lib/docker-hermes/policy";
import { bindingSchema } from "@/docker-hermes/types";
import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import {
  aiApps,
  appAccess,
  botAccess,
  bots,
  conversations,
  mcpServerAccess,
  mcpServers,
  type AiApp,
  type Bot,
} from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { userMayUseChatGPT } from "@/lib/llm/chatgpt/policy";
import { getSetting } from "@/lib/settings";
import { isChatModel, HERMES_BOT_ONLY_MESSAGE } from "@/lib/llm/model-policy";
import { assertServicePublished, canEditBot } from "@/lib/bots/service";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);

export function assertAdmin(p: Principal) {
  if (!p.isAdmin) throw forbidden("Admin only");
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

function appVisibleTo(p: Principal) {
  const personal = sql`${aiApps.providerConfig}->'docker' is not null`;
  const mine = and(personal, sql`${aiApps.providerConfig}->'docker'->>'ownerId' = ${p.user.id}`, sql`${dockerAllowed(p)}`);
  if (p.isAdmin) return and(eq(aiApps.enabled, true), or(sql`not (${personal})`, mine));
  return and(
    eq(aiApps.enabled, true),
    or(
      mine,
      and(sql`not (${personal})`, eq(aiApps.isPublic, true)),
      p.groupIds.length
        ? exists(
            db
              .select({ one: sql`1` })
              .from(appAccess)
              .where(and(eq(appAccess.appId, aiApps.id), inArray(appAccess.groupId, p.groupIds))),
          )
        : sql`false`,
    ),
  );
}

/** ChatGPT plan apps are only offered to people the admin lets connect a plan (and only while the feature is on). */
async function withoutUnavailablePlans(p: Principal, apps: AiApp[], q: DbOrTx = db): Promise<AiApp[]> {
  apps = apps.filter(a => !isDockerHermes(a) || (dockerAllowed(p) && bindingSchema.safeParse(a.providerConfig.docker).success && bindingSchema.parse(a.providerConfig.docker).ownerId === p.user.id));
  if (!apps.some((a) => a.provider === "chatgpt")) return apps;
  return userMayUseChatGPT(p, await getSetting("chatgpt", q)) ? apps : apps.filter((a) => a.provider !== "chatgpt");
}

export async function listAccessibleApps(p: Principal): Promise<AiApp[]> {
  return withoutUnavailablePlans(p, await db.select().from(aiApps).where(appVisibleTo(p)).orderBy(asc(aiApps.sortOrder), asc(aiApps.name)));
}

export async function getAccessibleApp(p: Principal, appId: string, q: DbOrTx = db): Promise<AiApp> {
  const rows = await q
    .select()
    .from(aiApps)
    .where(and(eq(aiApps.id, appId), appVisibleTo(p)));
  const [app] = await withoutUnavailablePlans(p, rows, q);
  if (!app) throw forbidden("You don't have access to this connection");
  return app;
}

/** Ordinary chat choices, excluding agent backends even for administrators. */
export async function listAccessibleModels(p: Principal): Promise<AiApp[]> {
  return (await listAccessibleApps(p)).filter(isChatModel);
}

export async function getAccessibleModel(p: Principal, appId: string, q: DbOrTx = db): Promise<AiApp> {
  const app = await getAccessibleApp(p, appId, q);
  if (!isChatModel(app)) throw new HttpError(400, HERMES_BOT_ONLY_MESSAGE);
  return app;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/** `adminSeesAll`: admins can open any bot (oversight), but their own lists show only what they'd normally see. */
function botVisibleTo(p: Principal, adminSeesAll = true) {
  const privateNative = sql`not exists (select 1 from ai_apps a where a.id = ${bots.appId} and a.provider_config->'docker' is not null and
    (not ${dockerAllowed(p)} or ${bots.ownerId} <> ${p.user.id} or ${bots.visibility} <> 'private' or ${bots.executionMode} <> 'caller' or ${bots.coordinatorEligible}
     or a.provider_config->'docker'->>'ownerId' is distinct from ${p.user.id} or a.provider_config->'docker'->>'botId' is distinct from ${bots.id}))`;
  if (p.isAdmin && adminSeesAll) return privateNative;
  return and(privateNative, or(
    eq(bots.ownerId, p.user.id),
    eq(bots.visibility, "org"),
    and(
      eq(bots.visibility, "groups"),
      p.groupIds.length
        ? exists(
            db
              .select({ one: sql`1` })
              .from(botAccess)
              .where(and(eq(botAccess.botId, bots.id), inArray(botAccess.groupId, p.groupIds))),
          )
        : sql`false`,
    ),
  ));
}

export async function listAccessibleBots(p: Principal, q: DbOrTx = db): Promise<Bot[]> {
  const rows = await q
    .select()
    .from(bots)
    .where(and(eq(bots.enabled, true), botVisibleTo(p, false)))
    .orderBy(asc(bots.name));
  return withoutUnavailablePlanBots(p, rows, q);
}

/**
 * Bots on a ChatGPT plan app are only listed for people allowed to use their own plan (owners always see their own,
 * so they can switch it to another model). Direct access (getAccessibleBot) is unchanged; model resolution refuses.
 */
async function withoutUnavailablePlanBots(p: Principal, rows: Bot[], q: DbOrTx = db): Promise<Bot[]> {
  const appIds = [...new Set(rows.flatMap((b) => (b.appId ? [b.appId] : [])))];
  if (!appIds.length) return rows;
  const planApps = await q
    .select({ id: aiApps.id })
    .from(aiApps)
    .where(and(inArray(aiApps.id, appIds), eq(aiApps.provider, "chatgpt")));
  if (!planApps.length || userMayUseChatGPT(p, await getSetting("chatgpt", q))) return rows;
  const hidden = new Set(planApps.map((a) => a.id));
  return rows.filter((b) => b.ownerId === p.user.id || !b.appId || !hidden.has(b.appId));
}

export async function getAccessibleBot(p: Principal, botId: string, q: DbOrTx = db): Promise<Bot> {
  const [bot] = await q
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), botVisibleTo(p)));
  if (!bot) throw forbidden("You don't have access to this bot");
  return bot;
}

/** Execution and new chat entry points must also refuse disabled bots. Editing still uses getEditableBot. */
export async function getUsableBot(p: Principal, botId: string, q: DbOrTx = db): Promise<Bot> {
  const bot = await getAccessibleBot(p, botId, q);
  if (!bot.enabled) throw forbidden("This bot is disabled");
  await assertServicePublished(bot, q);
  return bot;
}

export async function getEditableBot(p: Principal, botId: string): Promise<Bot> {
  const bot = await getAccessibleBot(p, botId);
  if (!canEditBot(p, bot)) throw forbidden("Only an authorized bot editor can change it");
  return bot;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/** Servers in use (enabled, or enabled with a tool-list change waiting for review) that this person may use. */
export async function listAccessibleMcpServers(p: Principal) {
  const inUse = inArray(mcpServers.status, ["enabled", "needs_review"]);
  const where = p.isAdmin
    ? inUse
    : and(
        inUse,
        or(
          eq(mcpServers.isPublic, true),
          p.groupIds.length
            ? exists(
                db
                  .select({ one: sql`1` })
                  .from(mcpServerAccess)
                  .where(and(eq(mcpServerAccess.serverId, mcpServers.id), inArray(mcpServerAccess.groupId, p.groupIds))),
              )
            : sql`false`,
        ),
      );
  return db.select().from(mcpServers).where(where).orderBy(asc(mcpServers.name));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function getOwnedConversation(p: Principal, conversationId: string, q: DbOrTx = db) {
  const [conv] = await q
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, p.user.id)));
  if (!conv) throw notFound("Conversation not found");
  return conv;
}
