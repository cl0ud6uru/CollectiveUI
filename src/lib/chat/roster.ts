import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, messages } from "@/db/schema";
import { previewLine } from "./preview";

export { previewLine };

export type RosterStatus = "working" | "waiting";
export type RosterEntry = { preview: string | null; lastAt: string | null; status: RosterStatus | null };

/**
 * What the bot roster shows under each name: the home chat's latest message, when it was, and whether the bot is
 * busy for this person. Ordering stays the caller's (stable roster); this only adds detail.
 */
export async function loadBotRoster(userId: string, homes: { botId: string; conversationId: string; updatedAt: Date }[]) {
  const homeIds = homes.map((h) => h.conversationId);
  const [latest, runs] = await Promise.all([
    homeIds.length
      ? db
          .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, text: messages.searchText, role: messages.role })
          .from(messages)
          .where(and(inArray(messages.conversationId, homeIds), ne(messages.role, "system"), ne(messages.searchText, "")))
          .orderBy(messages.conversationId, desc(messages.createdAt))
      : Promise.resolve([]),
    db
      .select({ botId: agentRuns.botId, waiting: sql<boolean>`bool_or(${agentRuns.status} = 'waiting')` })
      .from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), isNotNull(agentRuns.botId), inArray(agentRuns.status, ["queued", "running", "waiting", "waiting_tasks"])))
      .groupBy(agentRuns.botId),
  ]);
  const textByConversation = new Map(latest.map((m) => [m.conversationId, m.role === "user" ? `You: ${m.text}` : m.text]));
  const statusByBot = new Map(runs.map((r) => [r.botId, (r.waiting ? "waiting" : "working") as RosterStatus]));
  const out = new Map<string, RosterEntry>();
  for (const h of homes) {
    const text = textByConversation.get(h.conversationId);
    out.set(h.botId, { preview: text ? previewLine(text) : null, lastAt: h.updatedAt.toISOString(), status: statusByBot.get(h.botId) ?? null });
  }
  for (const [botId, status] of statusByBot) if (botId && !out.has(botId)) out.set(botId, { preview: null, lastAt: null, status });
  return out;
}
