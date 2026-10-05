import { eq, inArray } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.BUNDLED_PETS_TEST === "1" ? describe : describe.skip;
run("bundled pet installation with actual artwork", () => {
  let ready = false;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_bundled_pets_test") throw new Error("Dedicated disposable bundled pet database required");
    const { db, schema } = await import("@/db");
    await db.insert(schema.users).values({ id: "bundle-owner", upn: "bundle-owner", name: "Bundle test owner", isAdmin: true, identityRealm: "local", authSource: "local" });
    await db.insert(schema.bots).values(["follow", "custom", "off", "ember", "catalog"].map((id) => ({ id: `bundle-${id}`, ownerId: "bundle-owner", name: id, visibility: "private" as const })));
    ready = true;
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    if (ready) {
      await db.delete(schema.settings).where(eq(schema.settings.key, "loginPet"));
      await db.delete(schema.users).where(eq(schema.users.id, "bundle-owner"));
    }
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

  it("upgrades the known standing release once without changing selections, publication, private art, or public consent", async () => {
    const { db, schema } = await import("@/db");
    const { installBundledPets, readBundledPet } = await import("@/lib/pets/bundled");
    const { normalizePetSprite } = await import("@/lib/pets/import");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { DEFAULT_PREFERENCES } = await import("@/lib/pets/shared");
    const { readLoginPetSprite } = await import("@/lib/branding/login-pet");
    const s = await import("@/lib/pets/store");
    const owner = (await loadPrincipal("bundle-owner"))!;
    // Read only the actual former public artwork, pinned to its release commit. No network or generated substitute.
    const oldWebp = execFileSync("git", ["show", "a235f001722aa6923799fd9386c10f351c38a86b:assets/pets/hermes-assimilated/v2/spritesheet.webp"], { maxBuffer: 4 * 1024 * 1024 });
    const oldSprite = await normalizePetSprite(oldWebp, 2, "spritesheet.webp");
    expect(createHash("sha256").update(oldSprite).digest("hex")).toBe("55870bfe41ee25b78a99fc75edffcce39a37abaf4d748a681b14e729d4fa0690");
    const current = await readBundledPet("assets/pets/hermes-assimilated/v2");
    const id = "builtin-hermes-assimilated-v2";
    for (const bot of ["follow", "custom", "off", "ember", "catalog"]) await s.saveBotDefault(owner, `bundle-${bot}`, { appearance: "catalog", catalogId: id });
    await s.savePet(owner, "bundle-catalog", { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "catalog", catalogId: id, motion: "still" });
    await s.replacePet(owner, "bundle-custom", current.manifest, oldSprite);
    const row = async () => (await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, id)))[0];
    const spriteHash = (sprite: Buffer | null) => sprite && createHash("sha256").update(sprite).digest("hex");
    const comparable = (pet: Awaited<ReturnType<typeof row>>) => ({ ...pet, sprite: spriteHash(pet.sprite) });
    const otherCatalog = async () => (await db.select().from(schema.petCatalog)).filter(pet => pet.id !== id).map(pet => ({ ...pet, sprite: spriteHash(pet.sprite) }));
    const choices = async () => ({ defaults: await db.select().from(schema.botPetDefaults), preferences: (await db.select().from(schema.botPets)).map(pet => ({ ...pet, sprite: spriteHash(pet.sprite) })), login: await db.select().from(schema.settings).where(eq(schema.settings.key, "loginPet")) });
    for (const status of ["published", "unpublished"] as const) {
      await db.update(schema.petCatalog).set({ sprite: oldSprite, revision: `standing-${status}`, status }).where(eq(schema.petCatalog.id, id));
      const pin = { appearance: "catalog", catalogId: id, revision: `standing-${status}` };
      await db.insert(schema.settings).values({ key: "loginPet", value: pin }).onConflictDoUpdate({ target: schema.settings.key, set: { value: pin } });
      const before = await row(), savedChoices = await choices();
      const otherPets = await otherCatalog();
      await expect(installBundledPets("/tmp/nonexistent-bundled-pets")).rejects.toThrow();
      expect(comparable(await row())).toEqual(comparable(before));
      await Promise.all(Array.from({ length: 4 }, () => installBundledPets()));
      const after = await row();
      expect(after.sprite.equals(current.sprite)).toBe(true);
      expect(after.revision).not.toBe(before.revision);
      expect(comparable({ ...after, sprite: before.sprite, revision: before.revision, updatedAt: before.updatedAt })).toEqual(comparable(before));
      expect(await choices()).toEqual(savedChoices);
      expect(await otherCatalog()).toEqual(otherPets);
      expect((await s.readPetSprite(owner, "bundle-custom")).equals(oldSprite)).toBe(true);
      expect(await s.readPet(owner, "bundle-off")).toMatchObject({ enabled: false, preference: { mode: "off", motion: "still" } });
      // A new artwork revision never inherits public sign-in-page confirmation for the old pixels.
      expect(await readLoginPetSprite()).toBeNull();
      if (status === "published") {
        expect(await s.readPet(owner, "bundle-catalog")).toMatchObject({ source: "personal", revision: after.revision, preference: { motion: "still" } });
        expect((await s.readAvatarSprite(owner, "bundle-follow", after.revision)).equals(current.sprite)).toBe(true);
        await expect(s.readAvatarSprite(owner, "bundle-follow", before.revision)).rejects.toThrow();
      } else expect(await s.readPet(owner, "bundle-follow")).toMatchObject({ enabled: false });
      expect(await installBundledPets("/tmp/nonexistent-bundled-pets")).toEqual([]);
      expect(comparable(await row())).toEqual(comparable(after));
    }
    await db.update(schema.petCatalog).set({ status: "published" }).where(eq(schema.petCatalog.id, id));
  }, 30_000);

  it("preserves operator-replaced Assimilated artwork even under the bundled ID", async () => {
    const { db, schema } = await import("@/db");
    const { installBundledPets } = await import("@/lib/pets/bundled");
    const id = "builtin-hermes-assimilated-v2";
    const [original] = await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, id));
    await db.update(schema.petCatalog).set({ sprite: Buffer.from("operator-owned fixture"), revision: "operator-revision", status: "unpublished" }).where(eq(schema.petCatalog.id, id));
    try {
      const before = await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, id));
      expect(await installBundledPets("/tmp/nonexistent-bundled-pets")).toEqual([]);
      expect(await db.select().from(schema.petCatalog).where(eq(schema.petCatalog.id, id))).toEqual(before);
    } finally {
      await db.update(schema.petCatalog).set(original).where(eq(schema.petCatalog.id, id));
    }
  });
});
