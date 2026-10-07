import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { agentRuns, conversations, messages, users, type Conversation } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";

/** Only accepted sends write recency. Transcript copies/imports and activity timestamps cannot establish a send. */
export async function recordBotSendTx(tx: Tx, p: Principal, conversation: Conversation, sentAt = new Date()): Promise<void> {
  if (!conversation.botId || conversation.userId !== p.user.id || conversation.source !== "chat" || conversation.isGroup) return;
  // Same user-row lock as pin/manual preferences: tabs cannot overwrite each other's fields.
  const [user] = await tx.select().from(users).where(eq(users.id, p.user.id)).for("update");
  if (!user || user.disabled || user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
  const previous = user.prefs.botLastSentAt?.[conversation.botId];
  const at = previous && Date.parse(previous) > sentAt.getTime() ? previous : sentAt.toISOString();
  await tx.update(users).set({ prefs: { ...user.prefs, botLastSentAt: { ...user.prefs.botLastSentAt, [conversation.botId]: at } } }).where(eq(users.id, user.id));
}

/** Reads only this person's recorded sends for the currently authorized roster. */
export async function loadBotLastSentAt(userId: string, botIds: string[], q: DbOrTx = db): Promise<Map<string, string>> {
  if (!botIds.length) return new Map();
  const [user] = await q.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId));
  const recorded = new Map(botIds.flatMap(id => user?.prefs.botLastSentAt?.[id] ? [[id, user.prefs.botLastSentAt[id]]] : []));
  const missing = botIds.filter(id => !recorded.has(id));
  if (!missing.length) return recorded;
  // Legacy startRun inserted a new user message and its foreground run with the same transaction timestamp.
  // Require that durable admission receipt: transcript copies have no matching run, and later regeneration
  // of a copied/old message has a different timestamp. Never infer authorship from conversation ownership alone.
  const legacy = await q.select({ botId: conversations.botId, lastSentAt: sql<string>`max(${messages.createdAt})::text` })
    .from(conversations).innerJoin(messages, eq(messages.conversationId, conversations.id))
    .innerJoin(agentRuns, and(eq(agentRuns.conversationId, conversations.id), eq(agentRuns.parentMessageId, messages.id),
      eq(agentRuns.userId, userId), eq(agentRuns.background, false), eq(agentRuns.createdAt, messages.createdAt)))
    .where(and(eq(conversations.userId, userId), inArray(conversations.botId, missing), eq(conversations.source, "chat"),
      eq(conversations.isGroup, false), eq(messages.role, "user")))
    .groupBy(conversations.botId);
  for (const row of legacy) recorded.set(row.botId!, new Date(row.lastSentAt).toISOString());
  return recorded;
}
