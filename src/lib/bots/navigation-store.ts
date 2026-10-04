import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users, userBotPrefs } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { HttpError, listAccessibleBots } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import { changeBotNavigation, orderBots } from "./navigation";

const id = z.string().min(1).max(128);
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preference"), botId: id, pinned: z.boolean().optional(), hidden: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("move"), botId: id, targetId: id, placement: z.enum(["before", "after"]) }).strict(),
]);

export async function saveBotNavigation(p: Principal, raw: unknown) {
  const input = inputSchema.parse(raw);
  await db.transaction(async tx => {
    // Serialize tabs and pin/order changes with other user preferences. Never overwrite an unrelated preference.
    const [user] = await tx.select().from(users).where(eq(users.id, p.user.id)).for("update");
    const fresh = await loadPrincipal(p.user.id, tx);
    if (!user || !fresh || user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
    const accessible = await listAccessibleBots(fresh, tx);
    const prefs = await tx.select().from(userBotPrefs).where(eq(userBotPrefs.userId, user.id));
    const config = await getSetting("coordinator", tx);
    const byBot = new Map(prefs.map(pref => [pref.botId, pref]));
    const ordered = orderBots(accessible.map(b => ({ id: b.id, name: b.name, pinned: byBot.get(b.id)?.pinned ?? false, hidden: byBot.get(b.id)?.hidden ?? false, coordinator: config.enabled && config.defaultBotId === b.id })), user.prefs.botOrder);
    if (!ordered.some(b => b.id === input.botId) || (input.kind === "move" && !ordered.some(b => b.id === input.targetId)))
      throw new HttpError(403, "This bot is no longer available in your navigation. Refresh and try again.");
    const next = changeBotNavigation(ordered, input);
    if (input.kind === "preference") {
      const bot = next.find(b => b.id === input.botId)!;
      const values = { userId: user.id, botId: bot.id, pinned: bot.pinned, hidden: bot.hidden, updatedAt: new Date() };
      await tx.insert(userBotPrefs).values(values).onConflictDoUpdate({ target: [userBotPrefs.userId, userBotPrefs.botId], set: { pinned: bot.pinned, hidden: bot.hidden, updatedAt: values.updatedAt } });
    }
    // Stale IDs are pruned here and ignored on every read, never used to load bots or grant access.
    await tx.update(users).set({ prefs: { ...user.prefs, botOrder: next.map(b => b.id) } }).where(eq(users.id, user.id));
  });
}
