import { and, eq } from "drizzle-orm";
import { botAccess, botDelegates, botTools, botUserAccess, bots, codexBotConfigs, type Bot } from "@/db/schema";
import type { Tx } from "@/db";
import { HttpError } from "@/lib/authz";

type BotConfigInput = {
  name: string; avatar?: string | null; label?: string | null; description?: string | null;
  instructions?: string | null; boundaries?: string | null; appId: string; codex?: unknown;
  visibility: "private" | "groups" | "org"; groupIds: string[]; userIds?: string[];
  maxSteps: number; starters: string[]; tools: { key: string; approval: "auto" | "ask" | "smart"; config?: unknown }[];
  delegateIds: string[]; executionMode?: "caller" | "service"; coordinatorEligible?: boolean; isCoordinator?: boolean;
};
type Validated = { tools: BotConfigInput["tools"]; delegates: string[]; userIds: string[]; maxSteps: number };

/** Shared relation writer for the bot editor and The Architect's restricted configuration API. */
export async function saveBotRelations(tx: Tx, botId: string, input: BotConfigInput, validated: Validated) {
  if (input.codex) await tx.insert(codexBotConfigs).values({ botId, policy: input.codex as never }).onConflictDoUpdate({ target: codexBotConfigs.botId, set: { policy: input.codex as never } });
  else await tx.delete(codexBotConfigs).where(eq(codexBotConfigs.botId, botId));
  await tx.delete(botTools).where(eq(botTools.botId, botId));
  if (validated.tools.length)
    await tx.insert(botTools).values(validated.tools.map(t => ({ botId, toolKey: t.key, approval: t.approval, config: (t.config ?? null) as never })));
  await tx.delete(botDelegates).where(eq(botDelegates.botId, botId));
  if (validated.delegates.length) await tx.insert(botDelegates).values(validated.delegates.map(delegateBotId => ({ botId, delegateBotId })));
  await tx.delete(botAccess).where(eq(botAccess.botId, botId));
  if (input.visibility === "groups" && input.groupIds.length)
    await tx.insert(botAccess).values([...new Set(input.groupIds)].map(groupId => ({ botId, groupId })));
  // Older editors omit userIds; do not overwrite their existing grants.
  if (input.visibility !== "groups" || input.userIds !== undefined) {
    await tx.delete(botUserAccess).where(eq(botUserAccess.botId, botId));
    if (input.visibility === "groups" && validated.userIds.length)
      await tx.insert(botUserAccess).values(validated.userIds.map(userId => ({ botId, userId })));
  }
}

/** Shared compare-and-swap bot editor write. The caller owns validation and holds the bot row lock. */
export async function persistBotUpdate(tx: Tx, current: Bot, input: BotConfigInput, validated: Validated, expectedRevision?: number) {
  if (expectedRevision !== undefined && expectedRevision !== current.revision)
    throw new HttpError(409, "Bot configuration changed. Read it again and request fresh approval.");
  const nextRevision = current.revision + 1;
  const changed = await tx.update(bots).set({
    name: input.name, avatar: input.avatar || current.avatar, label: input.label || null,
    description: input.description, instructions: input.instructions, boundaries: input.boundaries,
    appId: input.codex ? null : input.appId, visibility: input.visibility, maxSteps: validated.maxSteps,
    starters: input.starters.filter(Boolean), executionMode: input.executionMode ?? current.executionMode,
    coordinatorEligible: input.coordinatorEligible ?? current.coordinatorEligible,
    isCoordinator: input.isCoordinator ?? current.isCoordinator, revision: nextRevision,
    publishedRevision: null, publishedConfigHash: null, updatedAt: new Date(),
  }).where(and(eq(bots.id, current.id), eq(bots.revision, current.revision))).returning();
  if (changed.length !== 1) throw new HttpError(409, "Bot configuration changed. Read it again and request fresh approval.");
  await saveBotRelations(tx, current.id, input, validated);
  return changed[0];
}

/** Update only builtin groups while preserving separately managed MCP assignments on the bot. */
export async function persistBotToolAssignments(tx: Tx, current: Bot, tools: { key: string; approval: "auto" | "ask" | "smart" }[], expectedRevision: number) {
  if (expectedRevision !== current.revision)
    throw new HttpError(409, "Bot configuration changed. Read it again and request fresh approval.");
  const retained = await tx.select().from(botTools).where(eq(botTools.botId, current.id));
  const mcp = retained.filter(row => row.toolKey.startsWith("mcp:"));
  const nextRevision = current.revision + 1;
  const [saved] = await tx.update(bots).set({ revision: nextRevision, publishedRevision: null, publishedConfigHash: null, updatedAt: new Date() })
    .where(and(eq(bots.id, current.id), eq(bots.revision, current.revision))).returning();
  if (!saved) throw new HttpError(409, "Bot configuration changed. Read it again and request fresh approval.");
  await tx.delete(botTools).where(eq(botTools.botId, current.id));
  const rows = [...mcp, ...tools.map(tool => ({ botId: current.id, toolKey: tool.key, approval: tool.approval, config: null }))];
  if (rows.length) await tx.insert(botTools).values(rows);
  const readback = await tx.select({ key: botTools.toolKey, approval: botTools.approval, config: botTools.config }).from(botTools).where(eq(botTools.botId, current.id));
  const normalize = (items: { key: string; approval: string; config: unknown }[]) =>
    items.map(row => ({ key: row.key, approval: row.approval, config: row.config })).sort((a, b) => a.key.localeCompare(b.key));
  if (JSON.stringify(normalize(readback)) !== JSON.stringify(normalize(rows.map(row => ({ key: row.toolKey, approval: row.approval, config: row.config })))))
    throw new HttpError(409, "Bot tool assignments could not be verified.");
  return { bot: saved, tools: readback };
}
