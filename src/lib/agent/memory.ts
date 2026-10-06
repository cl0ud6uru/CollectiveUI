import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";
import { db, type DbOrTx } from "@/db";
import { aiApps, conversations, memories, users, type AiApp } from "@/db/schema";
import { embedTexts, newUsageScope, restoreUsageAfterRollback, resolveModel, utilityApp, type UsageScope } from "@/lib/llm";
import { learnedPreferences } from "./learning/store";
import { loadMessageRows, partsToText, pathTo } from "@/lib/chat/store";
import { withNonTeamLearning } from '@/lib/hermes-team/learning';

export type MemoryRow = { id: string; content: string; pinned: boolean; botId: string | null };

/** Choose memories for the system prompt: pinned first, then most relevant (vector) or most recent. */
export async function selectMemories(opts: {
  userId: string;
  botId: string | null;
  query?: string;
  limit?: number;
  conversationId?: string;
}, q: DbOrTx = db): Promise<MemoryRow[]> {
  const limit = opts.limit ?? 20;
  const scope = and(
    eq(memories.userId, opts.userId),
    opts.botId ? or(isNull(memories.botId), eq(memories.botId, opts.botId)) : isNull(memories.botId),
  );
  const cols = { id: memories.id, content: memories.content, pinned: memories.pinned, botId: memories.botId };
  const pinned = await q.select(cols).from(memories).where(and(scope, eq(memories.pinned, true))).limit(limit);
  const preferences = opts.botId ? await learnedPreferences(opts.userId, opts.botId, Math.min(5, Math.max(0, limit - pinned.length)), q) : [];
  const remaining = limit - pinned.length - preferences.length;
  if (remaining <= 0) return [...pinned, ...preferences];

  let rest: MemoryRow[] = [];
  const vec = opts.query
    ? await embedTexts([opts.query], { userId: opts.userId, botId: opts.botId, conversationId: opts.conversationId }, q !== db ? { q } : {}).catch(() => null)
    : null;
  if (vec) {
    rest = await q
      .select(cols)
      .from(memories)
      .where(and(scope, eq(memories.pinned, false), sql`${memories.embedding} is not null`))
      .orderBy(sql`${memories.embedding} <=> ${`[${vec[0].join(",")}]`}::vector`)
      .limit(remaining);
  }
  if (rest.length < remaining) {
    const seen = new Set(rest.map((r) => r.id));
    const recent = await q
      .select(cols)
      .from(memories)
      .where(and(scope, eq(memories.pinned, false)))
      .orderBy(desc(memories.updatedAt))
      .limit(remaining);
    rest.push(...recent.filter((r) => !seen.has(r.id)).slice(0, remaining - rest.length));
  }
  return [...pinned, ...preferences, ...rest];
}

export async function addMemory(userId: string, botId: string | null, content: string, sourceConversationId?: string, q: DbOrTx = db, abortSignal?: AbortSignal, usage?: UsageScope) {
  const [emb] = (await embedTexts([content], { userId, botId, conversationId: sourceConversationId }, { ...(abortSignal ? { abortSignal } : {}), ...(usage ? { usage } : {}), ...(q !== db ? { q, maxRetries: 0 } : {}) }).catch(() => null)) ?? [];
  const [row] = await q
    .insert(memories)
    .values({ userId, botId, content: content.slice(0, 1000), embedding: emb, sourceConversationId })
    .returning({ id: memories.id });
  return row.id;
}

export async function memoryEnabled(userId: string, q: DbOrTx = db) {
  const [u] = await q.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId));
  return u?.prefs?.memoryEnabled !== false;
}

/**
 * Background job: read a finished conversation and store durable facts about the user.
 * Runs in the worker a few minutes after the last message.
 */
export async function extractMemoriesFromConversation(conversationId: string) {
  let usage: UsageScope | undefined;
  try {
    return await withNonTeamLearning(conversationId, 0, async q => {
      const abortSignal = AbortSignal.timeout(60000);
      const [conv] = await q.select().from(conversations).where(eq(conversations.id, conversationId));
      if (!conv || !(await memoryEnabled(conv.userId, q))) return 0;
      const rows = await loadMessageRows(conversationId, q);
      const path = pathTo(rows, conv.currentLeafId);
      const since = conv.memoryProcessedAt?.getTime() ?? 0;
      const fresh = path.filter((m) => m.createdAt.getTime() > since);
      if (!fresh.some((m) => m.role === "user")) return 0;

      let convApp: AiApp | undefined;
      if (conv.appId) [convApp] = await q.select().from(aiApps).where(eq(aiApps.id, conv.appId));
      const app = await utilityApp(convApp, q);
      if (!app) return 0;

      const existing = await selectMemories({ userId: conv.userId, botId: conv.botId, limit: 50 }, q);
      const transcript = path
        .slice(-20)
        .map((m) => `${m.role.toUpperCase()}: ${partsToText(m.parts).slice(0, 2000)}`)
        .join("\n\n");

      const scope = usage = newUsageScope({}, q);
      const generation = generateText({
        model: (await resolveModel(app, { purpose: "memory", userId: conv.userId, botId: conv.botId, conversationId, usage: scope, q })).model,
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
        abortSignal, maxRetries: 0,
      });
      const { output } = await generation.finally(async () => { await Promise.allSettled(scope.pending); });

      let added = 0;
      for (const m of output?.memories.slice(0, 5) ?? []) {
        if (!m.content.trim()) continue;
        await addMemory(conv.userId, m.shared || !conv.botId ? null : conv.botId, m.content.trim(), conversationId, q, abortSignal, usage);
        added++;
      }
      await q.update(conversations).set({ memoryProcessedAt: new Date() }).where(eq(conversations.id, conversationId));
      return added;
    });
  } catch (err) {
    await restoreUsageAfterRollback(usage);
    throw err;
  }
}
