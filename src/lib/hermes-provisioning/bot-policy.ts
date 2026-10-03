import { isDockerHermes } from "@/lib/docker-hermes/policy";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { aiApps, bots, hermesProvisions, type AiApp, type Bot } from "@/db/schema";
import { type Principal } from "@/lib/auth/groups";
import { assertAdmin, HttpError } from "@/lib/authz";
import { sha256Hex } from "@/lib/crypto";
import { isManagedHermes, managedConfig } from "./config";
import { isLocalHermes, localBinding } from "@/lib/local-hermes/config";
import { guardLocalBotMutation } from "@/lib/local-hermes/policy";

export function profileSpec(app: AiApp, bot: Bot) {
  const config = managedConfig.parse(app.providerConfig.managed);
  const soul = [bot.name, bot.description, bot.instructions, bot.boundaries].filter(Boolean).join("\n\n");
  if (soul.length > 32000) throw new HttpError(400, "Hermes bot instructions exceed 32,000 characters.");
  return { config, soul, hash: sha256Hex(JSON.stringify([app.id, config, soul])) };
}

export function assertApprovedBot(app: AiApp, botId?: string) {
  if (isLocalHermes(app) && localBinding(app).botId !== botId)
    throw new HttpError(403, "Local Hermes can only be used by its explicitly paired bot. Pair an existing profile in Admin → Hermes.");
  if (isManagedHermes(app) && (!botId || app.providerConfig.managedBotId !== botId))
    throw new HttpError(403, "This managed Hermes definition needs admin approval. Create or approve its bot in Admin → Hermes; copying a managed app does not grant provisioning access.");
}

/** Shared with first-use reservation. Caller holds this lock through its write; lock order is bot, then connection. */
export async function lockBot(tx: DbOrTx, botId: string) {
  const [bot] = await tx.select().from(bots).where(eq(bots.id, botId)).for("update");
  if (!bot) throw new HttpError(404, "Bot not found");
  return bot;
}

export async function guardManagedBotMutation(tx: DbOrTx, p: Principal, botId: string, input: Partial<Bot> | null) {
  const bot = await lockBot(tx, botId);
  const [localApp] = bot.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  if (localApp && isLocalHermes(localApp)) { if (!isDockerHermes(localApp)) assertAdmin(p); guardLocalBotMutation(localApp, bot.id, input); }
  const assignments = await tx.select({ specHash: hermesProvisions.specHash }).from(hermesProvisions).where(eq(hermesProvisions.botId, botId));
  const assigned = assignments.length > 0;
  if (!input) {
    if (assigned) throw new HttpError(409, "This bot has retained Hermes profiles. Disable it in Admin → Bots instead of deleting it; its memories and cancellation binding must be preserved.");
    return;
  }
  const [app] = bot.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
  if (!app || !isManagedHermes(app)) return;
  assertAdmin(p);
  if (input.appId !== bot.appId || (assigned && assignments.some((r) => r.specHash !== profileSpec(app, { ...bot, ...input }).hash)))
    throw new HttpError(409, "The app and assigned Hermes definition are frozen. Keep the name, description, instructions and boundaries unchanged; create a new managed bot in Admin → Hermes for a different definition. Existing memories are retained.");
}

const restoration = z.object({
  name: z.string().min(1).max(100), description: z.string().max(2000).nullable(),
  instructions: z.string().max(24000).nullable(), boundaries: z.string().max(5000).nullable(),
}).strict();

/** Explicit migration for pre-approval definitions. Never adopts another bot's reservations or changes their hash. */
export async function approveManagedBot(p: Principal, appId: string, botId: string, restore?: unknown) {
  assertAdmin(p);
  const original = restore === undefined ? undefined : restoration.parse(restore);
  await db.transaction(async (tx) => {
    const bot = await lockBot(tx, botId);
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, appId)).for("update");
    if (!app || !isManagedHermes(app) || bot.appId !== appId) throw new HttpError(400, "Select the managed app's existing bot.");
    if (app.providerConfig.managedBotId && app.providerConfig.managedBotId !== botId) throw new HttpError(409, "This app is already bound to another bot. Create a new managed definition.");
    const rows = await tx.select().from(hermesProvisions).where(eq(hermesProvisions.appId, appId));
    const spec = profileSpec(app, { ...bot, ...original });
    if (original && !rows.length) throw new HttpError(409, "No retained assignment exists to verify a restoration against.");
    if (rows.some((r) => r.botId !== botId || r.specHash !== spec.hash))
      throw new HttpError(409, "Existing profile bindings conflict. Restore the original bot definition and ask an operator to reconcile the retained assignments before approving.");
    if (original) await tx.update(bots).set({ ...original, updatedAt: new Date() }).where(eq(bots.id, botId));
    await tx.update(aiApps).set({ providerConfig: { ...app.providerConfig, managedBotId: botId } }).where(eq(aiApps.id, appId));
  });
}
