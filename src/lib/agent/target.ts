import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, type AiApp, type Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getAccessibleModel, getUsableBot, HttpError } from "@/lib/authz";
import { assertLocalBot } from "@/lib/local-hermes/policy";
import { authorizeTeamConversation } from '@/lib/hermes-team/conversations';
import { teamNativeAvailability } from '@/lib/hermes-team/candidate-availability';
import { botUsesNativeLearning, teamUsesNativeLearning } from '@/lib/hermes-team/learning';
import { teamRuntimeApp } from './team-target';

/**
 * The bot and app a direct conversation talks to, re-checked for this principal on every turn (bot access, app access,
 * app enabled). Shared by the chat route and the run executor, which checks again at every segment.
 */
export async function resolveTurnTarget(p: Principal, conv: { id?: string; appId: string | null; botId: string | null }): Promise<{ bot: Bot | null; app: AiApp }> {
  let bot: Bot | null = null;
  let app: AiApp;
  if (conv.id && await teamUsesNativeLearning(conv.id)) {
    // Admin mode has its own maintainer authorization; it need not inherit member audience access.
    const context = await authorizeTeamConversation(p, conv.id);
    if (context.bot.id !== conv.botId) throw new HttpError(404, 'Team conversation not found.');
    const readiness = await teamNativeAvailability(p, context.bot.id, context.chat.mode, { conversationId: conv.id });
    if (!readiness.available) throw new HttpError(409, readiness.reason);
    return { bot: context.bot, app: teamRuntimeApp(context.bot, readiness.model) };
  }
  if (conv.botId) {
    bot = await getUsableBot(p, conv.botId);
    // Native model/utility/tool routes must be verified before admitting any team work.
    // Never reuse the definition's previous app as a company-provider fallback.
    if (await botUsesNativeLearning(bot.id)) throw new HttpError(409, 'Open this bot’s private Team chat before starting a reply.');
    if (!bot.appId) throw new HttpError(400, "This bot has no connection configured");
    const [a] = await db.select().from(aiApps).where(eq(aiApps.id, bot.appId));
    if (!a?.enabled) throw new HttpError(400, "This bot's connection is disabled");
    app = a;
  } else if (conv.appId) {
    app = await getAccessibleModel(p, conv.appId);
  } else {
    throw new HttpError(400, "Choose a model or bot to chat with");
  }
  await assertLocalBot(p, app, bot);
  return { bot, app };
}
