import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, type AiApp, type Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getAccessibleModel, getUsableBot, HttpError } from "@/lib/authz";
import { assertLocalBot } from "@/lib/local-hermes/policy";

/**
 * The bot and app a direct conversation talks to, re-checked for this principal on every turn (bot access, app access,
 * app enabled). Shared by the chat route and the run executor, which checks again at every segment.
 */
export async function resolveTurnTarget(p: Principal, conv: { appId: string | null; botId: string | null }): Promise<{ bot: Bot | null; app: AiApp }> {
  let bot: Bot | null = null;
  let app: AiApp;
  if (conv.botId) {
    bot = await getUsableBot(p, conv.botId);
    if (!bot.appId) throw new HttpError(400, "This bot has no connection configured");
    const [a] = await db.select().from(aiApps).where(eq(aiApps.id, bot.appId));
    if (!a?.enabled) throw new HttpError(400, "This bot's connection is disabled");
    app = a;
  } else if (conv.appId) {
    app = await getAccessibleModel(p, conv.appId);
  } else {
    throw new HttpError(400, "Choose a model or bot to chat with");
  }
  assertLocalBot(p, app, bot);
  return { bot, app };
}
