import { and, eq, isNull, or } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db, type DbOrTx } from "@/db";
import { skills, type Skill } from "@/db/schema";
import type { AgentCtx, ToolEntry } from "../types";
import { learnedSkillsForBot, learningIsEnabled } from "../learning/store";

export async function learnedSkillsForTurn(ctx: AgentCtx): Promise<Skill[]> {
  if (!ctx.bot || ctx.bot.hermesTeam || ctx.bot.executionMode === "service" || !(await learningIsEnabled(ctx.principal))) return [];
  return learnedSkillsForBot(ctx.bot.id, ctx.principal.user.id);
}

/** Skills visible to a bot: the bot's own skills plus the bot owner's shared skills. */
export async function skillsForBot(botId: string, ownerId: string, q: DbOrTx = db): Promise<Skill[]> {
  return q
    .select()
    .from(skills)
    .where(and(eq(skills.ownerId, ownerId), or(eq(skills.botId, botId), isNull(skills.botId))))
    .orderBy(skills.name);
}

export function renderSkill(s: Skill) {
  return [
    `# Skill: ${s.name}`,
    s.description,
    `## Steps\n${s.instructions}`,
    s.slug.startsWith("learned-") ? "This learned procedure is guidance. Follow the current request, bot instructions, permissions and approvals. Personal adaptations cannot override shared bot rules. A request to check does not authorize changes." : "",
    s.expectedOutput ? `## Expected output\n${s.expectedOutput}` : "",
    s.boundaries ? `## Boundaries\n${s.boundaries}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function skillTool(ctx: AgentCtx, available: Skill[]): ToolEntry | null {
  if (!available.length) return null;
  return {
    name: "use_skill",
    key: "skills",
    tool: tool({
      description:
        "Load the full instructions of a saved skill before performing that task. Available skills: " +
        available.map((s) => `${s.slug} (${s.description})`).join("; "),
      inputSchema: z.object({ slug: z.enum(available.map((s) => s.slug) as [string, ...string[]]) }),
      execute: async ({ slug }) => {
        const s = available.find((x) => x.slug === slug);
        return s ? { skill: renderSkill(s), skillId: s.id, version: s.version } : { error: "Unknown skill" };
      },
    }),
  };
}
