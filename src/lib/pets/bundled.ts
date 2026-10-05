import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { petCatalog } from "@/db/schema";
import { newId } from "@/lib/ids";
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

// Exact normalized PNG installed by the original public Assimilated bundle (PR #20).
// Only this known release is eligible; operator replacements and private imports are never touched.
const assimilatedId = "builtin-hermes-assimilated-v2";
const standingSpriteSha256 = "55870bfe41ee25b78a99fc75edffcce39a37abaf4d748a681b14e729d4fa0690";
const standingArtwork = () => and(eq(petCatalog.id, assimilatedId),
  sql`sha256(${petCatalog.sprite}) = decode(${standingSpriteSha256}, 'hex')`);

/** Add missing options and upgrade the known standing Assimilated art, preserving all saved choices. */
export async function installBundledPets(root = path.join(process.cwd(), "assets/pets")): Promise<string[]> {
  const existing = await db.select({ id: petCatalog.id }).from(petCatalog).where(inArray(petCatalog.id, BUNDLED_PETS.map(pet => pet.id)));
  const present = new Set(existing.map(pet => pet.id));
  const missing = BUNDLED_PETS.filter(pet => !present.has(pet.id));
  const [standing] = present.has(assimilatedId)
    ? await db.select({ revision: petCatalog.revision }).from(petCatalog).where(standingArtwork()) : [];
  if (!missing.length && !standing) return [];
  const values: (typeof petCatalog.$inferInsert)[] = [];
  for (const pet of missing) {
    const { manifest, sprite } = await readBundledPet(path.join(root, pet.directory));
    values.push({ id: pet.id, manifest, sprite, status: "published" as const });
  }
  const replacement = standing ? await readBundledPet(path.join(root, "hermes-assimilated/v2")) : null;
  if (replacement && createHash("sha256").update(replacement.sprite).digest("hex") === standingSpriteSha256) {
    throw new Error("The Assimilated framing update still contains the old standing artwork.");
  }
  // Validate all files before writing. Row predicates are rechecked under the UPDATE lock, so concurrent
  // startup upgrades once and never overwrites a different revision or an operator's replacement artwork.
  return db.transaction(async (tx) => {
    const inserted = values.length ? await tx.insert(petCatalog).values(values)
      .onConflictDoNothing({ target: petCatalog.id }).returning({ id: petCatalog.id }) : [];
    if (standing && replacement) {
      await tx.update(petCatalog).set({ sprite: replacement.sprite, revision: newId(), updatedAt: new Date() })
        .where(and(standingArtwork(), eq(petCatalog.revision, standing.revision)));
    }
    // The return value continues to report newly installed IDs only.
    return inserted.map(pet => pet.id);
  });
}
