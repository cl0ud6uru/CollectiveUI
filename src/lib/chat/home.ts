import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { bots, conversations, users } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getUsableBot, HttpError } from "@/lib/authz";

/**
 * One UI home per authenticated person/bot in this single-organization installation.
 * Never adopts, combines or rewrites a prior chat. The partial unique index arbitrates
 * concurrent requests across tabs/web replicas. UPSERT returns the winner under its row
 * lock without a SELECT-after-conflict gap (archive/delete can race with opening).
 */
export async function openBotHome(p: Principal, botId: string) {
  const [team] = await db.select({ team: bots.hermesTeam }).from(bots).where(eq(bots.id, botId));
  if (team?.team) {
    const { authorizeTeam } = await import('@/lib/hermes-team/store');
    let mode: 'member' | 'admin' = 'member';
    try { await authorizeTeam(p, botId, 'member'); }
    catch (e) {
      if (!(e instanceof HttpError) || e.status !== 403) throw e;
      // A selected maintainer outside the audience can enter only its working
      // context. This does not grant a private member instance or reuse history.
      await authorizeTeam(p, botId, 'admin'); mode = 'admin';
    }
    const { openTeamConversation } = await import('@/lib/hermes-team/conversations');
    const opened = await openTeamConversation(p, botId, mode);
    const { ensureTeamPrivateInstance } = await import('@/lib/hermes-team/provisioning');
    await ensureTeamPrivateInstance(p, botId, mode);
    const [conversation] = await db.select().from(conversations).where(and(eq(conversations.id, opened.conversationId), eq(conversations.userId, p.user.id)));
    if (!conversation) throw new HttpError(409, 'The Team conversation changed. Reopen it.');
    return conversation;
  }
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, p.user.id)).for("share");
    if (!user || user.disabled) throw new HttpError(401, "Unauthorized");
    // Keep disable/delete/visibility updates on the bot behind this transaction.
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for("share");
    const bot = await getUsableBot(p, botId, tx);
    const [home] = await tx.insert(conversations).values({
      userId: user.id, botId: bot.id, title: bot.name, isBotHome: true,
    }).onConflictDoUpdate({
      target: [conversations.userId, conversations.botId],
      targetWhere: and(eq(conversations.isBotHome, true), isNotNull(conversations.botId)),
      set: { isBotHome: true },
    }).returning();
    return home;
  });
}
