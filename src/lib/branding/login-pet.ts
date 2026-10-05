import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, petCatalog, settings } from "@/db/schema";
import { HttpError } from "@/lib/authz";
import type { BotPetDefault } from "@/lib/pets/shared";
import { getSetting, type LoginPetSettings } from "@/lib/settings";
import { LOGIN_PET_NAMES, loginPetSpriteUrl, type PublicLoginPet } from "./shared";

/** Only the pinned, still-published revision is public. Unpublishing or deleting the pet falls back to the portal bot. */
function activePet(choice: LoginPetSettings) {
  if (choice.appearance !== "catalog" || !choice.catalogId || !choice.revision) return null;
  return and(eq(petCatalog.id, choice.catalogId), eq(petCatalog.revision, choice.revision), eq(petCatalog.status, "published"));
}

const builtIn = (appearance: keyof typeof LOGIN_PET_NAMES): PublicLoginPet => ({ appearance, name: LOGIN_PET_NAMES[appearance] });

export async function getPublicLoginPet(): Promise<PublicLoginPet> {
  const choice = await getSetting("loginPet");
  if (choice.appearance !== "catalog") return builtIn(choice.appearance);
  const where = activePet(choice);
  const [row] = where ? await db.select({ manifest: petCatalog.manifest, revision: petCatalog.revision, hd: sql<boolean>`${petCatalog.spriteHd} is not null` }).from(petCatalog).where(where) : [];
  if (!row) return builtIn("off");
  return { appearance: "catalog", name: row.manifest.displayName, credit: row.manifest.credit, spriteVersionNumber: row.manifest.spriteVersionNumber, spriteUrl: loginPetSpriteUrl(row.revision),
    spriteHdUrl: row.hd ? loginPetSpriteUrl(row.revision, true) : null };
}

/** The HD rendition shares the pinned revision, so the same public confirmation covers it. */
export async function readLoginPetSprite(hd = false): Promise<Buffer | null> {
  const where = activePet(await getSetting("loginPet"));
  if (!where) return null;
  const [row] = await db.select({ sprite: hd ? petCatalog.spriteHd : petCatalog.sprite }).from(petCatalog).where(where);
  return row?.sprite ?? null;
}

/**
 * Catalog publication covers signed-in users only, so showing one on the public sign-in page needs its own
 * confirmation, recorded with the exact revision. Callers authorize the admin first.
 */
export async function saveLoginPet(actorId: string, choice: BotPetDefault, rights: unknown) {
  await db.transaction(async (tx) => {
    let revision: string | null = null;
    if (choice.appearance === "catalog") {
      if (rights !== "confirmed") throw new HttpError(400, "Confirm you have permission to show this artwork publicly on the sign-in page.");
      const [asset] = choice.catalogId ? await tx.select({ revision: petCatalog.revision }).from(petCatalog).where(and(eq(petCatalog.id, choice.catalogId), eq(petCatalog.status, "published"))).for("share") : [];
      if (!asset) throw new HttpError(400, "Choose a published catalog pet. This pet may have been unpublished.");
      revision = asset.revision;
    }
    const value: LoginPetSettings = { appearance: choice.appearance, catalogId: choice.catalogId, revision };
    await tx.insert(settings).values({ key: "loginPet", value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    await tx.insert(auditLog).values({ actorId, action: "settings.login_pet", target: choice.catalogId,
      details: revision ? { ...value, rights: "confirmed", audience: "public sign-in page" } : value });
  });
}
