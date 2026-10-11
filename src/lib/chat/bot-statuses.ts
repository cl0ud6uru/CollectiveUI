import type { Principal } from "@/lib/auth/groups";
import { listAccessibleBots } from "@/lib/authz";
import { loadBotWorkStatuses } from "./roster";

/** Complete replacement snapshot, including idle; never reveals conversation IDs or other people's work. */
export async function botStatusSnapshot(p: Principal) {
  const bots = await listAccessibleBots(p);
  const statuses = await loadBotWorkStatuses(p, bots.map(bot => bot.id));
  return Object.fromEntries(bots.map(bot => [bot.id, statuses.get(bot.id) ?? null]));
}
