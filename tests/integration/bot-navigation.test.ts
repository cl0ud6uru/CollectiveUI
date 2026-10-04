import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/lib/auth/groups";

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("personal navigation persistence and authorization", () => {
  let alice: Principal, bob: Principal;
  let ids: string[];
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const people = [];
    for (const name of ["Navigation Alice", "Navigation Bob"]) {
      const id = newId();
      const [user] = await db.insert(schema.users).values({ id, upn: `${id}@test.invalid`, name, authSource: "ldap", prefs: { customInstructions: "Keep this preference" } }).returning();
      people.push({ user, groupIds: [], isAdmin: false, canCreateBots: false });
    }
    [alice, bob] = people;
    const bots = await db.insert(schema.bots).values(["A", "B", "C"].map(name => ({ name: `Navigation ${name}`, ownerId: alice.user.id, visibility: "org" as const }))).returning();
    ids = bots.map(b => b.id);
  });
  afterAll(async () => {
    const { db, schema, pool } = await import("@/db");
    await db.delete(schema.users).where(inArray(schema.users.id, [alice.user.id, bob.user.id]));
    await pool.end();
  });
  async function saved(p: Principal) {
    const { db, schema } = await import("@/db");
    return (await db.select().from(schema.users).where(eq(schema.users.id, p.user.id)))[0].prefs;
  }
  it("round-trips order and pins, preserves unrelated preferences, and isolates shared bots", async () => {
    const { saveBotNavigation } = await import("@/lib/bots/navigation-store");
    const { db, schema } = await import("@/db");
    await saveBotNavigation(alice, { kind: "preference", botId: ids[1], pinned: true });
    await saveBotNavigation(alice, { kind: "move", botId: ids[2], targetId: ids[1], placement: "before" });
    expect((await saved(alice)).botOrder?.filter(id => ids.includes(id))).toEqual([ids[2], ids[1], ids[0]]);
    expect((await saved(alice)).customInstructions).toBe("Keep this preference");
    expect((await saved(bob)).botOrder).toBeUndefined();
    expect(await db.select().from(schema.userBotPrefs).where(eq(schema.userBotPrefs.userId, bob.user.id))).toEqual([]);
    expect((await db.select().from(schema.bots).where(eq(schema.bots.id, ids[1])))[0]).toMatchObject({ ownerId: alice.user.id, visibility: "org" });
  });
  it("serializes repeated pins and concurrent moves without duplicate order entries", async () => {
    const { saveBotNavigation } = await import("@/lib/bots/navigation-store");
    const { db, schema } = await import("@/db");
    await Promise.all(Array.from({ length: 8 }, () => saveBotNavigation(bob, { kind: "preference", botId: ids[0], pinned: true })));
    await Promise.all([saveBotNavigation(bob, { kind: "move", botId: ids[1], targetId: ids[0], placement: "before" }), saveBotNavigation(bob, { kind: "preference", botId: ids[2], pinned: true })]);
    const order = (await saved(bob)).botOrder!;
    expect(new Set(order).size).toBe(order.length);
    expect(order.filter(id => ids.includes(id))).toHaveLength(3);
    expect((await db.select().from(schema.userBotPrefs).where(eq(schema.userBotPrefs.userId, bob.user.id))).filter(p => p.botId === ids[0])).toHaveLength(1);
  });
  it("refuses revoked access and oversight-only admin pins, then prunes stale IDs", async () => {
    const { saveBotNavigation } = await import("@/lib/bots/navigation-store");
    const { db, schema } = await import("@/db");
    await db.update(schema.bots).set({ visibility: "private" }).where(eq(schema.bots.id, ids[0]));
    await expect(saveBotNavigation(bob, { kind: "preference", botId: ids[0], pinned: true })).rejects.toMatchObject({ status: 403 });
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, bob.user.id));
    await expect(saveBotNavigation({ ...bob, isAdmin: true }, { kind: "move", botId: ids[0], targetId: ids[1], placement: "before" })).rejects.toMatchObject({ status: 403 });
    await saveBotNavigation(bob, { kind: "preference", botId: ids[1], pinned: true });
    expect((await saved(bob)).botOrder).not.toContain(ids[0]);
  });
  it("ignores deleted/disabled bots and rejects disabled accounts and stale sessions", async () => {
    const { saveBotNavigation } = await import("@/lib/bots/navigation-store");
    const { db, schema } = await import("@/db");
    await db.update(schema.bots).set({ enabled: false }).where(eq(schema.bots.id, ids[0]));
    await expect(saveBotNavigation(alice, { kind: "preference", botId: ids[0], pinned: true })).rejects.toMatchObject({ status: 403 });
    await db.delete(schema.bots).where(eq(schema.bots.id, ids[0]));
    await expect(saveBotNavigation(alice, { kind: "move", botId: ids[0], targetId: ids[1], placement: "before" })).rejects.toMatchObject({ status: 403 });
    await saveBotNavigation(alice, { kind: "preference", botId: ids[1], pinned: false });
    expect((await saved(alice)).botOrder).not.toContain(ids[0]);
    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, bob.user.id));
    await expect(saveBotNavigation(bob, { kind: "preference", botId: ids[1], pinned: true })).rejects.toMatchObject({ status: 403 });
    await db.update(schema.users).set({ disabled: false, sessionVersion: 1 }).where(eq(schema.users.id, bob.user.id));
    await expect(saveBotNavigation(bob, { kind: "preference", botId: ids[1], pinned: true })).rejects.toMatchObject({ status: 403 });
  });
  it("rejects unexpected data and rolls back pin writes when saving order fails", async () => {
    const { saveBotNavigation } = await import("@/lib/bots/navigation-store");
    const { db, schema } = await import("@/db");
    const before = await saved(alice);
    const pinsBefore = await db.select().from(schema.userBotPrefs).where(eq(schema.userBotPrefs.userId, alice.user.id));
    await expect(saveBotNavigation(alice, { kind: "preference", botId: ids[1], pinned: true, userId: bob.user.id })).rejects.toThrow();
    await expect(saveBotNavigation(alice, { kind: "move", botId: ids[1], targetId: "missing", placement: "before" })).rejects.toThrow();
    // The generated fixture ID contains only nanoid characters. NOT VALID leaves existing rows intact,
    // but fails the users update after the preference upsert, exercising actual transaction rollback.
    await db.execute(sql.raw(`ALTER TABLE users ADD CONSTRAINT navigation_reject_save CHECK (id <> '${alice.user.id}') NOT VALID`));
    try {
      await expect(saveBotNavigation(alice, { kind: "preference", botId: ids[1], pinned: true })).rejects.toThrow();
    } finally { await db.execute(sql`ALTER TABLE users DROP CONSTRAINT navigation_reject_save`); }
    expect(await saved(alice)).toEqual(before);
    expect(await db.select().from(schema.userBotPrefs).where(eq(schema.userBotPrefs.userId, alice.user.id))).toEqual(pinsBefore);
  });
  it("orders unsaved bots with the layout's coordinator rule, so a first move cannot reorder other rows", async () => {
    const { saveBotNavigation } = await import("@/lib/bots/navigation-store");
    const { setSetting } = await import("@/lib/settings");
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const id = newId();
    const [user] = await db.insert(schema.users).values({ id, upn: `${id}@test.invalid`, name: "Navigation Carol", authSource: "ldap" }).returning();
    const carol: Principal = { user, groupIds: [], isAdmin: false, canCreateBots: false };
    // A service-mode default bot is never the sidebar coordinator, so it keeps its alphabetical place.
    const [service] = await db.insert(schema.bots).values({ name: "Navigation Z service", ownerId: alice.user.id, visibility: "org", executionMode: "service" }).returning();
    await setSetting("coordinator", { enabled: true, defaultBotId: service.id, starterBotId: null });
    try {
      await saveBotNavigation(carol, { kind: "move", botId: ids[2], targetId: ids[1], placement: "before" });
      expect((await saved(carol)).botOrder?.filter(b => [ids[1], ids[2], service.id].includes(b))).toEqual([ids[2], ids[1], service.id]);
    } finally {
      await db.delete(schema.settings).where(eq(schema.settings.key, "coordinator"));
      await db.delete(schema.users).where(eq(schema.users.id, carol.user.id));
      await db.delete(schema.bots).where(eq(schema.bots.id, service.id));
    }
  });
});
