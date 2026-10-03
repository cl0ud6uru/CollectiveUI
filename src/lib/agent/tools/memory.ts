import { and, eq } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { memories } from "@/db/schema";
import { addMemory } from "../memory";
import type { AgentCtx, ToolEntry } from "../types";

export function memoryTools(ctx: AgentCtx): ToolEntry[] {
  const userId = ctx.principal.user.id;
  return [
    {
      name: "remember",
      key: "memory",
      tool: tool({
        description:
          "Save a durable fact about the user for future conversations (e.g. their role, preferences, ongoing projects). Use when the user asks you to remember something.",
        inputSchema: z.object({
          fact: z.string().describe("The fact, phrased in third person, e.g. 'Works on the payments team'"),
          shared: z.boolean().optional().describe("true if useful to all assistants, false if only to this bot"),
        }),
        execute: async ({ fact, shared }) => {
          const id = await addMemory(userId, shared === false && ctx.bot ? ctx.bot.id : null, fact, ctx.conversationId);
          return { saved: true, id };
        },
      }),
    },
    {
      name: "forget",
      key: "memory",
      tool: tool({
        description: "Delete a saved memory by id when the user asks you to forget something.",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          const res = await db
            .delete(memories)
            .where(and(eq(memories.id, id), eq(memories.userId, userId)))
            .returning({ id: memories.id });
          return { deleted: res.length > 0 };
        },
      }),
    },
  ];
}
