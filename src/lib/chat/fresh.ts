import { HERMES_BOT_ONLY_MESSAGE } from "@/lib/llm/model-policy";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, bots, conversations, hermesChatSettings, messages, users, type AiApp, type Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getUsableBot, HttpError } from "@/lib/authz";
import { allowedHermesModels, hermesTargetKey } from "@/lib/llm/providers/hermes/scope";
import { assertHermesIdle, hermesSettings } from "@/lib/runs/hermes-context";
import { lockUserRuns } from "@/lib/runs/lock";

/** Local /new: rotate homes, fork ordinary chats. Never clears provider/profile or portal memory. */
export async function freshConversation(p: Principal, target: { conversationId: string; bot: Bot | null; app: AiApp; requireSource?: boolean }, nextId: string) {
  if (target.app.provider === "hermes" && !target.bot) throw new HttpError(400, HERMES_BOT_ONLY_MESSAGE);
  if (!nextId || nextId === target.conversationId) throw new HttpError(400, "A fresh conversation id is required.");
  return db.transaction(async (tx) => {
    // Same lock as run admission and approval continuation: no hidden live work is displaced.
    await lockUserRuns(tx, p.user.id);
    const [user] = await tx.select().from(users).where(eq(users.id, p.user.id)).for("share");
    if (!user || user.disabled) throw new HttpError(401, "Unauthorized");
    if (target.bot) {
      await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, target.bot.id)).for("share");
      await getUsableBot(p, target.bot.id, tx);
    }
    const [source] = await tx.select().from(conversations).where(eq(conversations.id, target.conversationId)).for("update");
    if (!source && target.requireSource) throw new HttpError(404, "Conversation not found");
    if (source && (source.userId !== p.user.id || source.botId !== (target.bot?.id ?? null) || source.appId !== (target.bot ? null : target.app.id)))
      throw new HttpError(404, "Conversation not found");
    if (source?.isGroup || (source && source.source !== "chat")) throw new HttpError(400, "Start a fresh chat from a direct conversation.");
    // A stale tab or retried request from a retired home returns the first successor, even with a new attempt ID.
    if (source?.homeSuccessorId) {
      const [successor] = await tx.select().from(conversations).where(eq(conversations.id, source.homeSuccessorId));
      if (!successor || successor.userId !== p.user.id || successor.botId !== source.botId || successor.appId !== source.appId)
        throw new HttpError(409, "That fresh chat was deleted. Select the bot to reopen its current home.");
      return successor;
    }
    // Also rejects pending provider cancellation. For non-Hermes this checks only local run/approval state.
    await assertHermesIdle(tx, target.conversationId, "This chat has an unfinished reply or approval. Wait for it to finish, use Stop, or answer the approval before starting a fresh chat.");
    const [legacyApproval] = await tx.select({ id: messages.id }).from(messages)
      .leftJoin(agentRuns, eq(agentRuns.messageId, messages.id))
      .where(and(eq(messages.conversationId, target.conversationId), eq(messages.role, "assistant"), isNull(agentRuns.id), sql`${messages.parts} @> '[{"state":"approval-requested"}]'::jsonb`)).limit(1);
    if (legacyApproval) throw new HttpError(409, "This chat has a pending approval. Answer it before starting a fresh chat.");
    if (source?.isBotHome) await tx.update(conversations).set({
      isBotHome: false, homeSuccessorId: nextId, updatedAt: new Date(),
    }).where(eq(conversations.id, source.id));
    const next = { id: nextId, userId: p.user.id, appId: target.bot ? null : target.app.id, botId: target.bot?.id ?? null, isBotHome: source?.isBotHome ?? false, title: source?.isBotHome ? target.bot?.name ?? "New chat" : "New chat" };
    const [inserted] = await tx.insert(conversations).values(next).onConflictDoNothing().returning();
    const [created] = inserted ? [inserted] : await tx.select().from(conversations).where(eq(conversations.id, nextId));
    if (!created || (source?.isBotHome && !inserted) || created.userId !== next.userId || created.appId !== next.appId || created.botId !== next.botId || created.isGroup || created.source !== "chat" || created.isBotHome !== next.isBotHome)
      throw new HttpError(409, "That conversation id is already in use.");
    if (target.app.provider === "hermes") {
      const setting = await hermesSettings(target.conversationId, tx);
      if (setting?.model && setting.targetKey === hermesTargetKey(target.app) && allowedHermesModels(target.app).includes(setting.model))
        await tx.insert(hermesChatSettings).values({ conversationId: created.id, targetKey: setting.targetKey, model: setting.model }).onConflictDoNothing();
    }
    return created;
  });
}
