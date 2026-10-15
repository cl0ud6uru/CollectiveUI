import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbOrTx } from "@/db";
import { aiApps, bots, providerConnections, settings, users } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { auditVia } from "@/lib/audit";
import { assertAdmin, HttpError } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import { ARCHITECT_BOT, ARCHITECT_SETTING, architectModelEligible, isArchitectBot } from "./architect-policy";

/** True while `botId` is the installed Architect (reads the installation receipt). */
export async function isInstalledArchitect(botId: string, q: DbOrTx = db) {
  return isArchitectBot({ id: botId }, (await getSetting(ARCHITECT_SETTING, q)).botId);
}

export async function architectModels() {
  const rows = await db.select({ app: aiApps }).from(aiApps)
    .leftJoin(providerConnections, eq(providerConnections.id, aiApps.providerConnectionId))
    .where(sql`${aiApps.providerConnectionId} is null or ${providerConnections.enabled} = true`)
    .orderBy(asc(aiApps.name));
  return rows.map(r => r.app).filter(architectModelEligible);
}

/**
 * Installs The Architect once, owned by the installing admin and private (botVisibleTo shows it to every admin and to
 * nobody else). No bot_tools row: its admin tools follow the receipt. Repeated or concurrent installs return the same
 * bot and keep edits and disabled state; a deleted installation is never silently recreated.
 */
export async function installArchitectBot(p: Principal, raw: unknown): Promise<{ id: string; created: boolean }> {
  assertAdmin(p);
  const input = z.object({ appId: z.string().min(1).max(128) }).strict().parse(raw);
  const result = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('installation-architect-bot', 0))`);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for("share");
    const fresh = await loadPrincipal(p.user.id, tx);
    if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
    assertAdmin(fresh);
    const receipt = await getSetting(ARCHITECT_SETTING, tx);
    if (receipt.botId) {
      const [existing] = await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, receipt.botId));
      if (!existing) throw new HttpError(409, "The installed Architect was deleted. Restore it or clear its architectBot installation setting before reinstalling.");
      return { id: existing.id, created: false };
    }
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, input.appId)).for("share");
    if (!app || !architectModelEligible(app)) throw new HttpError(400, "Choose an enabled organization model with native tool support.");
    if (app.providerConnectionId) {
      const [connection] = await tx.select().from(providerConnections).where(eq(providerConnections.id, app.providerConnectionId)).for("share");
      if (!connection?.enabled) throw new HttpError(400, "This model's provider connection is disabled. Choose another model or enable its connection.");
    }
    const [bot] = await tx.insert(bots).values({ ...ARCHITECT_BOT, ownerId: fresh.user.id, appId: app.id,
      visibility: "private", executionMode: "caller", enabled: true, maxSteps: 20 }).returning({ id: bots.id });
    await tx.insert(settings).values({ key: ARCHITECT_SETTING, value: { botId: bot.id } }).onConflictDoUpdate({
      target: settings.key, set: { value: { botId: bot.id }, updatedAt: new Date() },
    });
    await auditVia(fresh.user.id, { agent: "architect", botId: bot.id }, "architect.install", bot.id, { appId: input.appId }, tx);
    return { id: bot.id, created: true };
  });
  return result;
}
