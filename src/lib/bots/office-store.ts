import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { aiApps, bots, botTools, providerConnections, settings, users } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { assertAdmin, HttpError } from "@/lib/authz";
import { getSetting, type SandboxSettings } from "@/lib/settings";
import { sandboxd } from "@/lib/sandbox/client";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { OFFICE_BOT, officeModelEligible } from "./office-policy";

export async function officeModels() {
  const rows = await db.select({ app: aiApps }).from(aiApps)
    .leftJoin(providerConnections, eq(providerConnections.id, aiApps.providerConnectionId))
    .where(sql`${aiApps.providerConnectionId} is null or ${providerConnections.enabled} = true`)
    .orderBy(asc(aiApps.name));
  return rows.map(r => r.app).filter(officeModelEligible);
}

/** Probe a fresh disposable workspace, never a person's existing files. Cleanup also runs on failure. */
export async function checkOfficeWorkspace(sandbox: SandboxSettings) {
  const client = sandboxd();
  if (!client) throw new HttpError(503, "Configure sandboxd before adding Office Bot (Admin → Workspaces).");
  const health = await client.health();
  if (!health.ok || !health.image.present) throw new HttpError(503, "The workspace service/image is unavailable. Build the Office sandbox image and configure sandboxd to use it.");
  if (!sandbox.allowRunc && !health.gvisor.available) throw new HttpError(503, "Workspace isolation is unavailable. Configure gVisor in Admin → Workspaces.");
  const ref = randomBytes(10).toString("hex");
  try {
    const result = await client.exec(ref, { isolation: requiredIsolation(sandbox), command: "/opt/portal/office-check", timeoutMs: 20_000, execId: randomBytes(8).toString("hex") });
    if (result.code !== 0 || result.reason !== "exited") throw new HttpError(503, "Office tooling is unavailable. Rebuild the Office sandbox image and configure sandboxd to use it before adding the bot.");
  } finally {
    await client.destroy(ref);
  }
}

export async function installOfficeBot(p: Principal, raw: unknown) {
  assertAdmin(p);
  const input = z.object({ appId: z.string().min(1).max(128) }).strict().parse(raw);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('installation-office-bot', 0))`);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for("share");
    const fresh = await loadPrincipal(p.user.id, tx);
    if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
    assertAdmin(fresh);
    const config = await getSetting("officeBot", tx);
    if (config.botId) {
      const [existing] = await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, config.botId));
      if (!existing) throw new HttpError(409, "The installed Office Bot was deleted. Restore it or clear its officeBot installation setting before reinstalling.");
      return existing;
    }
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, input.appId)).for("share");
    if (!app || !officeModelEligible(app)) throw new HttpError(400, "Choose an enabled, public organization model with native tool support.");
    if (app.providerConnectionId) {
      const [connection] = await tx.select().from(providerConnections).where(eq(providerConnections.id, app.providerConnectionId)).for("share");
      if (!connection?.enabled) throw new HttpError(400, "This model's provider connection is disabled. Choose another model or enable its connection.");
    }
    const sandbox = await getSetting("sandbox", tx);
    const tools = await getSetting("tools", tx);
    if (!userMayUseWorkspace(fresh, sandbox) || tools.disabledTools.includes("workspace"))
      throw new HttpError(400, "Enable workspace tools in Admin → Workspaces and Bots & tools before adding Office Bot. Existing access policies are preserved.");
    await checkOfficeWorkspace(sandbox);
    const [bot] = await tx.insert(bots).values({ ...OFFICE_BOT, ownerId: fresh.user.id, appId: app.id,
      visibility: "org", executionMode: "caller", enabled: true, maxSteps: 20 }).returning({ id: bots.id });
    await tx.insert(botTools).values({ botId: bot.id, toolKey: "workspace", approval: "auto" });
    await tx.insert(settings).values({ key: "officeBot", value: { botId: bot.id } }).onConflictDoUpdate({
      target: settings.key, set: { value: { botId: bot.id }, updatedAt: new Date() },
    });
    return bot;
  });
}
