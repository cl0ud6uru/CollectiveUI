import { count, eq } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { aiApps, botDelegates, type Bot } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { getAccessibleModel, HttpError, listAccessibleBots } from "@/lib/authz";
import { canEditBot, lockEditableBot } from "@/lib/bots/service";
import { getSetting } from "@/lib/settings";

/** Incoming links change the source's team, so visibility alone is insufficient. */
export async function listEditableCoordinators(p: Principal, q: DbOrTx = db): Promise<Bot[]> {
  const candidates = (await listAccessibleBots(p, q)).filter(b =>
    b.isCoordinator && b.executionMode === "caller" && b.appId && canEditBot(p, b));
  const eligible: Bot[] = [];
  for (const bot of candidates) {
    try {
      const app = await getAccessibleModel(p, bot.appId!, q);
      if (app.provider !== "hermes" && app.supportsTools) eligible.push(bot);
    } catch (err) { if (!(err instanceof HttpError)) throw err; }
  }
  return eligible;
}

/** The submitted selection is authoritative. Never infer defaults during a save. */
export async function addSelectedDelegators(tx: Tx, p: Principal, bot: Bot, selected: string[]) {
  const ids = [...new Set(selected)].sort();
  if (!ids.length) return;
  const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId!)).for("share");
  if (bot.executionMode !== "caller" || !app?.enabled || app.provider === "hermes")
    throw new HttpError(400, "Coordinator teams require a native caller bot.");
  // Stable source lock order serializes simultaneous team edits and role changes.
  for (const id of ids) await lockEditableBot(p, id, tx);
  const fresh = await loadPrincipal(p.user.id, tx);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion)
    throw new HttpError(403, "Your access changed. Sign in again.");
  await getAccessibleModel(fresh, app.id, tx);
  const policy = await getSetting("tools", tx);
  if ((policy.botCreation === "admins" && !fresh.isAdmin) || (policy.botCreation === "groups" && !fresh.canCreateBots))
    throw new HttpError(403, "You are no longer allowed to create bots.");
  const allowed = new Set((await listEditableCoordinators(fresh, tx)).map(b => b.id));
  if (ids.some(id => id === bot.id || !allowed.has(id)))
    throw new HttpError(403, "A selected coordinator is no longer available. Review the delegator selection.");
  for (const id of ids) {
    const [team] = await tx.select({ size: count() }).from(botDelegates).where(eq(botDelegates.botId, id));
    if (team.size >= 20) throw new HttpError(400, "A selected coordinator's Team already has 20 bots. Deselect it or edit its Team first.");
  }
  await tx.insert(botDelegates).values(ids.map(botId => ({ botId, delegateBotId: bot.id }))).onConflictDoNothing();
}
