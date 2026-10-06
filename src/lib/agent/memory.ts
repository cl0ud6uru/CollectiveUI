import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { aiApps, conversations, memories, users, type AiApp } from "@/db/schema";
import { embedTexts, resolveModel, utilityApp } from "@/lib/llm";
import { loadMessageRows, partsToText, pathTo } from "@/lib/chat/store";
import { teamUsesNativeLearning } from '@/lib/hermes-team/learning';

export type MemoryRow = { id: string; content: string; pinned: boolean; botId: string | null };

/** Choose memories for the system prompt: pinned first, then most relevant (vector) or most recent. */
export async function selectMemories(opts: {
  userId: string;
  botId: string | null;
  query?: string;
  limit?: number;
  conversationId?: string;
}): Promise<MemoryRow[]> {
  const limit = opts.limit ?? 20;
  const scope = and(
    eq(memories.userId, opts.userId),
    opts.botId ? or(isNull(memories.botId), eq(memories.botId, opts.botId)) : isNull(memories.botId),
  );
  const cols = { id: memories.id, content: memories.content, pinned: memories.pinned, botId: memories.botId };
  const pinned = await db.select(cols).from(memories).where(and(scope, eq(memories.pinned, true))).limit(limit);
  const remaining = limit - pinned.length;
  if (remaining <= 0) return pinned;

  let rest: MemoryRow[] = [];
  const vec = opts.query
    ? await embedTexts([opts.query], { userId: opts.userId, botId: opts.botId, conversationId: opts.conversationId }).catch(() => null)
    : null;
  if (vec) {
    rest = await db
      .select(cols)
      .from(memories)
      .where(and(scope, eq(memories.pinned, false), sql`${memories.embedding} is not null`))
      .orderBy(sql`${memories.embedding} <=> ${`[${vec[0].join(",")}]`}::vector`)
      .limit(remaining);
  }
  if (rest.length < remaining) {
    const seen = new Set(rest.map((r) => r.id));
    const recent = await db
      .select(cols)
      .from(memories)
      .where(and(scope, eq(memories.pinned, false)))
      .orderBy(desc(memories.updatedAt))
      .limit(remaining);
    rest.push(...recent.filter((r) => !seen.has(r.id)).slice(0, remaining - rest.length));
  }
  return [...pinned, ...rest];
}

export async function addMemory(userId: string, botId: string | null, content: string, sourceConversationId?: string) {
  const [emb] = (await embedTexts([content], { userId, botId, conversationId: sourceConversationId }).catch(() => null)) ?? [];
  const [row] = await db
    .insert(memories)
    .values({ userId, botId, content: content.slice(0, 1000), embedding: emb, sourceConversationId })
    .returning({ id: memories.id });
  return row.id;
}

export async function memoryEnabled(userId: string) {
  const [u] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId));
  return u?.prefs?.memoryEnabled !== false;
}

/**
 * Background job: read a finished conversation and store durable facts about the user.
 * Runs in the worker a few minutes after the last message.
 */
export async function extractMemoriesFromConversation(conversationId: string) {
  if (await teamUsesNativeLearning(conversationId)) return 0;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv || !(await memoryEnabled(conv.userId))) return 0;
  const rows = await loadMessageRows(conversationId);
  const path = pathTo(rows, conv.currentLeafId);
  const since = conv.memoryProcessedAt?.getTime() ?? 0;
  const fresh = path.filter((m) => m.createdAt.getTime() > since);
  if (!fresh.some((m) => m.role === "user")) return 0;

  let convApp: AiApp | undefined;
  if (conv.appId) [convApp] = await db.select().from(aiApps).where(eq(aiApps.id, conv.appId));
  const app = await utilityApp(convApp);
  if (!app) return 0;

  const existing = await selectMemories({ userId: conv.userId, botId: conv.botId, limit: 50 });
  const transcript = path
    .slice(-20)
    .map((m) => `${m.role.toUpperCase()}: ${partsToText(m.parts).slice(0, 2000)}`)
    .join("\n\n");

  const { output } = await generateText({
    model: (await resolveModel(app, { purpose: "memory", userId: conv.userId, botId: conv.botId, conversationId })).model,
    output: Output.object({
      schema: z.object({
        memories: z
          .array(z.object({ content: z.string(), shared: z.boolean() }))
          .describe("New durable facts. Empty if nothing worth remembering."),
      }),
    }),
    instructions: `You maintain long-term memory for an AI assistant at work. Extract durable, useful facts about the USER
(role, team, projects, preferences, recurring tasks, tools they use). Ignore one-off requests, secrets, passwords and
sensitive personal data. Do not repeat facts already known. Mark shared=true if the fact is useful to any assistant,
false if it only matters to this specific bot.

Already known:
${existing.map((m) => `- ${m.content}`).join("\n") || "(nothing)"}`,
    prompt: transcript,
  });

  let added = 0;
  for (const m of output?.memories.slice(0, 5) ?? []) {
    if (!m.content.trim()) continue;
    await addMemory(conv.userId, m.shared || !conv.botId ? null : conv.botId, m.content.trim(), conversationId);
    added++;
  }
  await db.update(conversations).set({ memoryProcessedAt: new Date() }).where(eq(conversations.id, conversationId));
  return added;
}
