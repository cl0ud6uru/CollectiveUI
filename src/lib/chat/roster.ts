import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, conversations, groupBotWork, messages } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { listAccessibleBots } from "@/lib/authz";
import { filterTeamConversationViews } from "@/lib/hermes-team/conversations";
import { previewLine } from "./preview";

export { previewLine };

export type RosterStatus = "working" | "waiting";
export type RosterEntry = { preview: string | null; lastAt: string | null; status: RosterStatus | null };

/**
 * What the bot roster shows under each name: the home chat's latest message, when it was, and whether the bot is
 * busy for this person. Ordering stays the caller's (stable roster); this only adds detail.
 */
export async function loadBotWorkStatuses(p: Principal, botIds?: string[]) {
  botIds ??= (await listAccessibleBots(p)).map(bot => bot.id);
  if (!botIds.length) return new Map<string, RosterStatus>();
  const [runs, speakers] = await Promise.all([
    db.select({ botId: agentRuns.botId, conversationId: agentRuns.conversationId, status: agentRuns.status })
      .from(agentRuns).innerJoin(conversations, eq(conversations.id, agentRuns.conversationId))
      .where(and(eq(agentRuns.userId, p.user.id), eq(conversations.userId, p.user.id), isNotNull(agentRuns.botId),
        inArray(agentRuns.botId, botIds), inArray(agentRuns.status, ["queued", "running", "waiting", "waiting_tasks"]))),
    db.select({ botId: groupBotWork.botId, conversationId: groupBotWork.conversationId })
      .from(groupBotWork).innerJoin(conversations, eq(conversations.id, groupBotWork.conversationId))
      .where(and(eq(groupBotWork.userId, p.user.id), eq(conversations.userId, p.user.id), eq(conversations.isGroup, true),
        inArray(groupBotWork.botId, botIds), gt(groupBotWork.expiresAt, sql`now()`))),
  ]);
  // A person may retain access to a bot while losing access to its private Team/Admin context.
  const visible = await filterTeamConversationViews(p, [...runs, ...speakers.map(s => ({ ...s, status: "running" }))], row => row.conversationId);
  const statuses = new Map<string, RosterStatus>();
  for (const row of visible) if (row.botId) {
    const status = row.status === "waiting" ? "waiting" : "working";
    if (statuses.get(row.botId) !== "waiting") statuses.set(row.botId, status);
  }
  return statuses;
}

export async function loadBotRoster(p: Principal, homes: { botId: string; conversationId: string; updatedAt: Date }[], botIds?: string[]) {
  const homeIds = homes.map((h) => h.conversationId);
  const [latest, statusByBot] = await Promise.all([
    homeIds.length
      ? db
          .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, text: messages.searchText, role: messages.role })
          .from(messages)
          .where(and(inArray(messages.conversationId, homeIds), ne(messages.role, "system"), ne(messages.searchText, "")))
          .orderBy(messages.conversationId, desc(messages.createdAt))
      : Promise.resolve([]),
    loadBotWorkStatuses(p, botIds),
  ]);
  const textByConversation = new Map(latest.map((m) => [m.conversationId, m.role === "user" ? `You: ${m.text}` : m.text]));
  const out = new Map<string, RosterEntry>();
  for (const h of homes) {
    const text = textByConversation.get(h.conversationId);
    out.set(h.botId, { preview: text ? previewLine(text) : null, lastAt: h.updatedAt.toISOString(), status: statusByBot.get(h.botId) ?? null });
  }
  for (const [botId, status] of statusByBot) if (botId && !out.has(botId)) out.set(botId, { preview: null, lastAt: null, status });
  return out;
}
