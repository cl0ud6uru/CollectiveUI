import { eq } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db";
import { bots } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { assertAdmin, getUsableBot, HttpError } from "@/lib/authz";
import { hasSharedPetIdentity } from "./policy";

export function assertPersonalPetAllowed(bot: Parameters<typeof hasSharedPetIdentity>[0]) {
  if (hasSharedPetIdentity(bot)) throw new HttpError(403, "This bot's pet is shared. Only its authorized owner or an admin can change the shared pet.");
}

/** Match visibility changes' bot-row lock before mutating personal preferences/imports. */
export async function lockPetViewer(p: Principal, botId: string, tx: Tx) {
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for("update");
  const fresh = await loadPrincipal(p.user.id, tx);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
  return getUsableBot(fresh, botId, tx);
}

/** Recheck after acquiring mutation locks: an editable caller-bot owner may have lost admin rights. */
export async function assertFreshPetAdmin(p: Principal, q: DbOrTx) {
  const fresh = await loadPrincipal(p.user.id, q);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Admin only");
  assertAdmin(fresh);
}
