import { and, eq } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { botLearnings, memories } from "@/db/schema";
import { addMemory } from "../memory";
import type { AgentCtx, ToolEntry } from "../types";
import { changeLearning } from "../learning/store";

export function memoryTools(ctx: AgentCtx): ToolEntry[] {
  const userId = ctx.principal.user.id;
  // A repeated failed lookup in one model turn is a no-op. A successful correction
  // clears the guard so a subsequent, stateful action can target the same record.
  const unchangedForgetIds = new Map<string, "unknown" | "learned_preference">();
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
          return { saved: true, recordType: "ordinary_memory", id };
        },
      }),
    },
    {
      name: "forget",
      key: "memory",
      tool: tool({
        description: "Forget an ordinary saved memory or an active personal learned preference by exact id. If the result is unchanged or unsupported, do not retry the same id; use correct_memory for a correction.",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          const unchangedType = unchangedForgetIds.get(id);
          if (unchangedType) {
            return { deleted: false, status: "repeat_noop", recordType: unchangedType, message: "This exact target already returned no change in this turn. Do not retry it without a relevant state change." };
          }
          const res = await db
            .delete(memories)
            .where(and(eq(memories.id, id), eq(memories.userId, userId)))
            .returning({ id: memories.id });
          if (res.length) return { deleted: true, status: "forgotten", recordType: "ordinary_memory" };

          const [learning] = ctx.bot ? await db.select({ id: botLearnings.id, version: botLearnings.version, status: botLearnings.status })
            .from(botLearnings).where(and(
              eq(botLearnings.id, id), eq(botLearnings.userId, userId), eq(botLearnings.botId, ctx.bot.id), eq(botLearnings.kind, "preference"),
            )) : [];
          if (learning?.status === "active") {
            await changeLearning(ctx.principal, learning.id, learning.version, { status: "archived" });
            return { deleted: true, status: "forgotten", recordType: "learned_preference" };
          }
          if (learning?.status === "pending") {
            unchangedForgetIds.set(id, "learned_preference");
            return { deleted: false, status: "unsupported_pending", recordType: "learned_preference", message: "This preference has a pending change and a previously approved version. Review or correct it in the bot's Memory controls; this request made no change." };
          }

          unchangedForgetIds.set(id, "unknown");
          return { deleted: false, status: "not_found", recordType: "unknown", message: "No matching saved memory changed. Do not retry this id; use correct_memory for a correction." };
        },
      }),
    },
    {
      name: "correct_memory",
      key: "memory",
      tool: tool({
        description: "Correct a saved memory or personal learned preference by its exact id. Ordinary memories are updated in place. Learned preferences receive a new revision and keep their existing ownership and approval state. Do not use this for shared procedures or policies.",
        inputSchema: z.object({ id: z.string(), fact: z.string().trim().min(1).max(1000) }),
        execute: async ({ id, fact }) => {
          const [memory] = await db.select({ id: memories.id }).from(memories).where(and(eq(memories.id, id), eq(memories.userId, userId)));
          if (memory) {
            await db.update(memories).set({ content: fact, embedding: null, updatedAt: new Date() })
              .where(and(eq(memories.id, id), eq(memories.userId, userId)));
            unchangedForgetIds.delete(id);
            return { corrected: true, status: "corrected", recordType: "ordinary_memory" };
          }

          const [learning] = ctx.bot ? await db.select({ id: botLearnings.id, version: botLearnings.version, status: botLearnings.status, content: botLearnings.content })
            .from(botLearnings).where(and(
              eq(botLearnings.id, id), eq(botLearnings.userId, userId), eq(botLearnings.botId, ctx.bot.id), eq(botLearnings.kind, "preference"),
            )) : [];
          if (!learning) return { corrected: false, status: "not_found", recordType: "unknown", message: "No matching memory or personal learned preference was changed." };

          await changeLearning(ctx.principal, learning.id, learning.version, {
            content: { ...learning.content, description: fact, instructions: fact },
          });
          unchangedForgetIds.delete(id);
          return {
            corrected: true,
            status: learning.status === "pending" ? "corrected_pending" : "corrected",
            recordType: "learned_preference",
            message: learning.status === "pending" ? "The correction was saved as a new pending revision; the previously approved preference remains in effect until review." : undefined,
          };
        },
      }),
    },
  ];
}
