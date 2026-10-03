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
