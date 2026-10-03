import { and, eq, sql } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { attachments, knowledgeChunks } from "@/db/schema";
import { embedTexts, type EmbedContext } from "@/lib/llm";
import type { AgentCtx, ToolEntry } from "../types";

export async function searchKnowledge(botId: string, query: string, k = 6, usage: EmbedContext = {}) {
  const cols = {
    content: knowledgeChunks.content,
    filename: attachments.filename,
    chunkIndex: knowledgeChunks.chunkIndex,
  };
  const vec = await embedTexts([query], { botId, ...usage }).catch(() => null);
  if (vec) {
    const rows = await db
      .select(cols)
      .from(knowledgeChunks)
      .innerJoin(attachments, eq(attachments.id, knowledgeChunks.attachmentId))
      .where(and(eq(knowledgeChunks.botId, botId), sql`${knowledgeChunks.embedding} is not null`))
      .orderBy(sql`${knowledgeChunks.embedding} <=> ${`[${vec[0].join(",")}]`}::vector`)
      .limit(k);
    if (rows.length) return rows;
  }
  // Fallback: Postgres full-text search.
  const q = sql`websearch_to_tsquery('english', ${query})`;
  return db
    .select(cols)
    .from(knowledgeChunks)
    .innerJoin(attachments, eq(attachments.id, knowledgeChunks.attachmentId))
    .where(and(eq(knowledgeChunks.botId, botId), sql`${knowledgeChunks.tsv} @@ ${q}`))
    .orderBy(sql`ts_rank(${knowledgeChunks.tsv}, ${q}) desc`)
    .limit(k);
}

export function knowledgeTool(ctx: AgentCtx): ToolEntry | null {
  if (!ctx.bot) return null;
  const botId = ctx.bot.id;
  return {
    name: "search_knowledge",
    key: "knowledge",
    tool: tool({
      description: "Search this bot's knowledge files (uploaded documents). Cite the filename when you use a result.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({
        results: await searchKnowledge(botId, query, 6, { userId: ctx.principal.user.id, conversationId: ctx.conversationId }),
      }),
    }),
  };
}
