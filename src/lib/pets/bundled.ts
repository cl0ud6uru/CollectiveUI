import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { petCatalog } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertHdMatches, normalizePetSprite, normalizePetSpriteHd, parsePetManifest, validateV2Cells } from "./import";
import { PET_HD_SCALE } from "./shared";

/** CollectiveUI's optional 2× rendition, beside a bundle's v2 files. pet.json never lists it. */
export const HD_SPRITE_FILE = "spritesheet@2x.webp";

export type BundledPet = {
  id: string; directory: string;
  /** SHA-256 of the current bundle's normalized v2 PNG, and whether it ships HD_SPRITE_FILE. Tests keep both in step. */
  sprite: string; hd: boolean;
  /** Normalized PNGs installed by earlier official releases. Only these are replaced by the current bundle. */
  releases: readonly string[];
};

export const BUNDLED_PETS: readonly BundledPet[] = [
  { id: "builtin-hermes-v2", directory: "hermes/v2", sprite: "463cdc0373ec42230377078608e2f5cc113ac2122a737f9940e9cadaebf19b75", hd: false, releases: [] },
  { id: "builtin-hermes-assimilated-v2", directory: "hermes-assimilated/v2", sprite: "43de18724a61ed6ce549d42f3ef758b02c708613fd34b59e502447b45a60b3e6", hd: false,
    // The standing raster installed by the original public bundle (PR #20).
    releases: ["55870bfe41ee25b78a99fc75edffcce39a37abaf4d748a681b14e729d4fa0690"] },
  { id: "builtin-the-queen-v2", directory: "the-queen/v2", sprite: "fed57f8824f9e4a93064ab9e60996637867a583b2e3b83d3a175460560ac7487", hd: false, releases: [] },
];

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

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
  const hdBytes = await readFile(path.join(directory, HD_SPRITE_FILE)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const spriteHd = hdBytes && await normalizePetSpriteHd(hdBytes);
  if (spriteHd) {
    await validateV2Cells(spriteHd, PET_HD_SCALE);
    await assertHdMatches(sprite, spriteHd);
  }
  return { manifest, sprite, spriteHd };
}

/** Reads a bundle only when it is needed, and refuses files that no longer match BUNDLED_PETS. */
async function readExpected(root: string, pet: BundledPet) {
  const bundle = await readBundledPet(path.join(root, pet.directory));
  if (sha256(bundle.sprite) !== pet.sprite || !!bundle.spriteHd !== pet.hd) {
    throw new Error(`The ${pet.directory} files changed. Update its sprite hash and hd flag in BUNDLED_PETS, and list the previous hash under releases.`);
  }
  return bundle;
}

/**
 * Add missing options, and bring official artwork up to the current bundle, preserving all saved choices: an earlier
 * official release is replaced, and the current release gains a newly shipped HD rendition. Operator-replaced artwork
 * under a bundled ID never matches and is never touched.
 */
export async function installBundledPets(root = path.join(process.cwd(), "assets/pets"), pets = BUNDLED_PETS): Promise<string[]> {
  const existing = await db.select({ id: petCatalog.id, revision: petCatalog.revision, hd: sql<boolean>`${petCatalog.spriteHd} is not null`,
    sprite: sql<string>`encode(sha256(${petCatalog.sprite}), 'hex')` }).from(petCatalog).where(inArray(petCatalog.id, pets.map(pet => pet.id)));
  const rows = new Map(existing.map(row => [row.id, row]));
  const missing = pets.filter(pet => !rows.has(pet.id));
  const upgrades = pets.flatMap(pet => {
    const row = rows.get(pet.id);
    return row && (pet.releases.includes(row.sprite) || (row.sprite === pet.sprite && pet.hd && !row.hd)) ? [{ pet, row }] : [];
  });
  if (!missing.length && !upgrades.length) return [];
  // Validate every needed bundle before writing.
  const values: (typeof petCatalog.$inferInsert)[] = [];
  for (const pet of missing) {
    const { manifest, sprite, spriteHd } = await readExpected(root, pet);
    values.push({ id: pet.id, manifest, sprite, spriteHd, status: "published" as const });
  }
  const replacements = await Promise.all(upgrades.map(async (upgrade) => ({ ...upgrade, bundle: await readExpected(root, upgrade.pet) })));
  // Row predicates are rechecked under the UPDATE lock, so a concurrent startup upgrades once and never overwrites a
  // different revision or an operator's replacement artwork. A new revision never inherits public sign-in consent.
  return db.transaction(async (tx) => {
    const inserted = values.length ? await tx.insert(petCatalog).values(values)
      .onConflictDoNothing({ target: petCatalog.id }).returning({ id: petCatalog.id }) : [];
    for (const { pet, row, bundle } of replacements) {
      await tx.update(petCatalog).set({ sprite: bundle.sprite, spriteHd: bundle.spriteHd, revision: newId(), updatedAt: new Date() })
        .where(and(eq(petCatalog.id, pet.id), eq(petCatalog.revision, row.revision),
          sql`sha256(${petCatalog.sprite}) = decode(${row.sprite}, 'hex')`));
    }
    // The return value continues to report newly installed IDs only.
    return inserted.map(pet => pet.id);
  });
}
