import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import { DEFAULT_PREFERENCES } from "@/lib/pets/shared";
const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal! }));
vi.mock("@/lib/jobs", () => ({ enqueue: vi.fn(), QUEUES: {}, enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn() }));
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("shared pet identity and creation boundaries on synthetic data", () => {
  let admin: Principal, owner: Principal, viewer: Principal, appId: string, groupId: string, botId: string, catalogId: string;
  const userIds: string[] = [];
  const manifest = { displayName: "Identity fixture", description: "Synthetic pixels", spriteVersionNumber: 2 as const, credit: "Test · MIT" };
  beforeAll(async () => {
    const { db, schema: s } = await import("@/db"); const { loadPrincipal } = await import("@/lib/auth/groups");
    const { newId } = await import("@/lib/ids"); const id = newId();
    const people = await db.insert(s.users).values([true, false, false].map((isAdmin, i) => ({ upn: `pet-identity-${id}-${i}@fixture.invalid`, name: `Pet identity ${i}`, isAdmin, authSource: "ldap" as const }))).returning();
    userIds.push(...people.map(p => p.id));
    const [group] = await db.insert(s.groups).values({ name: `Pet identity ${id}`, canCreateBots: true }).returning(); groupId = group.id;
    await db.insert(s.groupMappings).values({ groupId, source: "ldap", externalId: id.toLowerCase() });
    await db.insert(s.userExternalGroups).values(people.slice(1).map(p => ({ userId: p.id, source: "ldap" as const, externalId: id.toLowerCase() })));
    [admin, owner, viewer] = await Promise.all(people.map(async p => (await loadPrincipal(p.id))!));
    const [app] = await db.insert(s.aiApps).values({ name: `Pet model ${id}`, provider: "openai-compatible", model: "synthetic", baseUrl: "https://unused.invalid", supportsTools: true, isPublic: true }).returning(); appId = app.id;
    const [bot] = await db.insert(s.bots).values({ ownerId: owner.user.id, name: `Pet transitions ${id}`, appId, visibility: "private" }).returning(); botId = bot.id;
    const c = await import("@/lib/pets/catalog"); const asset = await c.createCatalogPet(admin, manifest, Buffer.from("shared-pixels"), "confirmed"); catalogId = asset.id;
    await c.setCatalogStatus(admin, catalogId, "published", "confirmed");
  });
  afterAll(async () => {
    const { db, schema: s, pool } = await import("@/db");
    await db.delete(s.users).where(inArray(s.users.id, userIds));
    if (catalogId) await db.delete(s.petCatalog).where(eq(s.petCatalog.id, catalogId));
    if (groupId) await db.delete(s.groups).where(eq(s.groups.id, groupId));
    if (appId) await db.delete(s.aiApps).where(eq(s.aiApps.id, appId));
    await pool.end();
  });
  const input = (visibility: "private" | "org" | "groups" = "private") => ({ name: `Created pet ${visibility}`, appId, visibility, groupIds: visibility === "groups" ? [groupId] : [], tools: [], delegateIds: [], starters: [], maxSteps: 10 });
  it("default saves return the editor's authorized view without another user's private import", async () => {
    const { db, schema: d } = await import("@/db");
    const s = await import("@/lib/pets/store");
    const { PUT } = await import("@/app/api/bots/[id]/pet/default/route");
    const [bot] = await db.insert(d.bots).values({ ownerId: owner.user.id, name: "Private preview", appId, visibility: "private" }).returning();
    await s.replacePet(owner, bot.id, { ...manifest, displayName: "Owner-only art" }, Buffer.from("owner-only-pixels"));
    session.principal = admin;
    const origin = new URL(process.env.AUTH_URL ?? "http://localhost").origin;
    const response = await PUT(new Request(`${origin}/api/bots/${bot.id}/pet/default`, {
      method: "PUT", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ appearance: "ember", catalogId: null }),
    }), { params: Promise.resolve({ id: bot.id }) } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, appearance: "ember", source: "default", privateImport: null, custom: null });
    expect(await s.readPet(owner, bot.id)).toMatchObject({ appearance: "custom", source: "personal", custom: { displayName: "Owner-only art" } });
  });
  it("private → shared → private retains imports privately and ignores dormant identity, including Off", async () => {
    const { db, schema: d } = await import("@/db"); const s = await import("@/lib/pets/store");
    const own = await s.replacePet(owner, botId, { ...manifest, displayName: "Owner private secret" }, Buffer.from("private-pixels"));
    expect((await s.readAvatarSprite(owner, botId, own.revision)).toString()).toBe("private-pixels");
    await db.update(d.bots).set({ visibility: "org" }).where(eq(d.bots.id, botId));
    await s.saveBotDefault(owner, botId, { appearance: "catalog", catalogId });
    for (const p of [owner, viewer, admin]) {
      const view = await s.readPet(p, botId);
      expect(view).toMatchObject({ sharedIdentity: true, source: "default", appearance: "catalog", custom: manifest });
      expect((await s.readAvatarSprite(p, botId, view.revision)).toString()).toBe("shared-pixels");
      await expect(s.readAvatarSprite(p, botId, own.revision)).rejects.toMatchObject({ status: 404 });
      if (p !== owner) { expect(view.privateImport).toBeNull(); await expect(s.readPetSprite(p, botId)).rejects.toMatchObject({ status: 404 }); }
    }
    expect((await s.readPetSprite(owner, botId)).toString()).toBe("private-pixels");
    await db.update(d.bots).set({ visibility: "private" }).where(eq(d.bots.id, botId));
    expect(await s.readPet(owner, botId)).toMatchObject({ source: "personal", appearance: "custom", revision: own.revision });
    await s.savePet(owner, botId, { ...DEFAULT_PREFERENCES, mode: "off" });
    await db.update(d.bots).set({ visibility: "org" }).where(eq(d.bots.id, botId));
    expect(await s.readPet(owner, botId)).toMatchObject({ enabled: true, source: "default", preference: { mode: "off" } });
    await db.update(d.bots).set({ visibility: "private" }).where(eq(d.bots.id, botId));
    expect(await s.readPet(owner, botId)).toMatchObject({ enabled: false, preference: { mode: "off" }, privateImport: { revision: own.revision } });
  });
  it.each(["org", "groups"] as const)("%s owner/admin can set shared identity; viewers and personal mutations cannot", async visibility => {
    const { db, schema: d } = await import("@/db"); const s = await import("@/lib/pets/store");
    await db.update(d.bots).set({ visibility }).where(eq(d.bots.id, botId));
    await db.insert(d.botAccess).values({ botId, groupId }).onConflictDoNothing();
    for (const p of [owner, admin]) await s.saveBotDefault(p, botId, { appearance: "ember", catalogId: null });
    await expect(s.saveBotDefault(viewer, botId, { appearance: "moss", catalogId: null })).rejects.toMatchObject({ status: 403 });
    for (const p of [owner, viewer, admin]) {
      await expect(s.savePet(p, botId, { ...DEFAULT_PREFERENCES, mode: "off" })).rejects.toMatchObject({ status: 403 });
      await expect(s.replacePet(p, botId, manifest, Buffer.from("forged"))).rejects.toMatchObject({ status: 403 });
      await expect(s.replacePet(p, botId, null, null)).rejects.toMatchObject({ status: 403 });
      expect((await s.readPet(p, botId)).appearance).toBe("ember");
    }
  });
  it("viewer animation preserves identity and dormant fields; fresh group/session/account revocation denies writes", async () => {
    const { db, schema: d } = await import("@/db"); const s = await import("@/lib/pets/store");
    const before = await s.readPet(owner, botId);
    expect(await s.savePetMotion(owner, botId, "still")).toMatchObject({ motion: "still", preference: { ...before.preference, motion: "still" }, privateImport: before.privateImport, botDefault: before.botDefault });
    expect(await s.savePetMotion(viewer, botId, "still")).toMatchObject({ motion: "still", source: "default" });
    await db.delete(d.userExternalGroups).where(eq(d.userExternalGroups.userId, viewer.user.id));
    await expect(s.savePetMotion(viewer, botId, "auto")).rejects.toMatchObject({ status: 403 });
    await db.update(d.users).set({ sessionVersion: owner.user.sessionVersion + 1 }).where(eq(d.users.id, owner.user.id));
    await expect(s.saveBotDefault(owner, botId, { appearance: "moss", catalogId: null })).rejects.toMatchObject({ status: 403 });
    await expect(s.savePetMotion(owner, botId, "auto")).rejects.toMatchObject({ status: 403 });
    await db.update(d.users).set({ sessionVersion: owner.user.sessionVersion, disabled: true }).where(eq(d.users.id, owner.user.id));
    await expect(s.savePetMotion(owner, botId, "auto")).rejects.toMatchObject({ status: 403 });
    await db.update(d.users).set({ disabled: false }).where(eq(d.users.id, owner.user.id));
  });
  it("a blocked private write rechecks the committed visibility transition after the bot lock", async () => {
    const { db, schema: d, pool } = await import("@/db"); const s = await import("@/lib/pets/store");
    await db.update(d.bots).set({ visibility: "private" }).where(eq(d.bots.id, botId));
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("UPDATE bots SET visibility = 'org' WHERE id = $1", [botId]);
      const blocker = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = s.savePet(owner, botId, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "moss" });
      const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
      // Prove the preference transaction is waiting on this visibility update, before releasing it.
      await expect.poll(async () => (await pool.query("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blocker])).rowCount).toBe(1);
      await client.query("COMMIT"); await rejected;
      expect(await s.readPet(owner, botId)).toMatchObject({ preference: { mode: "off" }, source: "default" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("private service identity is admin-only, including former owners, and cosmetic updates preserve revision/grants", async () => {
    const { db, schema: d } = await import("@/db"); const s = await import("@/lib/pets/store");
    const [bot] = await db.insert(d.bots).values({ ownerId: admin.user.id, name: "Service identity", appId, visibility: "private", executionMode: "service", revision: 7, publishedRevision: 7, publishedConfigHash: "preserve" }).returning();
    await s.saveBotDefault(admin, bot.id, { appearance: "moss", catalogId: null });
    expect(await s.readPet(admin, bot.id, true)).toMatchObject({ sharedIdentity: true, canManageDefault: true, source: "default" });
    await db.update(d.users).set({ isAdmin: false }).where(eq(d.users.id, admin.user.id));
    await expect(s.saveBotDefault(admin, bot.id, { appearance: "ember", catalogId: null })).rejects.toMatchObject({ status: 403 });
    await expect(s.savePet(admin, bot.id, { ...DEFAULT_PREFERENCES, mode: "off" })).rejects.toMatchObject({ status: 403 });
    await expect(s.replacePet(admin, bot.id, manifest, Buffer.from("forged"))).rejects.toMatchObject({ status: 403 });
    await db.update(d.users).set({ isAdmin: true }).where(eq(d.users.id, admin.user.id));
    const [unchanged] = await db.select().from(d.bots).where(eq(d.bots.id, bot.id));
    expect(unchanged).toMatchObject({ revision: 7, publishedRevision: 7, publishedConfigHash: "preserve" });
  });
  it("New bot saves published identity atomically in the correct scope; invalid assets leave no orphan bot", async () => {
    const { db, schema: d } = await import("@/db"); const { createBot } = await import("@/app/(chat)/bots/actions"); const s = await import("@/lib/pets/store");
    session.principal = owner;
    for (const visibility of ["private", "org", "groups"] as const) {
      const { id } = await createBot({ ...input(visibility), initialPet: { appearance: "catalog", catalogId } });
      expect(await s.readPet(owner, id)).toMatchObject({ appearance: "catalog", source: visibility === "private" ? "personal" : "default", sharedIdentity: visibility !== "private" });
      expect(await db.select().from(d.botPetDefaults).where(eq(d.botPetDefaults.botId, id))).toHaveLength(visibility === "private" ? 0 : 1);
    }
    const before = await db.select({ id: d.bots.id }).from(d.bots).where(eq(d.bots.ownerId, owner.user.id));
    await expect(createBot({ ...input("org"), initialPet: { appearance: "catalog", catalogId: "missing-fixture" } })).rejects.toMatchObject({ status: 400 });
    expect(await db.select({ id: d.bots.id }).from(d.bots).where(eq(d.bots.ownerId, owner.user.id))).toEqual(before);
    await expect(createBot({ ...input("org"), executionMode: "service", initialPet: { appearance: "moss", catalogId: null } })).rejects.toMatchObject({ status: 403 });
    session.principal = admin;
    const { id } = await createBot({ ...input("private"), executionMode: "service", initialPet: { appearance: "ember", catalogId: null } });
    expect(await s.readPet(admin, id, true)).toMatchObject({ appearance: "ember", source: "default", sharedIdentity: true });
  });
  it("counts only active private personal selections, never dormant shared or service overrides", async () => {
    const { db, schema: d } = await import("@/db"); const s = await import("@/lib/pets/store"); const c = await import("@/lib/pets/catalog");
    await db.update(d.bots).set({ visibility: "private" }).where(eq(d.bots.id, botId));
    await s.savePet(owner, botId, { ...DEFAULT_PREFERENCES, mode: "personal", appearance: "catalog", catalogId });
    const count = () => c.listAdminCatalog(admin).then(rows => rows.find(r => r.id === catalogId)!.personalCount);
    const active = await count(); expect(active).toBeGreaterThan(0);
    await db.update(d.bots).set({ visibility: "org" }).where(eq(d.bots.id, botId)); expect(await count()).toBe(active - 1);
    await db.update(d.bots).set({ visibility: "private", executionMode: "service" }).where(eq(d.bots.id, botId)); expect(await count()).toBe(active - 1);
    expect(await db.select().from(d.botPets).where(and(eq(d.botPets.botId, botId), eq(d.botPets.userId, owner.user.id)))).toHaveLength(1);
  });
});
