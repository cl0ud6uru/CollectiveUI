import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import { DEFAULT_PREFERENCES } from "@/lib/pets/shared";

const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/session", async () => {
  const { HttpError } = await import("@/lib/authz");
  return {
    errorResponse: (err: unknown) => err instanceof HttpError ? Response.json({ error: err.message }, { status: err.status }) : Response.json({ error: "Internal error" }, { status: 500 }),
    requireAdmin: async () => {
      if (!session.principal?.isAdmin) throw new HttpError(403, "Admin only");
      return session.principal;
    },
  };
});

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("admin catalog pet deletion (#40)", () => {
  let admin: Principal, owner: Principal, viewer: Principal;
  let sharedBot: string, privateBot: string;
  const users: string[] = [], assets: string[] = [];
  const manifest = { displayName: "Deletable fixture", description: "", spriteVersionNumber: 2 as const, credit: "Test · MIT" };
  const origin = new URL(process.env.AUTH_URL || "http://localhost").origin;
  const request = (id: string, body: unknown, headers: Record<string, string> = { origin }) =>
    new Request(`${origin}/api/admin/pets/${id}`, { method: "DELETE", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const callDelete = async (id: string, body: unknown, headers?: Record<string, string>) => {
    const { DELETE } = await import("@/app/api/admin/pets/[id]/route");
    return DELETE(request(id, body, headers), { params: Promise.resolve({ id }) } as never);
  };
  const draft = async (status: "draft" | "published" | "unpublished" = "unpublished") => {
    const c = await import("@/lib/pets/catalog");
    const pet = await c.createCatalogPet(admin, manifest, Buffer.from("deletable-pixels"), "confirmed"); assets.push(pet.id);
    if (status !== "draft") await c.setCatalogStatus(admin, pet.id, "published", "confirmed");
    if (status === "unpublished") await c.setCatalogStatus(admin, pet.id, "unpublished");
    return pet;
  };

  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { newId } = await import("@/lib/ids");
    const people: Principal[] = [];
    for (const isAdmin of [true, false, false]) {
      const id = `pet-delete-it-${newId()}`; users.push(id);
      await db.insert(schema.users).values({ id, upn: id, name: "Fixture", isAdmin, identityRealm: "local", authSource: "local" });
      people.push((await loadPrincipal(id))!);
    }
    [admin, owner, viewer] = people;
    const rows = await db.insert(schema.bots).values([
      { ownerId: owner.user.id, name: "Delete shared", visibility: "org" },
      { ownerId: viewer.user.id, name: "Delete private", visibility: "private" },
    ]).returning();
    [sharedBot, privateBot] = rows.map((r) => r.id);
  });
  afterAll(async () => {
    const { db, schema, pool } = await import("@/db");
    await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (assets.length) await db.delete(schema.petCatalog).where(inArray(schema.petCatalog.id, assets));
    await pool.end();
  });

  it("rejects non-admins, missing confirmation and foreign origins without changing anything", async () => {
    const c = await import("@/lib/pets/catalog"); const { db, schema } = await import("@/db");
    const pet = await draft();
    await expect(c.deleteCatalogPet(owner, pet.id)).rejects.toThrow(/Admin/);
    session.principal = owner;
    expect((await callDelete(pet.id, { confirm: pet.id })).status).toBe(403);
    session.principal = admin;
    expect((await callDelete(pet.id, { confirm: pet.id }, { origin: "https://evil.invalid" })).status).toBe(403);
    expect((await callDelete(pet.id, {})).status).toBe(400);
    expect((await callDelete(pet.id, { confirm: "another-pet" })).status).toBe(400);
    expect(await db.select({ id: schema.petCatalog.id }).from(schema.petCatalog).where(eq(schema.petCatalog.id, pet.id))).toHaveLength(1);
  });

  it("protects built-in pets and requires unpublishing first", async () => {
    const c = await import("@/lib/pets/catalog"); const { db, schema } = await import("@/db");
    const { isBundledPet } = await import("@/lib/pets/policy");
    const legacyId = `builtin-fixture-${admin.user.id}`; assets.push(legacyId);
    await db.insert(schema.petCatalog).values({ id: legacyId, manifest, sprite: Buffer.from("synthetic-legacy-pixels"), status: "unpublished" });
    expect(isBundledPet(legacyId)).toBe(true);
    const builtIn = (await c.listAdminCatalog(admin)).filter((pet) => pet.builtIn).map((pet) => pet.id);
    for (const id of builtIn) {
      await expect(c.deleteCatalogPet(admin, id)).rejects.toThrow(/Built-in pets/);
      expect(await db.select({ id: schema.petCatalog.id }).from(schema.petCatalog).where(eq(schema.petCatalog.id, id))).toHaveLength(1);
    }
    const published = await draft("published");
    await expect(c.deleteCatalogPet(admin, published.id)).rejects.toThrow(/Unpublish/);
    expect((await c.listAdminCatalog(admin)).find((pet) => pet.id === published.id)).toMatchObject({ status: "published", builtIn: false });
  });

  it("deletes an unused draft and reports an already-deleted pet", async () => {
    const c = await import("@/lib/pets/catalog");
    session.principal = admin;
    const pet = await draft("draft");
    const response = await callDelete(pet.id, { confirm: pet.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: pet.id, displayName: manifest.displayName, defaultsReset: 0, selectionsReset: 0 });
    const again = await callDelete(pet.id, { confirm: pet.id });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "This pet was already deleted." });
    expect((await c.listAdminCatalog(admin)).some((p) => p.id === pet.id)).toBe(false);
  });

  it("resets assigned defaults and personal selections to valid fallbacks, then audits", async () => {
    const c = await import("@/lib/pets/catalog"); const s = await import("@/lib/pets/store"); const { db, schema } = await import("@/db");
    const pet = await draft("published");
    await s.saveBotDefault(admin, sharedBot, { appearance: "catalog", catalogId: pet.id });
    await s.saveBotDefault(admin, privateBot, { appearance: "ember", catalogId: null });
    await s.savePet(viewer, privateBot, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "catalog", catalogId: pet.id });
    await c.setCatalogStatus(admin, pet.id, "unpublished");
    // Unpublished: everyone already sees the fallback, and the references are still there.
    const before = { shared: await s.readPet(viewer, sharedBot), personal: await s.readPet(viewer, privateBot) };
    expect(before.shared).toMatchObject({ enabled: false, botDefault: { catalogId: pet.id } });
    expect(before.personal).toMatchObject({ enabled: true, appearance: "ember", source: "default", preference: { mode: "personal", catalogId: pet.id } });

    expect(await c.deleteCatalogPet(admin, pet.id)).toEqual({ id: pet.id, displayName: manifest.displayName, defaultsReset: 1, selectionsReset: 1 });
    const after = { shared: await s.readPet(viewer, sharedBot), personal: await s.readPet(viewer, privateBot) };
    // What people see is unchanged; the stored choices are now valid without the deleted artwork.
    expect(after.shared).toMatchObject({ enabled: before.shared.enabled, botDefault: { appearance: "off", catalogId: null } });
    expect(after.personal).toMatchObject({ enabled: true, appearance: "ember", source: "default", preference: { mode: "follow", appearance: "moss", catalogId: null } });
    expect(await db.select().from(schema.botPets).where(and(eq(schema.botPets.userId, viewer.user.id), eq(schema.botPets.botId, privateBot)))).toMatchObject([{ enabled: false, mode: "follow" }]);
    await expect(c.readCatalogSprite(admin, pet.id, null)).rejects.toThrow(/not found/);
    const [event] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.target, pet.id), eq(schema.auditLog.action, "pet.catalog_deleted")));
    expect(event).toMatchObject({ actorId: admin.user.id, details: { displayName: manifest.displayName, status: "unpublished", defaultsReset: 1, selectionsReset: 1 } });
  });

  it("rolls back when the admin's access changed before the delete", async () => {
    const c = await import("@/lib/pets/catalog"); const { db, schema } = await import("@/db");
    const pet = await draft();
    await db.update(schema.users).set({ sessionVersion: admin.user.sessionVersion + 1 }).where(eq(schema.users.id, admin.user.id));
    try {
      await expect(c.deleteCatalogPet(admin, pet.id)).rejects.toThrow(/Admin/);
      expect(await db.select({ id: schema.petCatalog.id }).from(schema.petCatalog).where(eq(schema.petCatalog.id, pet.id))).toHaveLength(1);
    } finally {
      await db.update(schema.users).set({ sessionVersion: admin.user.sessionVersion }).where(eq(schema.users.id, admin.user.id));
    }
  });

  it("counts inactive references and preserves Off and private artwork when clearing them", async () => {
    const c = await import("@/lib/pets/catalog"); const s = await import("@/lib/pets/store"); const { db, schema } = await import("@/db");
    const pet = await draft("published");
    const [dormant] = await db.insert(schema.bots).values({ ownerId: owner.user.id, name: "Inactive selection", visibility: "private" }).returning();
    const imported = await s.replacePet(viewer, privateBot, { ...manifest, displayName: "Keep private" }, Buffer.from("private pixels"));
    const selected = { ...DEFAULT_PREFERENCES, mode: "personal" as const, appearance: "catalog" as const, catalogId: pet.id };
    await s.savePet(viewer, privateBot, selected);
    await s.savePet(viewer, privateBot, { ...selected, mode: "off" });
    await s.savePet(owner, dormant.id, selected);
    await db.update(schema.bots).set({ visibility: "org" }).where(eq(schema.bots.id, dormant.id));
    await c.setCatalogStatus(admin, pet.id, "unpublished");
    expect((await c.listAdminCatalog(admin)).find(p => p.id === pet.id)).toMatchObject({ personalCount: 0, preferenceCount: 2 });
    expect(await c.deleteCatalogPet(admin, pet.id)).toMatchObject({ defaultsReset: 0, selectionsReset: 2 });
    expect(await s.readPet(viewer, privateBot)).toMatchObject({ enabled: false, preference: { mode: "off", catalogId: null }, privateImport: { revision: imported.revision } });
    expect((await s.readPetSprite(viewer, privateBot)).toString()).toBe("private pixels");
    expect(await s.readPet(owner, dormant.id)).toMatchObject({ preference: { mode: "follow", catalogId: null } });
  });

  it("serializes duplicate deletes and records exactly one deletion audit", async () => {
    const c = await import("@/lib/pets/catalog"); const { db, schema } = await import("@/db");
    const pet = await draft("draft");
    const results = await Promise.allSettled([c.deleteCatalogPet(admin, pet.id), c.deleteCatalogPet(admin, pet.id)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 404 } });
    expect(await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.target, pet.id), eq(schema.auditLog.action, "pet.catalog_deleted")))).toHaveLength(1);
  });

  it("rechecks publication after waiting for the catalog row lock", async () => {
    const c = await import("@/lib/pets/catalog"); const { pool } = await import("@/db");
    const pet = await draft("draft"); const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pet_catalog SET status='published' WHERE id=$1", [pet.id]);
      const blocker = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const denied = expect(c.deleteCatalogPet(admin, pet.id)).rejects.toMatchObject({ status: 409 });
      await expect.poll(async () => (await pool.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [blocker])).rowCount).toBe(1);
      await client.query("COMMIT"); await denied;
      expect((await c.listAdminCatalog(admin)).find(p => p.id === pet.id)?.status).toBe("published");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it.each(["session", "admin"] as const)("rechecks %s revocation after waiting for the deletion lock", async kind => {
    const c = await import("@/lib/pets/catalog"); const { pool, db, schema } = await import("@/db");
    const pet = await draft("draft"); const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT id FROM pet_catalog WHERE id=$1 FOR UPDATE", [pet.id]);
      const blocker = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const denied = expect(c.deleteCatalogPet(admin, pet.id)).rejects.toMatchObject({ status: 403 });
      await expect.poll(async () => (await pool.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [blocker])).rowCount).toBe(1);
      if (kind === "session") await client.query("UPDATE users SET session_version=session_version+1 WHERE id=$1", [admin.user.id]);
      else await client.query("UPDATE users SET is_admin=false WHERE id=$1", [admin.user.id]);
      await client.query("COMMIT"); await denied;
      expect(await db.select({ id: schema.petCatalog.id }).from(schema.petCatalog).where(eq(schema.petCatalog.id, pet.id))).toHaveLength(1);
      expect(await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.target, pet.id), eq(schema.auditLog.action, "pet.catalog_deleted")))).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK"); client.release();
      await db.update(schema.users).set({ sessionVersion: admin.user.sessionVersion, isAdmin: true }).where(eq(schema.users.id, admin.user.id));
    }
  });
});
