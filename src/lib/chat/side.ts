import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bots, conversations, users } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { getUsableBot, HttpError } from "@/lib/authz";

export async function openSideChat(p: Principal, botId: string, id: string) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, p.user.id)).for("share");
    if (!user || user.disabled) throw new HttpError(401, "Unauthorized");
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for("share");
    const bot = await getUsableBot(p, botId, tx);
    await tx.insert(conversations).values({ id, userId: p.user.id, botId: bot.id }).onConflictDoNothing();
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, id));
    if (!conv || conv.userId !== p.user.id || conv.botId !== bot.id || conv.isBotHome || conv.isGroup || conv.source !== "chat" || conv.appId)
      throw new HttpError(409, "Conversation id already in use");
    return conv;
  });
}
