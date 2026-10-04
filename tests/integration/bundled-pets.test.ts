import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.BUNDLED_PETS_TEST === "1" ? describe : describe.skip;
run("bundled pet installation with actual artwork", () => {
  let ready = false;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_bundled_pets_test") throw new Error("Dedicated disposable bundled pet database required");
    const { db, schema } = await import("@/db");
    await db.insert(schema.users).values({ id: "bundle-owner", upn: "bundle-owner", name: "Bundle test owner", isAdmin: true, identityRealm: "local", authSource: "local" });
    await db.insert(schema.bots).values(["follow", "custom", "off", "ember"].map((id) => ({ id: `bundle-${id}`, ownerId: "bundle-owner", name: id, visibility: "private" as const })));
    ready = true;
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    if (ready) await db.delete(schema.users).where(eq(schema.users.id, "bundle-owner"));
    await pool.end();
  });
  it("normal migrations install all three distinct published pets on a clean database", async () => {
    const { BUNDLED_PETS, readBundledPet } = await import("@/lib/pets/bundled");
    const c = await import("@/lib/pets/catalog");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const owner = (await loadPrincipal("bundle-owner"))!;
    const catalog = await c.listCatalog(owner);
    expect(catalog.map(pet => pet.id).sort()).toEqual(BUNDLED_PETS.map(pet => pet.id).sort());
    for (const pet of BUNDLED_PETS) {
      const loaded = await readBundledPet(`assets/pets/${pet.directory}`);
      const entry = catalog.find(entry => entry.id === pet.id)!;
      expect(entry).toMatchObject({ status: "published", manifest: loaded.manifest });
      expect((await c.readCatalogSprite(owner, pet.id, entry.revision)).equals(loaded.sprite)).toBe(true);
    }
  });
  it("inserts each missing pet exactly once under concurrent startup", async () => {
    const { db, schema } = await import("@/db");
    const { BUNDLED_PETS, installBundledPets } = await import("@/lib/pets/bundled");
    await db.delete(schema.petCatalog).where(inArray(schema.petCatalog.id, BUNDLED_PETS.map(pet => pet.id)));
    const inserted = (await Promise.all(Array.from({ length: 4 }, () => installBundledPets()))).flat();
    expect(inserted.sort()).toEqual(BUNDLED_PETS.map(pet => pet.id).sort());
  });
  it("adds missing entries without rewriting an existing unpublished pet or publishing unrelated drafts", async () => {
    const { db, schema } = await import("@/db");
    const { BUNDLED_PETS, installBundledPets } = await import("@/lib/pets/bundled");
    const [keep, ...missing] = BUNDLED_PETS;
    await db.update(schema.petCatalog).set({ status: "unpublished" }).where(eq(schema.petCatalog.id, keep.id));
    const [before] = await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, keep.id));
    await db.delete(schema.petCatalog).where(inArray(schema.petCatalog.id, missing.map(pet => pet.id)));
    const [draft] = await db.insert(schema.petCatalog).values({ id: "bundle-unrelated-draft", manifest: before.manifest, sprite: before.sprite }).returning();
    try {
      await expect(installBundledPets("/tmp/nonexistent-bundled-pets")).rejects.toThrow();
      expect((await db.select().from(schema.petCatalog)).map(pet => pet.id).sort()).toEqual([keep.id, draft.id].sort());
      expect((await installBundledPets()).sort()).toEqual(missing.map(pet => pet.id).sort());
      expect((await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, keep.id)))[0].revision).toBe(before.revision);
      expect((await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, keep.id)))[0].status).toBe("unpublished");
      expect((await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, draft.id)))[0].status).toBe("draft");
    } finally {
      await db.delete(schema.petCatalog).where(eq(schema.petCatalog.id, draft.id));
      await db.update(schema.petCatalog).set({ status: "published" }).where(eq(schema.petCatalog.id, keep.id));
    }
  });
  it("preserves defaults, custom imports, Off, motion, revisions, and admin unpublication", async () => {
    const { db, schema } = await import("@/db");
    const { BUNDLED_PETS, installBundledPets } = await import("@/lib/pets/bundled");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { DEFAULT_PREFERENCES } = await import("@/lib/pets/shared");
    const s = await import("@/lib/pets/store"), c = await import("@/lib/pets/catalog");
    const owner = (await loadPrincipal("bundle-owner"))!;
    const hermes = BUNDLED_PETS[0].id;
    for (const id of ["follow", "custom", "off", "ember"]) await s.saveBotDefault(owner, `bundle-${id}`, { appearance: "catalog", catalogId: hermes });
    const custom = { displayName: "User's private artwork", description: "Retain", credit: "User supplied", spriteVersionNumber: 2 as const };
    await s.replacePet(owner, "bundle-custom", custom, Buffer.from("private-test-bytes"));
    await s.savePet(owner, "bundle-off", { ...DEFAULT_PREFERENCES, mode: "off", motion: "still" });
    await s.savePet(owner, "bundle-ember", { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "ember", motion: "still" });
    for (const pet of BUNDLED_PETS) {
      await s.saveBotDefault(owner, "bundle-follow", { appearance: "catalog", catalogId: pet.id });
      expect(await s.readPet(owner, "bundle-follow")).toMatchObject({ enabled: true, appearance: "catalog", source: "default", botDefault: { catalogId: pet.id } });
    }
    expect(await s.readPet(owner, "bundle-custom")).toMatchObject({ source: "personal", custom });
    expect(await s.readPet(owner, "bundle-off")).toMatchObject({ enabled: false, preference: { mode: "off", motion: "still" } });
    expect(await s.readPet(owner, "bundle-ember")).toMatchObject({ source: "personal", appearance: "ember", motion: "still" });
    const snapshot = async () => ({ catalog: (await db.select().from(schema.petCatalog)).map(pet => ({ ...pet, sprite: pet.sprite.toString("base64") })), defaults: await db.select().from(schema.botPetDefaults), preferences: await db.select().from(schema.botPets) });
    const before = await snapshot();
    expect(await installBundledPets()).toEqual([]); expect(await snapshot()).toEqual(before);
    for (const pet of BUNDLED_PETS) await c.setCatalogStatus(owner, pet.id, "unpublished");
    const unpublished = await snapshot();
    expect(await installBundledPets("/tmp/nonexistent-bundled-pets")).toEqual([]); expect(await snapshot()).toEqual(unpublished);
    expect(await s.readPet(owner, "bundle-follow")).toMatchObject({ enabled: false });
    expect(await s.readPet(owner, "bundle-custom")).toMatchObject({ source: "personal", custom });
    for (const pet of BUNDLED_PETS) {
      await expect(c.deleteCatalogPet(owner, pet.id)).rejects.toThrow(/Built-in pets/);
      await c.setCatalogStatus(owner, pet.id, "published", "confirmed");
    }
  });
});
