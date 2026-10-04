import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { petV2Fixture } from "../fixtures/pet-v2";

const run = process.env.HERMES_BUNDLE_TEST === "1" ? describe : describe.skip;
run("Hermes installation mechanics with synthetic artwork", () => {
  let directory: string;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_hermes_bundle_test") throw new Error("Dedicated disposable Hermes bundle database required");
    const { db, schema } = await import("@/db");
    expect(await db.select().from(schema.petCatalog)).toEqual([]);
    directory = await mkdtemp(path.join(tmpdir(), "hermes-install-test-"));
    await writeFile(path.join(directory, "pet.json"), await readFile("assets/pets/hermes/v2/pet.json"));
    await writeFile(path.join(directory, "spritesheet.webp"), await sharp(await petV2Fixture()).webp({ lossless: true }).toBuffer());
    await db.insert(schema.users).values({ id: "bundle-owner", upn: "bundle-owner", name: "Bundle test owner", isAdmin: true, identityRealm: "local", authSource: "local" });
    await db.insert(schema.bots).values(["follow", "custom", "off", "ember"].map((id) => ({ id: `bundle-${id}`, ownerId: "bundle-owner", name: id, visibility: "private" as const })));
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    if (directory) {
      await db.delete(schema.users).where(eq(schema.users.id, "bundle-owner"));
      await db.delete(schema.petCatalog).where(eq(schema.petCatalog.id, "builtin-hermes-v2"));
      await rm(directory, { recursive: true, force: true });
    }
    await pool.end();
  });
  it("inserts exactly once under concurrent startup and serves the published catalog sprite", async () => {
    const { HERMES_PET_ID, installHermesBundle, readHermesBundle } = await import("@/lib/pets/bundled-hermes");
    const c = await import("@/lib/pets/catalog");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const owner = (await loadPrincipal("bundle-owner"))!;
    expect((await Promise.all(Array.from({ length: 4 }, () => installHermesBundle(directory)))).filter(Boolean)).toHaveLength(1);
    const catalog = await c.listCatalog(owner);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ id: HERMES_PET_ID, status: "published", manifest: (await readHermesBundle(directory)).manifest });
    expect(await c.readCatalogSprite(owner, HERMES_PET_ID, catalog[0].revision)).toEqual((await readHermesBundle(directory)).sprite);
  });
  it("preserves selected defaults, custom imports, Off, motion, revisions, and admin unpublication", async () => {
    const { db, schema } = await import("@/db");
    const { HERMES_PET_ID, installHermesBundle } = await import("@/lib/pets/bundled-hermes");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { DEFAULT_PREFERENCES } = await import("@/lib/pets/shared");
    const s = await import("@/lib/pets/store"), c = await import("@/lib/pets/catalog");
    const owner = (await loadPrincipal("bundle-owner"))!;
    for (const id of ["follow", "custom", "off", "ember"]) await s.saveBotDefault(owner, `bundle-${id}`, { appearance: "catalog", catalogId: HERMES_PET_ID });
    const custom = { displayName: "User's private artwork", description: "Retain", credit: "User supplied", spriteVersionNumber: 2 as const };
    await s.replacePet(owner, "bundle-custom", custom, Buffer.from("private-test-bytes"));
    await s.savePet(owner, "bundle-off", { ...DEFAULT_PREFERENCES, mode: "off", motion: "still" });
    await s.savePet(owner, "bundle-ember", { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "ember", motion: "still" });
    expect(await s.readPet(owner, "bundle-follow")).toMatchObject({ enabled: true, appearance: "catalog", source: "default", custom: { displayName: "Hermes" } });
    expect(await s.readPet(owner, "bundle-custom")).toMatchObject({ source: "personal", custom });
    expect(await s.readPet(owner, "bundle-off")).toMatchObject({ enabled: false, preference: { mode: "off", motion: "still" } });
    expect(await s.readPet(owner, "bundle-ember")).toMatchObject({ source: "personal", appearance: "ember", motion: "still" });
    const snapshot = async () => ({ catalog: await db.select().from(schema.petCatalog), defaults: await db.select().from(schema.botPetDefaults), preferences: await db.select().from(schema.botPets) });
    const before = await snapshot();
    expect(await installHermesBundle(directory)).toBe(false);
    expect(await snapshot()).toEqual(before);
    await c.setCatalogStatus(owner, HERMES_PET_ID, "unpublished");
    const unpublished = await snapshot();
    expect(await installHermesBundle(path.join(directory, "nonexistent"))).toBe(false);
    expect(await snapshot()).toEqual(unpublished);
    expect(await s.readPet(owner, "bundle-follow")).toMatchObject({ enabled: false, botDefault: { catalogId: HERMES_PET_ID } });
    expect(await s.readPet(owner, "bundle-custom")).toMatchObject({ source: "personal", custom });
    await expect(c.deleteCatalogPet(owner, HERMES_PET_ID)).rejects.toThrow(/Built-in pets/);
  });
});
