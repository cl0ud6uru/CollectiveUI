import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import { DEFAULT_PREFERENCES } from "@/lib/pets/shared";
import { petV2Fixture } from "../fixtures/pet-v2";
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("shared catalog and private avatar boundaries", () => {
  let admin: Principal, owner: Principal, outsider: Principal;
  let shared: string, restricted: string, service: string, personalBot: string;
  const users: string[] = [], assets: string[] = [];
  const manifest = { displayName: "Synthetic catalog fixture", description: "", spriteVersionNumber: 1 as const, credit: "Test · MIT" };
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { newId } = await import("@/lib/ids");
    const people: Principal[] = [];
    for (const isAdmin of [true, false, false]) {
      const id = `catalog-it-${newId()}`; users.push(id);
      await db.insert(schema.users).values({ id, upn: id, name: "Fixture", isAdmin, identityRealm: "local", authSource: "local" });
      people.push((await loadPrincipal(id))!);
    }
    [admin, owner, outsider] = people;
    const rows = await db.insert(schema.bots).values([
      { ownerId: owner.user.id, name: "Catalog shared", visibility: "org" },
      { ownerId: owner.user.id, name: "Catalog restricted", visibility: "private" },
      { ownerId: owner.user.id, name: "Catalog service", visibility: "org", executionMode: "service", revision: 7, publishedRevision: 7, publishedConfigHash: "preserved-config" },
    ]).returning();
    [shared, restricted, service] = rows.map((r) => r.id);
    const [personal] = await db.insert(schema.bots).values({ ownerId: outsider.user.id, name: "Private catalog preferences", visibility: "private" }).returning();
    personalBot = personal.id;
  });
  afterAll(async () => {
    const { db, schema, pool } = await import("@/db");
    await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (assets.length) await db.delete(schema.petCatalog).where(inArray(schema.petCatalog.id, assets));
    await pool.end();
  });
  it("requires admin publication and owner/admin defaults; shared identity never uses private rows", async () => {
    const c = await import("@/lib/pets/catalog"); const s = await import("@/lib/pets/store");
    const { db, schema } = await import("@/db");
    await db.update(schema.bots).set({ visibility: "private" }).where(eq(schema.bots.id, shared));
    const own = await s.replacePet(owner, shared, { ...manifest, displayName: "Owner secret import" }, Buffer.from("private-owner-pixels"));
    await db.update(schema.bots).set({ visibility: "org" }).where(eq(schema.bots.id, shared));
    await expect(c.copyOwnImport(admin, shared, own.revision!, "confirmed")).rejects.toThrow(/own imported/);
    await expect(c.createCatalogPet(owner, manifest, Buffer.from("pixels"), "confirmed")).rejects.toThrow(/Admin/);
    await s.saveBotDefault(owner, shared, { appearance: "moss", catalogId: null });
    await expect(s.saveBotDefault(outsider, shared, { appearance: "moss", catalogId: null })).rejects.toThrow(/editor|owner|admin/i);
    const draft = await c.createCatalogPet(admin, manifest, Buffer.from("catalog-pixels"), "confirmed"); assets.push(draft.id);
    expect((await c.listCatalog(owner)).some((p) => p.id === draft.id)).toBe(false);
    await expect(c.readCatalogSprite(owner, draft.id, draft.revision)).rejects.toThrow(/not found/);
    expect((await c.readCatalogSprite(admin, draft.id, draft.revision)).toString()).toBe("catalog-pixels");
    await expect(s.saveBotDefault(admin, shared, { appearance: "catalog", catalogId: draft.id })).rejects.toThrow(/published/);
    await c.setCatalogStatus(admin, draft.id, "published", "confirmed");
    await s.saveBotDefault(admin, shared, { appearance: "catalog", catalogId: draft.id });
    const inherited = await s.readPet(outsider, shared);
    expect(inherited).toMatchObject({ enabled: true, source: "default", custom: manifest, preference: DEFAULT_PREFERENCES, privateImport: null });
    expect((await s.readAvatarSprite(outsider, shared, draft.revision)).toString()).toBe("catalog-pixels");
    expect((await s.readPet(owner, shared)).custom).toEqual(manifest);
    expect((await s.readPet(owner, shared)).privateImport?.manifest.displayName).toBe("Owner secret import");
    await expect(s.readPetSprite(admin, shared)).rejects.toThrow(/not found/);
    await expect(s.readPetSprite(outsider, shared)).rejects.toThrow(/not found/);
    await expect(s.readAvatarSprite(outsider, shared, own.revision)).rejects.toThrow(/not found/);
  });
  it("persists personal/off/reset choices; unpublish falls back without deleting references", async () => {
    const c = await import("@/lib/pets/catalog"); const s = await import("@/lib/pets/store"); const id = assets[0];
    await s.saveBotDefault(admin, shared, { appearance: "ember", catalogId: null });
    await s.saveBotDefault(admin, personalBot, { appearance: "catalog", catalogId: id });
    await s.savePet(outsider, personalBot, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "ember" });
    expect(await s.readPet(outsider, personalBot)).toMatchObject({ appearance: "ember", source: "personal" });
    await s.savePet(outsider, personalBot, { ...DEFAULT_PREFERENCES, mode: "off" });
    expect(await s.readPet(outsider, personalBot)).toMatchObject({ enabled: false, preference: { mode: "off" } });
    await s.savePet(outsider, personalBot, DEFAULT_PREFERENCES);
    expect(await s.readPet(outsider, personalBot)).toMatchObject({ enabled: true, source: "default" });
    const revision = (await s.readPet(outsider, personalBot)).revision;
    await c.setCatalogStatus(admin, id, "unpublished");
    expect(await s.readPet(outsider, personalBot)).toMatchObject({ enabled: false, botDefault: { catalogId: id } });
    await expect(c.readCatalogSprite(outsider, id, revision)).rejects.toThrow(/not found/);
    await expect(s.readAvatarSprite(outsider, personalBot, revision)).rejects.toThrow(/not found/);
    await expect(s.savePet(outsider, personalBot, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "catalog", catalogId: id })).rejects.toThrow(/published/);
    await c.setCatalogStatus(admin, id, "published", "confirmed");
    await s.savePet(outsider, personalBot, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "catalog", catalogId: id });
    await s.saveBotDefault(admin, personalBot, { appearance: "ember", catalogId: null });
    expect((await c.listAdminCatalog(admin)).find((pet) => pet.id === id)).toMatchObject({ defaultCount: 0, personalCount: 1 });
    await c.setCatalogStatus(admin, id, "unpublished");
    expect(await s.readPet(outsider, personalBot)).toMatchObject({ enabled: true, appearance: "ember", source: "default", preference: { mode: "personal", catalogId: id } });
    await c.setCatalogStatus(admin, id, "published", "confirmed");
    expect(await s.readPet(outsider, personalBot)).toMatchObject({ appearance: "catalog", source: "personal" });
    const { db, schema } = await import("@/db");
    await expect(db.delete(schema.petCatalog).where(eq(schema.petCatalog.id, id))).rejects.toThrow();
  });
  it("requires and audits an explicit sharing affirmation; unpublish records no new affirmation", async () => {
    const c = await import("@/lib/pets/catalog"); const { db, schema } = await import("@/db");
    const id = assets[0];
    await expect(c.setCatalogStatus(admin, id, "published")).rejects.toThrow(/permission/);
    await c.setCatalogStatus(admin, id, "published", "confirmed");
    await c.setCatalogStatus(admin, id, "unpublished");
    const events = await db.select().from(schema.auditLog).where(eq(schema.auditLog.target, id));
    const published = events.filter((e) => e.action === "pet.catalog_published");
    expect(published.length).toBeGreaterThan(0);
    for (const event of published) {
      expect(event.actorId).toBe(admin.user.id); expect(event.createdAt).toBeInstanceOf(Date);
      expect(event.details).toMatchObject({ rights: "confirmed", affirmationVersion: 1, audience: "signed-in users" });
    }
    expect(events.filter((e) => e.action === "pet.catalog_unpublished").every((e) => e.details === null)).toBe(true);
    await c.setCatalogStatus(admin, id, "published", "confirmed");
  });
  it("serves exactly the resolved avatar in one lookup after access checks, including unavailable selections", async () => {
    const c = await import("@/lib/pets/catalog"); const s = await import("@/lib/pets/store");
    const { pool } = await import("@/db");
    const personal = await c.createCatalogPet(admin, manifest, Buffer.from("personal-catalog"), "confirmed"); assets.push(personal.id);
    const own = await s.replacePet(outsider, personalBot, manifest, Buffer.from("private-outsider"));
    const sharedAsset = (await c.listCatalog(admin)).find((asset) => asset.id === assets[0])!;
    const expectedBytes = new Map([[own.revision, "private-outsider"], [personal.revision, "personal-catalog"], [sharedAsset.revision, "catalog-pixels"]]);
    for (const defaultChoice of [{ appearance: "catalog" as const, catalogId: sharedAsset.id }, { appearance: "moss" as const, catalogId: null }, { appearance: "off" as const, catalogId: null }]) {
      await s.saveBotDefault(admin, personalBot, defaultChoice);
      for (const pref of [DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, mode: "off" as const }, ...(["moss", "custom", "catalog"] as const).map((appearance) => ({ ...DEFAULT_PREFERENCES, mode: "personal" as const, appearance, catalogId: appearance === "catalog" ? personal.id : null }))]) {
        await c.setCatalogStatus(admin, personal.id, "published", "confirmed");
        await s.savePet(outsider, personalBot, pref);
        for (const status of ["published", "unpublished"] as const) {
          await c.setCatalogStatus(admin, personal.id, status, status === "published" ? "confirmed" : undefined);
          const view = await s.readPet(outsider, personalBot);
          if (view.enabled && view.revision) {
            const queries = vi.spyOn(pool, "query");
            try {
              expect((await s.readAvatarSprite(outsider, personalBot, view.revision)).toString()).toBe(expectedBytes.get(view.revision));
              expect(queries).toHaveBeenCalledTimes(2); // caller-mode bot access + one effective image lookup
            } finally { queries.mockRestore(); }
          } else await expect(s.readAvatarSprite(outsider, personalBot, sharedAsset.revision)).rejects.toThrow(/not found/);
          for (const revision of expectedBytes.keys()) if (revision !== view.revision) await expect(s.readAvatarSprite(outsider, personalBot, revision)).rejects.toThrow(/not found/);
        }
      }
    }
    await s.savePet(outsider, personalBot, DEFAULT_PREFERENCES);
  });
  it("copies only the admin's own selected import to a draft, retains bytes and credit privately", async () => {
    const c = await import("@/lib/pets/catalog"); const s = await import("@/lib/pets/store");
    const legacy = await s.replacePet(admin, restricted, manifest, Buffer.from("admin-private"));
    await expect(c.copyOwnImport(admin, restricted, legacy.revision!, "confirmed")).rejects.toThrow(/Legacy v1/);
    const v2 = { ...manifest, spriteVersionNumber: 2 as const }, unchecked = await s.replacePet(admin, restricted, v2, Buffer.from("unvalidated-v2"));
    await expect(c.copyOwnImport(admin, restricted, unchecked.revision!, "confirmed")).rejects.toThrow(/undamaged/);
    const pixels = await petV2Fixture(), own = await s.replacePet(admin, restricted, v2, pixels);
    const draft = await c.copyOwnImport(admin, restricted, own.revision!, "confirmed"); assets.push(draft.id);
    expect(draft).toMatchObject({ manifest: v2, status: "draft" });
    expect(await s.readPetSprite(admin, restricted)).toEqual(pixels);
    await expect(c.copyOwnImport(admin, restricted, "stale", "confirmed")).rejects.toThrow();
    await s.savePet(admin, restricted, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "moss" });
    await expect(c.copyOwnImport(admin, restricted, own.revision!, "confirmed")).rejects.toThrow();
  });
  it("rejects a stale group-admin principal even when the demoted user owns the caller bot", async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { saveBotDefault } = await import("@/lib/pets/store");
    const id = `demoted-${newId()}`.toLowerCase(); users.push(id);
    await db.insert(schema.users).values({ id, upn: id, name: "Former group admin", authSource: "ldap" });
    const [group] = await db.insert(schema.groups).values({ name: id, isAdmin: true }).returning();
    try {
      await db.insert(schema.groupMappings).values({ groupId: group.id, source: "ldap", externalId: id });
      await db.insert(schema.userExternalGroups).values({ userId: id, source: "ldap", externalId: id });
      const [bot] = await db.insert(schema.bots).values({ ownerId: id, name: id }).returning();
      const stale = (await loadPrincipal(id))!; expect(stale.isAdmin).toBe(true);
      await db.delete(schema.groupMappings).where(eq(schema.groupMappings.groupId, group.id));
      const current = (await loadPrincipal(id))!;
      expect(current.isAdmin).toBe(false); expect(current.user.sessionVersion).toBe(stale.user.sessionVersion);
      await expect(saveBotDefault(stale, bot.id, { appearance: "moss", catalogId: null })).rejects.toThrow(/admin/i);
      const c = await import("@/lib/pets/catalog");
      await expect(c.createCatalogPet(stale, manifest, Buffer.from("forbidden"), "confirmed")).rejects.toThrow(/Admin/);
      await expect(c.setCatalogStatus(stale, assets[0], "unpublished")).rejects.toThrow(/Admin/);
      expect((await c.listCatalog(owner)).some((p) => p.id === assets[0])).toBe(true);
    } finally { await db.delete(schema.groups).where(eq(schema.groups.id, group.id)); }
  });
  it("enforces private/disabled bot visibility and retains service grant revisions", async () => {
    const s = await import("@/lib/pets/store"); const { db, schema } = await import("@/db");
    await s.saveBotDefault(admin, restricted, { appearance: "catalog", catalogId: assets[0] });
    await expect(s.readPet(outsider, restricted)).rejects.toThrow(/access/);
    await expect(s.readAvatarSprite(outsider, restricted, "any")).rejects.toThrow(/access/);
    await s.saveBotDefault(admin, service, { appearance: "moss", catalogId: null });
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, service));
    expect(bot).toMatchObject({ revision: 7, publishedRevision: 7, publishedConfigHash: "preserved-config" });
    await expect(s.saveBotDefault(owner, service, { appearance: "ember", catalogId: null })).rejects.toThrow(/editor|admin/i);
    await db.update(schema.bots).set({ enabled: false }).where(eq(schema.bots.id, shared));
    await expect(s.readPet(outsider, shared)).rejects.toThrow(/disabled/);
    await expect(s.readAvatarSprite(outsider, shared, "any")).rejects.toThrow(/disabled/);
    expect((await s.readAccessiblePets(outsider))[shared]).toBeUndefined();
  });
});
