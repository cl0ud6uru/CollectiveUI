import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import { DEFAULT_PET } from "@/lib/pets/shared";

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("private bot companions (real Postgres)", () => {
  let alice: Principal, bob: Principal;
  let orgBot: string, privateBot: string;
  const ids: string[] = [];
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    for (const name of ["Alice", "Bob"]) {
      const id = `pet-it-${newId()}`; ids.push(id);
      const [user] = await db.insert(schema.users).values({ id, upn: `${id}@test.local`, name, authSource: "ldap" }).returning();
      const principal = { user, groupIds: [], isAdmin: false, canCreateBots: true };
      if (name === "Alice") alice = principal; else bob = principal;
    }
    const [org, priv] = await db.insert(schema.bots).values([{ ownerId: alice.user.id, name: "Pet IT shared", visibility: "org" }, { ownerId: alice.user.id, name: "Pet IT private", visibility: "private" }]).returning();
    orgBot = org.id; privateBot = priv.id;
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    await db.delete(schema.users).where(inArray(schema.users.id, ids));
    await pool.end();
  });
  it("persists choices and bytes by user/bot, including same bot and administrator boundaries", async () => {
    const { readPet, savePet, replacePet, readPetSprite } = await import("@/lib/pets/store");
    expect(await readPet(alice, privateBot)).toEqual(DEFAULT_PET);
    await expect(savePet(alice, privateBot, { mode: "personal", catalogId: null, appearance: "custom", motion: "auto" })).rejects.toThrow(/Import/);
    await savePet(alice, privateBot, { mode: "personal", catalogId: null, appearance: "ember", motion: "still" });
    expect(await readPet(alice, privateBot)).toMatchObject({ enabled: true, appearance: "ember", motion: "still" });
    const custom = { displayName: "Private art", description: "", spriteVersionNumber: 2 as const, credit: "Artist" };
    await replacePet(alice, privateBot, custom, Buffer.from("normalized pixel fixture"));
    expect(await readPet(alice, privateBot)).toMatchObject({ enabled: true, motion: "still", appearance: "custom", custom });
    expect((await readPetSprite(alice, privateBot)).toString()).toBe("normalized pixel fixture");
    const before = await readPet(alice, privateBot);
    expect((await readPetSprite(alice, privateBot, before.revision)).toString()).toBe("normalized pixel fixture");
    const after = await replacePet(alice, privateBot, custom, Buffer.from("replacement pixel fixture"));
    await expect(readPetSprite(alice, privateBot, before.revision)).rejects.toThrow(/not found/);
    expect((await readPetSprite(alice, privateBot, after.revision)).toString()).toBe("replacement pixel fixture");
    await expect(readPet(bob, privateBot)).rejects.toThrow(/access/);
    expect(await readPet(alice, orgBot)).toMatchObject({ enabled: false, sharedIdentity: true, canManageDefault: true });
    await expect(readPetSprite(bob, privateBot)).rejects.toThrow(/access/);
    await expect(readPetSprite({ ...bob, isAdmin: true }, privateBot)).rejects.toThrow(/not found/);
    await expect(readPet(bob, privateBot)).rejects.toThrow(/access/);
    await expect(savePet(bob, privateBot, { mode: "personal", catalogId: null, appearance: "moss", motion: "auto" })).rejects.toThrow(/access/);
    await expect(replacePet(bob, privateBot, custom, Buffer.from("bad"))).rejects.toThrow(/access/);
    await replacePet(alice, privateBot, null, null);
    expect(await readPet(alice, privateBot)).toMatchObject({ enabled: false, appearance: "moss", custom: null, revision: null });
    await expect(readPetSprite(alice, privateBot)).rejects.toThrow(/not found/);
  });
  it("refuses disabled bots and cascades deleted bots including private images", async () => {
    const { db, schema } = await import("@/db");
    const { readPet, savePet, readPetSprite } = await import("@/lib/pets/store");
    await db.update(schema.bots).set({ enabled: false }).where(eq(schema.bots.id, orgBot));
    await expect(readPet(alice, orgBot)).rejects.toThrow(/disabled/);
    await expect(readPetSprite(alice, orgBot)).rejects.toThrow(/disabled/);
    await expect(savePet(alice, orgBot, { mode: "off", catalogId: null, appearance: "moss", motion: "auto" })).rejects.toThrow(/disabled/);
    await db.delete(schema.bots).where(eq(schema.bots.id, orgBot));
    expect(await db.select().from(schema.botPets).where(eq(schema.botPets.botId, orgBot))).toHaveLength(0);
  });
});
