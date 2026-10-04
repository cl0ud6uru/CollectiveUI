import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { petCatalog } from "@/db/schema";
import { normalizePetSprite, parsePetManifest, validateV2Cells } from "./import";

export const HERMES_PET_ID = "builtin-hermes-v2";
const defaultDirectory = () => path.join(process.cwd(), "assets/pets/hermes/v2");

/** Trusted bundled files only. No artwork is installed until startup explicitly calls the installer. */
export async function readHermesBundle(directory = defaultDirectory()) {
  const manifestBytes = await readFile(path.join(directory, "pet.json"));
  // Validate the bounded JSON before reading its optional embedded attribution.
  parsePetManifest(manifestBytes, "");
  const credit: unknown = JSON.parse(manifestBytes.toString("utf8")).credit;
  if (typeof credit !== "string" || !credit.trim()) throw new Error("Bundled Hermes must include an artwork credit.");
  const { spritesheetPath, ...manifest } = parsePetManifest(manifestBytes, credit);
  if (manifest.spriteVersionNumber !== 2) throw new Error("Bundled Hermes must use Codex Pet v2.");
  const sprite = await normalizePetSprite(await readFile(path.join(directory, spritesheetPath)), 2, spritesheetPath);
  await validateV2Cells(sprite);
  return { manifest, sprite };
}

/** Add a missing bundled catalog option; never rewrite art, publication state, or anyone's preferences. */
export async function installHermesBundle(directory = defaultDirectory()): Promise<boolean> {
  const [existing] = await db.select({ id: petCatalog.id }).from(petCatalog).where(eq(petCatalog.id, HERMES_PET_ID)).limit(1);
  if (existing) return false;
  const { manifest, sprite } = await readHermesBundle(directory);
  const inserted = await db.insert(petCatalog).values({ id: HERMES_PET_ID, manifest, sprite, status: "published" })
    .onConflictDoNothing({ target: petCatalog.id }).returning({ id: petCatalog.id });
  return inserted.length === 1;
}
