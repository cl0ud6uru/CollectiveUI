import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { aiApps, appAccess, botUserAccess, bots, groupMembers, groups, users, userExternalGroups } from "@/db/schema";
import { savePortalGroup } from "@/lib/admin/groups";
import { loadPrincipal, syncUserOnSignIn, usersInGroups, type Principal } from "@/lib/auth/groups";
import { getAccessibleApp, getAccessibleBot, getEditableBot, HttpError, listAccessibleBots } from "@/lib/authz";
import { serviceConfigHash } from "@/lib/bots/service";
import { getSetting, setSetting } from "@/lib/settings";
import { newId } from "@/lib/ids";
const f = vi.hoisted(() => ({ principal: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { createBot, updateBot, saveBotFromBuilder, type BotInput } from "@/app/(chat)/bots/actions";

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("individual portal group and bot audiences", () => {
  const userIds: string[] = [], groupIds: string[] = [], botIds: string[] = [];
  let owner: Principal, member: Principal, stranger: Principal, local: Principal, appId: string;
  const groupInput = (name: string, memberIds: string[] = []) => ({ name, isAdmin: false, canCreateBots: true, mappings: [], memberIds });
  const botInput = (userIds: string[], groupIds: string[] = []): BotInput => ({ name: `Direct bot ${newId()}`, appId, visibility: "groups", userIds, groupIds, tools: [], delegateIds: [], maxSteps: 10, starters: [] });
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_direct_permissions_test") throw new Error("Disposable direct-permissions database required");
    vi.stubEnv("ADMIN_UPNS", ""); vi.stubEnv("ADMIN_GROUPS", "");
    for (const role of ["owner", "member", "stranger", "local"]) {
      const id = newId(); userIds.push(id);
      const [u] = await db.insert(users).values({ id, upn: `${role}-${id}@fixture.invalid`.toLowerCase(), name: role, isAdmin: role === "owner", identityRealm: role === "local" ? "local" : "directory", authSource: role === "local" ? "local" : "ldap" }).returning();
      const p = (await loadPrincipal(u.id))!;
      if (role === "owner") owner = p; else if (role === "member") member = p; else if (role === "stranger") stranger = p; else local = p;
    }
    const [app] = await db.insert(aiApps).values({ name: `Direct audience model ${newId()}`, provider: "openai-compatible", baseUrl: "http://127.0.0.1:4010/v1", model: "fixture", isPublic: false, supportsTools: true }).returning(); appId = app.id;
    f.principal.mockResolvedValue(owner);
  });
  afterAll(async () => {
    if (botIds.length) await db.delete(bots).where(inArray(bots.id, botIds));
    if (groupIds.length) await db.delete(groups).where(inArray(groups.id, groupIds));
    if (appId) await db.delete(aiApps).where(eq(aiApps.id, appId));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    vi.unstubAllEnvs(); await pool.end();
  });
  it("combines directory and direct memberships without duplicates and preserves direct memberships on sign-in", async () => {
    const input = { ...groupInput(`Hybrid ${newId()}`, [member.user.id, local.user.id, member.user.id]), mappings: [{ source: "ldap" as const, externalId: "CN=Fixture,DC=example" }] };
    const id = await savePortalGroup(input, owner.user.id); groupIds.push(id);
    await db.insert(userExternalGroups).values([{ userId: member.user.id, source: "ldap", externalId: "cn=fixture,dc=example" }, { userId: stranger.user.id, source: "ldap", externalId: "cn=fixture,dc=example" }, { userId: local.user.id, source: "ldap", externalId: "cn=fixture,dc=example" }]);
    expect((await loadPrincipal(member.user.id))?.groupIds.filter(g => g === id)).toHaveLength(1);
    expect((await loadPrincipal(local.user.id))?.groupIds).toContain(id);
    expect((await usersInGroups([id])).map(u => u.userId).sort()).toEqual([member.user.id, stranger.user.id, local.user.id].sort());
    expect((await syncUserOnSignIn({ upn: member.user.upn, name: "member", source: "ldap", groups: [] })).id).toBe(member.user.id);
    expect((await loadPrincipal(member.user.id))?.groupIds).toContain(id);
    await savePortalGroup({ ...input, id, memberIds: [] }, owner.user.id);
    expect((await loadPrincipal(member.user.id))?.groupIds).not.toContain(id);
    expect((await loadPrincipal(local.user.id))?.groupIds).not.toContain(id);
    expect((await loadPrincipal(stranger.user.id))?.groupIds).toContain(id);
    expect((await usersInGroups([id])).map(u => u.userId)).toEqual([stranger.user.id]);
  });
  it("applies permissions immediately, preserves members for older editors, and rolls invalid edits back", async () => {
    const input = { ...groupInput(`Direct admins ${newId()}`, [member.user.id]), isAdmin: true };
    const id = await savePortalGroup(input, owner.user.id); groupIds.push(id);
    expect(await loadPrincipal(member.user.id)).toMatchObject({ isAdmin: true, canCreateBots: true });
    await db.insert(appAccess).values({ appId, groupId: id });
    expect((await getAccessibleApp((await loadPrincipal(member.user.id))!, appId)).id).toBe(appId);
    const legacy = { ...input, memberIds: undefined };
    await savePortalGroup({ ...legacy, id }, owner.user.id);
    expect(await db.select().from(groupMembers).where(eq(groupMembers.groupId, id))).toHaveLength(1);
    await expect(savePortalGroup({ ...input, id, name: "Should not commit", memberIds: ["missing-user"] }, owner.user.id)).rejects.toMatchObject({ status: 400 });
    expect((await db.select().from(groups).where(eq(groups.id, id)))[0].name).toBe(input.name);
    await savePortalGroup({ ...input, id, memberIds: [] }, owner.user.id);
    expect((await loadPrincipal(member.user.id))?.isAdmin).toBe(false);
    await expect(getAccessibleApp((await loadPrincipal(member.user.id))!, appId)).rejects.toMatchObject({ status: 403 });
  });
  it("allows a users-only bot audience, without edit rights, and preserves grants on legacy saves", async () => {
    const input = botInput([member.user.id, local.user.id, member.user.id]);
    const { id } = await createBot(input); botIds.push(id);
    member = (await loadPrincipal(member.user.id))!;
    expect((await listAccessibleBots(member)).map(b => b.id)).toContain(id);
    expect((await getAccessibleBot(local, id)).id).toBe(id);
    await expect(getAccessibleBot(stranger, id)).rejects.toMatchObject({ status: 403 });
    await expect(getEditableBot(member, id)).rejects.toMatchObject({ status: 403 });
    const legacy = { ...input, userIds: undefined };
    await updateBot(id, legacy);
    expect(await db.select().from(botUserAccess).where(eq(botUserAccess.botId, id))).toHaveLength(2);
    await updateBot(id, { ...input, userIds: [local.user.id] });
    await expect(getAccessibleBot(member, id)).rejects.toMatchObject({ status: 403 });
    expect((await getAccessibleBot(local, id)).id).toBe(id);
    await updateBot(id, { ...input, visibility: "private" });
    expect(await db.select().from(botUserAccess).where(eq(botUserAccess.botId, id))).toHaveLength(0);
    await expect(getAccessibleBot(local, id)).rejects.toMatchObject({ status: 403 });
  });
  it("combines group and individual bot audiences and refuses unknown users or empty audiences", async () => {
    const groupId = await savePortalGroup(groupInput(`Bot users ${newId()}`, [stranger.user.id]), owner.user.id); groupIds.push(groupId);
    const input = botInput([member.user.id], [groupId]);
    const { id } = await createBot(input); botIds.push(id);
    expect((await getAccessibleBot((await loadPrincipal(stranger.user.id))!, id)).id).toBe(id);
    expect((await getAccessibleBot(member, id)).id).toBe(id);
    await expect(createBot(botInput([]))).rejects.toMatchObject({ status: 400 });
    await expect(updateBot(id, { ...input, userIds: ["unknown-user"] })).rejects.toMatchObject({ status: 400 });
    expect((await getAccessibleBot(member, id)).id).toBe(id);
  });
  it("returns editor audience errors as data and preserves the saved audience until a valid update", async () => {
    f.principal.mockResolvedValue(owner);
    const input = botInput([member.user.id]);
    const { id } = await createBot(input); botIds.push(id);
    expect(await saveBotFromBuilder(id, { ...input, userIds: [] })).toEqual({ ok: false, error: "Pick at least one group or user" });
    expect((await getAccessibleBot(member, id)).id).toBe(id);
    expect(await saveBotFromBuilder(null, botInput([]))).toEqual({ ok: false, error: "Pick at least one group or user" });
    expect(await saveBotFromBuilder(id, { ...input, userIds: [stranger.user.id] })).toEqual({ ok: true, id });
    expect((await getAccessibleBot(stranger, id)).id).toBe(id);
    await expect(getAccessibleBot(member, id)).rejects.toMatchObject({ status: 403 });
  });
  it("refuses unauthenticated editor creates and updates without changing the bot or audience", async () => {
    const input = botInput([member.user.id]);
    const { id } = await createBot(input); botIds.push(id);
    const before = await db.select().from(bots).where(eq(bots.id, id));
    f.principal.mockRejectedValue(new HttpError(401, "Unauthorized"));
    try {
      for (const target of [null, id])
        expect(await saveBotFromBuilder(target, { ...input, userIds: [stranger.user.id] })).toEqual({ ok: false, error: "Unauthorized" });
      expect(await db.select().from(bots).where(eq(bots.name, input.name))).toEqual(before);
      expect((await getAccessibleBot(member, id)).id).toBe(id);
      await expect(getAccessibleBot(stranger, id)).rejects.toMatchObject({ status: 403 });
    } finally { f.principal.mockResolvedValue(owner); }
  });
  it("enforces editor creation policy and refuses audience members' edits", async () => {
    const input = botInput([member.user.id]);
    const { id } = await createBot(input); botIds.push(id);
    const before = await db.select().from(bots).where(eq(bots.id, id));
    const policy = await getSetting("tools");
    try {
      await setSetting("tools", { ...policy, botCreation: "admins" });
      f.principal.mockResolvedValue(member);
      expect(await saveBotFromBuilder(null, input)).toEqual({ ok: false, error: "Only admins can create bots" });
      expect(await saveBotFromBuilder(id, { ...input, userIds: [stranger.user.id] })).toEqual({ ok: false, error: "Only an authorized bot editor can change it" });
      expect(await db.select().from(bots).where(eq(bots.name, input.name))).toEqual(before);
      expect((await getAccessibleBot(member, id)).id).toBe(id);
      await expect(getAccessibleBot(stranger, id)).rejects.toMatchObject({ status: 403 });
    } finally { f.principal.mockResolvedValue(owner); await setSetting("tools", policy); }
  });
  it("rechecks the editor session in create and update transactions", async () => {
    const input = botInput([member.user.id]);
    const { id } = await createBot(input); botIds.push(id);
    const before = await db.select().from(bots).where(eq(bots.id, id));
    f.principal.mockResolvedValue({ ...owner, user: { ...owner.user, sessionVersion: owner.user.sessionVersion + 1 } });
    try {
      expect(await saveBotFromBuilder(null, input)).toEqual({ ok: false, error: "Your access changed. Sign in again." });
      expect(await saveBotFromBuilder(id, { ...input, userIds: [stranger.user.id] })).toEqual({ ok: false, error: "Only an authorized bot editor can change this bot." });
      expect(await db.select().from(bots).where(eq(bots.name, input.name))).toEqual(before);
      expect((await getAccessibleBot(member, id)).id).toBe(id);
      await expect(getAccessibleBot(stranger, id)).rejects.toMatchObject({ status: 403 });
    } finally { f.principal.mockResolvedValue(owner); }
  });
  it("includes individually selected users in service publication checks", async () => {
    const [bot] = await db.insert(bots).values({ name: `Service fixture ${newId()}`, ownerId: owner.user.id, appId, executionMode: "service", visibility: "groups" }).returning(); botIds.push(bot.id);
    const original = await serviceConfigHash(bot);
    await db.insert(botUserAccess).values({ botId: bot.id, userId: member.user.id });
    expect(await serviceConfigHash(bot)).not.toBe(original);
    await db.delete(botUserAccess).where(and(eq(botUserAccess.botId, bot.id), eq(botUserAccess.userId, member.user.id)));
    expect(await serviceConfigHash(bot)).toBe(original);
  });
});
