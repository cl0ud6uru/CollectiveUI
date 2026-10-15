import { db, type DbOrTx } from "@/db";
import type { Principal } from "@/lib/auth/groups";
import { loadPrincipal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { getSetting, type PetGenerationSettings } from "@/lib/settings";

/** Shared with ChatGPT and sandbox access controls: selected UPNs or portal groups, with admin access. */
export function userMayGeneratePet(p: Principal, settings: PetGenerationSettings) {
  if (p.isAdmin) return true;
  if (settings.access === "everyone") return true;
  const upn = p.user.upn.trim().toLowerCase();
  return settings.allowedUpns.some(value => value.trim().toLowerCase() === upn) ||
    p.groupIds.some(groupId => settings.allowedGroupIds.includes(groupId));
}

/** Resolve current group/admin state and the current setting after taking the caller's mutation locks. */
export async function assertFreshPetGenerationAccess(p: Principal, q: DbOrTx = db, requireEnabled = false) {
  const fresh = await loadPrincipal(p.user.id, q);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
  const settings = await getSetting("petGeneration", q);
  if (!userMayGeneratePet(fresh, settings)) throw new HttpError(403, "AI pet generation is not available for your account.");
  if (requireEnabled && !settings.enabled) throw new HttpError(409, "Pet image generation is disabled or not configured.");
  return { principal: fresh, settings };
}
