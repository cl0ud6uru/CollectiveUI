import type { Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
export type PetBot = Pick<Bot, "id" | "ownerId" | "visibility" | "executionMode">;
export const hasSharedPetIdentity = (bot: Pick<PetBot, "visibility" | "executionMode">) =>
  bot.visibility !== "private" || bot.executionMode === "service";
export const canManagePetDefault = (p: Principal, bot: PetBot) =>
  p.isAdmin || (bot.executionMode === "caller" && bot.visibility !== "private" && bot.ownerId === p.user.id);
/**
 * Preserve deletion protection for built-in IDs retained by existing installations.
 * Unpublishing hides them without losing saved references. Generated catalog IDs never contain "-".
 */
export const isBundledPet = (id: string) => id.startsWith("builtin-");
