import { isDockerHermes, dockerAllowed } from "@/lib/docker-hermes/policy";
import type { AiApp, Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { isLocalHermes, localBinding } from "./config";

type LocalApp = Pick<AiApp, "id" | "provider" | "providerConfig" | "isPublic">;
export async function assertLocalBot(p: Principal, app: LocalApp, bot: Bot | null) {
  if (!isLocalHermes(app)) return;
  const b = localBinding(app);
  if ((isDockerHermes(app) ? !await dockerAllowed(p) : !p.isAdmin) || p.user.id !== b.ownerId || !bot || bot.id !== b.botId || bot.ownerId !== b.ownerId ||
      bot.visibility !== "private" || bot.executionMode !== "caller" || bot.coordinatorEligible || bot.isCoordinator || app.isPublic)
    throw new HttpError(403, "Local Hermes is a private, single-administrator pilot. Only its paired owner and bot may use this profile; shared, service and coordinator use are unsupported.");
}

export function guardLocalBotMutation(app: LocalApp, botId: string, input: Partial<Bot> | null) {
  if (!isLocalHermes(app)) return;
  if (!input) throw new HttpError(409, "This bot retains a native Hermes session binding. Disable it instead of deleting it.");
  const b = localBinding(app);
  if (botId !== b.botId || input.appId !== app.id || input.visibility !== "private" || input.executionMode === "service" || input.coordinatorEligible || input.isCoordinator || input.instructions || input.boundaries)
    throw new HttpError(409, "Keep this Local Hermes bot private and on its paired engine. Persona and standing instructions are managed in Hermes; create another bot for a different engine.");
}
