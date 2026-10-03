import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import type { AiApp, Bot } from "@/db/schema";

const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
vi.mock("@/lib/session", () => ({
  requirePrincipal: async () => session.principal,
  requireAdmin: async () => session.principal,
  requirePagePrincipal: async () => session.principal,
  errorResponse: (err: Error) => Response.json({ error: err.message }, { status: 500 }),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("@/components/chat/new-chat", () => ({ NewChat: () => null }));
vi.mock("@/components/page-frame", () => ({ PageFrame: () => null }));
const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("where new chats start: a person's default, then the organization's bot or model", () => {
  const load = async () => {
    const { db, pool } = await import("@/db");
    const schema = await import("@/db/schema");
    const { resolveTargetOption } = await import("@/lib/chat/targets");
    const { getSetting, setSetting } = await import("@/lib/settings");
    const { updatePrefs } = await import("@/app/(chat)/actions");
    const { saveBranding } = await import("@/app/admin/actions");
    const { newId } = await import("@/lib/ids");
    return { db, pool, schema, resolveTargetOption, getSetting, setSetting, updatePrefs, saveBranding, newId };
  };
  let m: Awaited<ReturnType<typeof load>>, admin: Principal, member: Principal, model: AiApp, shared: Bot, privateBot: Bot;
  let branding: Awaited<ReturnType<typeof m.getSetting<"branding">>>;
  const userIds: string[] = [];
  const as = (p: Principal, prefs: Principal["user"]["prefs"]) => ({ ...p, user: { ...p.user, prefs } });
  const prefsOf = async (p: Principal) => (await m.db.select({ prefs: m.schema.users.prefs }).from(m.schema.users).where(eq(m.schema.users.id, p.user.id)))[0].prefs;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_default_start_test") throw new Error("Named disposable default-start database required");
    m = await load();
    const principals: Principal[] = [];
    for (const isAdmin of [true, false]) {
      const id = `start-${m.newId()}`;
      const [user] = await m.db.insert(m.schema.users).values({ id, upn: `${id}@isolated.test`, name: id, authSource: "ldap", isAdmin }).returning();
      userIds.push(id);
      principals.push({ user, isAdmin, groupIds: [], canCreateBots: true });
    }
    [admin, member] = principals;
    [model] = await m.db.insert(m.schema.aiApps).values({ name: "Start model", provider: "openai-compatible", baseUrl: "http://127.0.0.1:18642", model: "test", isPublic: true, supportsTools: true }).returning();
    [shared] = await m.db.insert(m.schema.bots).values({ ownerId: admin.user.id, name: "Front desk", appId: model.id, visibility: "org" }).returning();
    [privateBot] = await m.db.insert(m.schema.bots).values({ ownerId: admin.user.id, name: "Admin's own", appId: model.id }).returning();
    branding = await m.getSetting("branding");
  });
  afterAll(async () => {
    if (branding) await m.setSetting("branding", branding);
    await m.db.delete(m.schema.users).where(inArray(m.schema.users.id, userIds));
    await m.db.delete(m.schema.aiApps).where(eq(m.schema.aiApps.id, model.id));
    await m.pool.end();
  });

  it("starts people without their own default on the organization's shared bot", async () => {
    await m.setSetting("branding", { ...branding, defaultAppId: undefined, defaultBotId: shared.id });
    expect(await m.resolveTargetOption(as(member, {}), {})).toMatchObject({ target: { kind: "bot", id: shared.id } });
  });

  it("lets a person's own model or bot default override the organization's", async () => {
    await m.setSetting("branding", { ...branding, defaultAppId: undefined, defaultBotId: shared.id });
    expect(await m.resolveTargetOption(as(member, { defaultAppId: model.id }), {})).toMatchObject({ target: { kind: "app", id: model.id } });
    await m.setSetting("branding", { ...branding, defaultAppId: model.id, defaultBotId: undefined });
    expect(await m.resolveTargetOption(as(member, { defaultBotId: shared.id }), {})).toMatchObject({ target: { kind: "bot", id: shared.id } });
  });

  it("explains an unavailable default bot instead of silently starting somewhere else", async () => {
    await m.setSetting("branding", { ...branding, defaultAppId: undefined, defaultBotId: shared.id });
    await m.db.update(m.schema.bots).set({ enabled: false }).where(eq(m.schema.bots.id, shared.id));
    try {
      expect(await m.resolveTargetOption(as(member, {}), {})).toMatchObject({ target: null, unavailableReason: expect.stringContaining("default bot is unavailable") });
    } finally { await m.db.update(m.schema.bots).set({ enabled: true }).where(eq(m.schema.bots.id, shared.id)); }
    // A bot the person can't see is unavailable to them, too.
    expect(await m.resolveTargetOption(as(member, { defaultBotId: privateBot.id }), {})).toMatchObject({ target: null, unavailableReason: expect.stringContaining("default bot is unavailable") });
  });

  it("accepts only bots shared with everyone, and one start target, as the organization default", async () => {
    session.principal = admin;
    await expect(m.saveBranding({ ...branding, defaultAppId: undefined, defaultBotId: privateBot.id })).rejects.toThrow("shared with everyone");
    await expect(m.saveBranding({ ...branding, defaultAppId: model.id, defaultBotId: shared.id })).rejects.toThrow("either a model or a bot");
    await m.saveBranding({ ...branding, defaultAppId: undefined, defaultBotId: shared.id });
    expect(await m.getSetting("branding")).toMatchObject({ defaultBotId: shared.id });
    expect((await m.getSetting("branding")).defaultAppId).toBeUndefined();
  });

  it("stores one personal start target, clears it with null, and rejects bots the person can't use", async () => {
    await m.db.update(m.schema.users).set({ prefs: { memoryEnabled: true, defaultAppId: model.id } }).where(eq(m.schema.users.id, member.user.id));
    session.principal = as(member, { memoryEnabled: true, defaultAppId: model.id });
    await m.updatePrefs({ defaultAppId: null, defaultBotId: shared.id });
    expect(await prefsOf(member)).toEqual({ memoryEnabled: true, defaultBotId: shared.id });
    session.principal = as(member, await prefsOf(member));
    await m.updatePrefs({ memoryEnabled: false });
    expect(await prefsOf(member)).toEqual({ memoryEnabled: false, defaultBotId: shared.id });
    session.principal = as(member, await prefsOf(member));
    await m.updatePrefs({ defaultAppId: null, defaultBotId: null });
    expect(await prefsOf(member)).toEqual({ memoryEnabled: false });
    await expect(m.updatePrefs({ defaultBotId: privateBot.id })).rejects.toThrow();
    await expect(m.updatePrefs({ defaultAppId: model.id, defaultBotId: shared.id })).rejects.toThrow("either a model or a bot");
  });

  it("preserves current preferences across stale request snapshots and checks session revocation", async () => {
    session.principal = as(member, { defaultAppId: model.id, memoryEnabled: true });
    await m.db.update(m.schema.users).set({ prefs: { defaultBotId: shared.id, customInstructions: "Keep current instructions" } }).where(eq(m.schema.users.id, member.user.id));
    await m.updatePrefs({ memoryEnabled: false });
    expect(await prefsOf(member)).toEqual({ defaultBotId: shared.id, customInstructions: "Keep current instructions", memoryEnabled: false });
    await m.updatePrefs({ defaultBotId: null });
    await m.updatePrefs({ memoryEnabled: true });
    expect(await prefsOf(member)).toEqual({ customInstructions: "Keep current instructions", memoryEnabled: true });
    await m.db.update(m.schema.users).set({ sessionVersion: 1 }).where(eq(m.schema.users.id, member.user.id));
    try { await expect(m.updatePrefs({ memoryEnabled: false })).rejects.toMatchObject({ status: 403 }); }
    finally { await m.db.update(m.schema.users).set({ sessionVersion: 0 }).where(eq(m.schema.users.id, member.user.id)); }
  });

  it("does not use admin oversight or a hidden bot for an implicit default", async () => {
    const [otherPrivate] = await m.db.insert(m.schema.bots).values({ ownerId: member.user.id, name: "Private marker", appId: model.id }).returning();
    expect(await m.resolveTargetOption(as(admin, { defaultBotId: otherPrivate.id }), {})).toMatchObject({ target: null });
    session.principal = admin;
    await expect(m.updatePrefs({ defaultBotId: otherPrivate.id })).rejects.toMatchObject({ status: 403 });
    expect(await m.resolveTargetOption(admin, { botId: otherPrivate.id })).toMatchObject({ target: { id: otherPrivate.id } });
    await m.db.insert(m.schema.userBotPrefs).values({ userId: member.user.id, botId: shared.id, hidden: true });
    try { expect(await m.resolveTargetOption(as(member, { defaultBotId: shared.id }), {})).toMatchObject({ target: null }); }
    finally { await m.db.delete(m.schema.userBotPrefs).where(eq(m.schema.userBotPrefs.userId, member.user.id)); }
  });

  it.each(["disabled", "missing"])("withholds a default bot whose connection is %s", async kind => {
    if (kind === "disabled") await m.db.update(m.schema.aiApps).set({ enabled: false }).where(eq(m.schema.aiApps.id, model.id));
    else await m.db.update(m.schema.bots).set({ appId: null }).where(eq(m.schema.bots.id, shared.id));
    try { expect(await m.resolveTargetOption(as(member, { defaultBotId: shared.id }), {})).toMatchObject({ target: null, unavailableReason: expect.stringContaining("default bot is unavailable") }); }
    finally {
      await m.db.update(m.schema.aiApps).set({ enabled: true }).where(eq(m.schema.aiApps.id, model.id));
      await m.db.update(m.schema.bots).set({ appId: model.id }).where(eq(m.schema.bots.id, shared.id));
    }
  });

  it("keeps the model chooser model-only while preserving legacy model preferences", async () => {
    await m.setSetting("branding", { ...branding, defaultAppId: undefined, defaultBotId: shared.id });
    expect(await m.resolveTargetOption(as(member, { defaultBotId: shared.id }), { modelsOnly: true })).toMatchObject({ target: { kind: "app", id: model.id } });
    expect(await m.resolveTargetOption(as(member, { defaultAppId: model.id }), { modelsOnly: true })).toMatchObject({ target: { kind: "app", id: model.id } });
    expect(await m.resolveTargetOption(as(member, { defaultAppId: "deleted" }), { modelsOnly: true })).toMatchObject({ target: null });
  });

  it("applies personal choice before the coordinator on the actual entry page and never falls through an unavailable choice", async () => {
    const { default: page } = await import("@/app/(chat)/page");
    const props = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };
    await m.setSetting("coordinator", { enabled: true, defaultBotId: shared.id, starterBotId: null });
    for (const [prefs, target] of [[{ defaultAppId: model.id }, { kind: "app", id: model.id }], [{ defaultBotId: shared.id }, { kind: "bot", id: shared.id }], [{ defaultBotId: "deleted" }, null]] as const) {
      session.principal = as(member, prefs);
      expect((await page(props)).props.target).toEqual(target ? expect.objectContaining(target) : null);
    }
    session.principal = as(member, {});
    await expect(page(props)).rejects.toThrow("REDIRECT:/c/");
    session.principal = as(member, { defaultBotId: shared.id });
    expect((await page({ ...props, searchParams: Promise.resolve({ chat: "model" }) })).props.target).toMatchObject({ kind: "app", id: model.id });
    // Explicit bot navigation still opens a home regardless of personal model choice.
    session.principal = as(member, { defaultAppId: model.id });
    await expect(page({ ...props, searchParams: Promise.resolve({ bot: shared.id }) })).rejects.toThrow("REDIRECT:/c/");
    await m.db.delete(m.schema.settings).where(eq(m.schema.settings.key, "coordinator"));
  });
});
