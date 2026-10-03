import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { aiApps, bots, settings, userBotPrefs, users, type Bot } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { assertAdmin, getAccessibleModel, HttpError, listAccessibleBots } from "@/lib/authz";
import { getSetting, type CoordinatorSettings } from "@/lib/settings";

const empty: CoordinatorSettings = { enabled: false, defaultBotId: null, starterBotId: null };
export const coordinatorInput = z.object({ enabled: z.boolean(), defaultBotId: z.string().min(1).max(128).nullable() }).strict();
export const starterInput = z.object({ name: z.string().trim().min(1).max(80).default("Queen"), appId: z.string().min(1).max(128).nullable() }).strict();

async function currentAdmin(p: Principal, tx: Tx) {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for("share");
  const fresh = await loadPrincipal(p.user.id, tx);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
  assertAdmin(fresh);
  return fresh;
}

async function lockedSettings(tx: Tx) {
  // Both first creation and subsequent changes serialize across web replicas.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('installation-coordinator', 0))`);
  const [row] = await tx.select().from(settings).where(eq(settings.key, "coordinator"));
  return { ...empty, ...(row?.value as Partial<CoordinatorSettings> | undefined) };
}
async function save(tx: Tx, value: CoordinatorSettings) {
  await tx.insert(settings).values({ key: "coordinator", value }).onConflictDoUpdate({
    target: settings.key, set: { value, updatedAt: new Date() },
  });
}

/** Admin selection is explicit; a model-less starter can be configured later. */
export async function configureCoordinator(p: Principal, raw: unknown) {
  const input = coordinatorInput.parse(raw);
  return db.transaction(async tx => {
    const config = await lockedSettings(tx);
    await currentAdmin(p, tx);
    if (input.enabled && !input.defaultBotId) throw new HttpError(400, "Choose a coordinator first.");
    if (input.defaultBotId) {
      const [bot] = await tx.select().from(bots).where(eq(bots.id, input.defaultBotId)).for("share");
      const [app] = bot?.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)).for("share") : [];
      if (!bot?.enabled || bot.executionMode !== "caller" || (bot.appId && (!app?.enabled || app.provider === "hermes" || !app.supportsTools)))
        throw new HttpError(400, "Choose an enabled native caller bot with a tool-capable model, or configure its model first.");
    }
    await save(tx, { ...config, ...input });
  });
}

/** Creates once per installation, with a receipt that also survives deletion. Retries never overwrite edits. */
export async function createCoordinatorStarter(p: Principal, raw: unknown) {
  const input = starterInput.parse(raw);
  return db.transaction(async tx => {
    const config = await lockedSettings(tx);
    const fresh = await currentAdmin(p, tx);
    if (config.starterBotId) {
      const [existing] = await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, config.starterBotId));
      if (!existing) throw new HttpError(409, "The starter was deleted. Choose an existing bot as coordinator.");
      return existing;
    }
    if (input.appId) {
      const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, input.appId)).for("share");
      if (!app?.enabled || app.provider === "hermes" || !app.supportsTools)
        throw new HttpError(400, "Choose an enabled native model with tool support.");
    }
    const [bot] = await tx.insert(bots).values({
      ownerId: fresh.user.id, name: input.name, avatar: "blob:hexagon:purple", label: "Coordinator",
      description: "Your starting point for planning work and bringing specialist answers together.",
      instructions: "Be a calm, clear and resourceful teammate. Help the user define their goal, break it into focused assignments, and use the available specialist tools when useful. Give each specialist a self-contained task with only the context it needs. Synthesize returned evidence, name uncertainties, and explain what remains. Respect the user's decisions and keep private work private.",
      boundaries: "Only use the tools actually offered for this turn. Do not claim to have assigned work without a successful tool call. Synchronous assignments wait within this reply; accepted asynchronous assignments run in linked task conversations and return here before this reply continues. Report the actual task status; do not promise scheduled followups or unsupported background work. If a specialist needs approval, ask the user to open its direct chat. Never imply access to another person's conversations or accounts.",
      starters: ["Help me plan a project", "Which specialists can help with this?", "Break this goal into focused assignments"],
      appId: input.appId, visibility: "org", maxSteps: 10, executionMode: "caller",
    }).returning({ id: bots.id });
    await save(tx, { enabled: true, defaultBotId: bot.id, starterBotId: bot.id });
    return bot;
  });
}

/** Audience-filtered, with no admin oversight bypass or hidden sidebar metadata in the automatic entry. */
export async function defaultCoordinator(p: Principal): Promise<{ bot: Bot; ready: boolean } | null> {
  const fresh = await loadPrincipal(p.user.id);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) return null;
  const config = await getSetting("coordinator");
  if (!config.enabled || !config.defaultBotId) return null;
  const bot = (await listAccessibleBots(fresh)).find(b => b.id === config.defaultBotId && b.executionMode === "caller");
  if (!bot) return null;
  const [pref] = await db.select().from(userBotPrefs).where(and(eq(userBotPrefs.userId, fresh.user.id), eq(userBotPrefs.botId, bot.id)));
  if (pref?.hidden) return null;
  if (!bot.appId) return { bot, ready: false };
  const [configuredApp] = await db.select().from(aiApps).where(eq(aiApps.id, bot.appId));
  if (configuredApp?.provider === "hermes") return null;
  try {
    const app = await getAccessibleModel(fresh, bot.appId);
    if (!app.supportsTools) return null;
    return { bot, ready: true };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // No connection metadata or fallback model is exposed.
    return { bot, ready: false };
  }
}
