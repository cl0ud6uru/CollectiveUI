import { readFile } from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { petCatalog } from "@/db/schema";
import { normalizePetSprite, parsePetManifest, validateV2Cells } from "./import";

export const BUNDLED_PETS = [
  { id: "builtin-hermes-v2", directory: "hermes/v2" },
  { id: "builtin-hermes-assimilated-v2", directory: "hermes-assimilated/v2" },
  { id: "builtin-the-queen-v2", directory: "the-queen/v2" },
] as const;

/** Trusted bundled files only; use the same manifest, raster, and cell checks as imports. */
export async function readBundledPet(directory: string) {
  const manifestBytes = await readFile(path.join(directory, "pet.json"));
  // Validate the bounded JSON before reading its optional embedded attribution.
  parsePetManifest(manifestBytes, "");
  const credit: unknown = JSON.parse(manifestBytes.toString("utf8")).credit;
  if (typeof credit !== "string" || !credit.trim()) throw new Error("Bundled pets must include an artwork credit.");
  const { spritesheetPath, ...manifest } = parsePetManifest(manifestBytes, credit);
  if (manifest.spriteVersionNumber !== 2) throw new Error("Bundled pets must use Codex Pet v2.");
  const sprite = await normalizePetSprite(await readFile(path.join(directory, spritesheetPath)), 2, spritesheetPath);
  await validateV2Cells(sprite);
  return { manifest, sprite };
}

/** Add missing catalog options; never rewrite art, publication state, or anyone's preferences. */
export async function installBundledPets(root = path.join(process.cwd(), "assets/pets")): Promise<string[]> {
  const existing = await db.select({ id: petCatalog.id }).from(petCatalog).where(inArray(petCatalog.id, BUNDLED_PETS.map(pet => pet.id)));
  const present = new Set(existing.map(pet => pet.id));
  const missing = BUNDLED_PETS.filter(pet => !present.has(pet.id));
  if (!missing.length) return [];
  const values = [];
  for (const pet of missing) {
    const { manifest, sprite } = await readBundledPet(path.join(root, pet.directory));
    values.push({ id: pet.id, manifest, sprite, status: "published" as const });
  }
  // Validate every missing file before the single atomic insert. Concurrent installers may win per ID.
  const inserted = await db.insert(petCatalog).values(values)
    .onConflictDoNothing({ target: petCatalog.id }).returning({ id: petCatalog.id });
  return inserted.map(pet => pet.id);
}
