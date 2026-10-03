import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import type { AiApp, Bot } from "@/db/schema";

const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
vi.mock("@/lib/session", () => ({
  requirePrincipal: async () => session.principal,
  requireAdmin: async () => session.principal,
  errorResponse: (err: Error) => Response.json({ error: err.message }, { status: 500 }),
}));
const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("ordinary model routing and legacy Hermes history", () => {
  const load = async () => {
    const { db, pool } = await import("@/db");
    const schema = await import("@/db/schema");
    const authz = await import("@/lib/authz");
    const { resolveTargetOption } = await import("@/lib/chat/targets");
    const { resolveTurnTarget } = await import("@/lib/agent/target");
    const { conversationSnapshot } = await import("@/lib/chat/snapshot");
    const { getSetting, setSetting } = await import("@/lib/settings");
    const { newId } = await import("@/lib/ids");
    return { db, pool, schema, authz, resolveTargetOption, resolveTurnTarget, conversationSnapshot, getSetting, setSetting, newId };
  };
  let m: Awaited<ReturnType<typeof load>>, p: Principal, native: AiApp, manual: AiApp, managed: AiApp, bot: Bot;
  let branding: Awaited<ReturnType<typeof m.getSetting<"branding">>>;
  const appIds: string[] = [];
  beforeAll(async () => {
    m = await load();
    const id = `routing-${m.newId()}`;
    const [user] = await m.db.insert(m.schema.users).values({ id, upn: `${id}@isolated.test`, name: id, authSource: "ldap" }).returning();
    p = { user, isAdmin: true, groupIds: [], canCreateBots: true }; session.principal = p;
    for (const [provider, config] of [["openai-compatible", {}], ["hermes", { profile: "manual" }], ["hermes", { managed: { provider: "openai", model: "test", skills: [], toolsets: [] } }]] as const) {
      const [app] = await m.db.insert(m.schema.aiApps).values({ id: m.newId(), name: provider, provider, baseUrl: "http://127.0.0.1:18642", model: "test", providerConfig: config, isPublic: true }).returning();
      appIds.push(app.id);
      if (provider !== "hermes") native = app; else if ("managed" in config) managed = app; else manual = app;
    }
    [bot] = await m.db.insert(m.schema.bots).values({ ownerId: user.id, name: "Hermes bot", appId: manual.id }).returning();
    branding = await m.getSetting("branding");
  });
  afterAll(async () => {
    if (branding) await m.setSetting("branding", branding);
    await m.db.delete(m.schema.users).where(eq(m.schema.users.id, p.user.id));
    await m.db.delete(m.schema.aiApps).where(inArray(m.schema.aiApps.id, appIds));
    await m.pool.end();
  });
  it("offers models to ordinary users and admins while retaining all connections for bot configuration", async () => {
    for (const principal of [p, { ...p, isAdmin: false }]) {
      expect((await m.authz.listAccessibleModels(principal)).map(a => a.id)).toContain(native.id);
      expect((await m.authz.listAccessibleModels(principal)).map(a => a.id)).not.toContain(manual.id);
      expect((await m.authz.listAccessibleModels(principal)).map(a => a.id)).not.toContain(managed.id);
      expect((await m.authz.listAccessibleApps(principal)).map(a => a.id)).toEqual(expect.arrayContaining(appIds));
    }
  });
  it("rejects both Hermes kinds at ordinary turn and model resolution boundaries; permits bot targets", async () => {
    const { resolveModel } = await import("@/lib/llm/resolve");
    for (const app of [manual, managed]) {
      await expect(m.authz.getAccessibleModel(p, app.id)).rejects.toThrow("agent backend for bots");
      await expect(m.resolveTurnTarget(p, { appId: app.id, botId: null })).rejects.toThrow("agent backend for bots");
      await expect(resolveModel(app, { purpose: "chat", principal: p })).rejects.toThrow("agent backend for bots");
      await expect(resolveModel(app, { purpose: "title", principal: p, botId: bot.id })).rejects.toThrow("background work");
    }
    expect((await m.resolveTurnTarget(p, { appId: null, botId: bot.id })).app.id).toBe(manual.id);
  });
  it("does not replace invalid saved/global defaults with another billable provider", async () => {
    await m.setSetting("branding", { ...branding, defaultAppId: manual.id });
    expect(await m.resolveTargetOption(p, {})).toMatchObject({ target: null, unavailableReason: expect.stringContaining("default model is unavailable") });
    expect(await m.resolveTargetOption({ ...p, user: { ...p.user, prefs: { defaultAppId: native.id } } }, {})).toMatchObject({ target: { id: native.id } });
    expect(await m.resolveTargetOption({ ...p, user: { ...p.user, prefs: { defaultAppId: "deleted" } } }, {})).toMatchObject({ target: null });
  });
  it("does not replace disabled or inaccessible native defaults", async () => {
    const [other] = await m.db.insert(m.schema.aiApps).values({ name: "Other model", provider: "openai-compatible", baseUrl: "http://127.0.0.1:18642", model: "test", isPublic: true }).returning();
    appIds.push(other.id);
    await m.setSetting("branding", { ...branding, defaultAppId: native.id });
    const ordinary = { ...p, isAdmin: false };
    try {
      for (const state of [{ enabled: false, isPublic: true }, { enabled: true, isPublic: false }]) {
        await m.db.update(m.schema.aiApps).set(state).where(eq(m.schema.aiApps.id, native.id));
        expect((await m.authz.listAccessibleModels(ordinary)).map(a => a.id)).toContain(other.id);
        expect(await m.resolveTargetOption(ordinary, {})).toMatchObject({ target: null, unavailableReason: expect.stringContaining("default model is unavailable") });
        expect(await m.resolveTargetOption({ ...ordinary, user: { ...ordinary.user, prefs: { defaultAppId: native.id } } }, {})).toMatchObject({ target: null });
      }
    } finally { await m.db.update(m.schema.aiApps).set({ enabled: true, isPublic: true }).where(eq(m.schema.aiApps.id, native.id)); }
  });
  it.each(["manual", "managed"])("preserves %s Hermes history and rejects POST, retry/regenerate, approvals and slash commands without creating records", async (kind) => {
    const app = kind === "manual" ? manual : managed;
    const { POST } = await import("@/app/api/chat/route");
    const { resolveCommandTarget } = await import("@/lib/chat/hermes-command-service");
    const convId = m.newId(), messageId = m.newId();
    await m.db.insert(m.schema.conversations).values({ id: convId, userId: p.user.id, appId: app.id });
    await m.db.insert(m.schema.messages).values({ id: messageId, conversationId: convId, role: "user", parts: [{ type: "text", text: "Existing history" }] });
    const snapshot = await m.conversationSnapshot(p, convId);
    expect(snapshot.initialRows).toHaveLength(1);
    expect(snapshot.unavailableReason).toContain("Existing history stays available");
    const freshId = m.newId();
    for (const payload of [
      { conversationId: freshId, appId: app.id, message: { id: m.newId(), role: "user", parts: [{ type: "text", text: "hello" }] } },
      { conversationId: convId, message: { id: m.newId(), role: "user", parts: [{ type: "text", text: "retry" }] } },
      { conversationId: convId, regenerate: true, parentId: messageId },
      { conversationId: convId, message: { id: m.newId(), role: "assistant", parts: [] } },
    ]) {
      const res = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(payload) }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("agent backend for bots");
    }
    await expect(resolveCommandTarget(p, { conversationId: convId })).rejects.toThrow("agent backend for bots");
    expect(await m.db.select().from(m.schema.conversations).where(eq(m.schema.conversations.id, freshId))).toHaveLength(0);
    expect((await m.conversationSnapshot(p, convId)).initialRows).toHaveLength(1);
    expect(await m.db.select().from(m.schema.agentRuns).where(eq(m.schema.agentRuns.conversationId, convId))).toHaveLength(0);
  });
  it("preserves manual Hermes when duplicating bots and refuses an unavailable source connection", async () => {
    const { duplicateBot, createBotTemplate, addBotFromTemplate } = await import("@/app/(chat)/bots/actions");
    const copy = await duplicateBot(bot.id);
    const [copied] = await m.db.select().from(m.schema.bots).where(eq(m.schema.bots.id, copy.id));
    expect(copied.appId).toBe(manual.id);
    const template = await createBotTemplate(bot.id);
    const fromTemplate = await addBotFromTemplate(template.token);
    const [templated] = await m.db.select().from(m.schema.bots).where(eq(m.schema.bots.id, fromTemplate.id));
    expect(templated.appId).toBe(manual.id);
    await m.db.update(m.schema.aiApps).set({ enabled: false }).where(eq(m.schema.aiApps.id, manual.id));
    try {
      await expect(duplicateBot(bot.id)).rejects.toThrow("source bot connection is unavailable");
      await expect(addBotFromTemplate(template.token)).rejects.toThrow("source bot connection is unavailable");
    } finally { await m.db.update(m.schema.aiApps).set({ enabled: true }).where(eq(m.schema.aiApps.id, manual.id)); }
  });
  it("refuses duplicate and template copies after deleting the source connection", async () => {
    const { duplicateBot, createBotTemplate, addBotFromTemplate } = await import("@/app/(chat)/bots/actions");
    const [sourceApp] = await m.db.insert(m.schema.aiApps).values({ name: "Deleted Hermes", provider: "hermes", baseUrl: "http://127.0.0.1:18642", model: "test" }).returning();
    appIds.push(sourceApp.id);
    const [sourceBot] = await m.db.insert(m.schema.bots).values({ ownerId: p.user.id, name: "Deleted connection bot", appId: sourceApp.id }).returning();
    const template = await createBotTemplate(sourceBot.id);
    await m.db.delete(m.schema.aiApps).where(eq(m.schema.aiApps.id, sourceApp.id));
    const [source] = await m.db.select().from(m.schema.bots).where(eq(m.schema.bots.id, sourceBot.id));
    expect(source.appId).toBeNull();
    await expect(duplicateBot(sourceBot.id)).rejects.toThrow("source bot connection is unavailable");
    await expect(addBotFromTemplate(template.token)).rejects.toThrow("source bot connection is unavailable");
  });
  it("does not create an ordinary Hermes chat by continuing a shared legacy history", async () => {
    const { continueSharedConversation } = await import("@/app/(chat)/actions");
    const convId = m.newId(), messageId = m.newId(), token = m.newId();
    await m.db.insert(m.schema.conversations).values({ id: convId, userId: p.user.id, appId: manual.id });
    await m.db.insert(m.schema.messages).values({ id: messageId, conversationId: convId, role: "user", parts: [{ type: "text", text: "shared history" }] });
    await m.db.insert(m.schema.sharedLinks).values({ id: token, conversationId: convId, cutoffMessageId: messageId, createdBy: p.user.id });
    await expect(continueSharedConversation(token)).rejects.toThrow("agent backend for bots");
    expect((await m.conversationSnapshot(p, convId)).initialRows).toHaveLength(1);
  });
  it("never substitutes a fallback for an incompatible explicit utility connection", async () => {
    const { utilityApp } = await import("@/lib/llm/apps");
    const original = await m.getSetting("tools");
    try {
      await m.setSetting("tools", { ...original, utilityAppId: manual.id });
      expect(await utilityApp(native)).toBeUndefined();
      await m.setSetting("tools", { ...original, utilityAppId: undefined });
      expect((await utilityApp(native))?.id).toBe(native.id);
      expect(await utilityApp(manual)).toBeUndefined();
    } finally { await m.setSetting("tools", original); }
  });
  it("rejects manual and managed Hermes utility writes, including stale unchanged selections", async () => {
    const { saveToolSettings } = await import("@/app/admin/actions");
    const original = await m.getSetting("tools");
    const form = { ...original, webSearch: { provider: "none" as const } };
    try {
      for (const app of [manual, managed]) {
        await m.setSetting("tools", { ...original, utilityAppId: undefined });
        await expect(saveToolSettings({ ...form, utilityAppId: app.id })).rejects.toThrow("can't be used for background work");
        await m.setSetting("tools", { ...original, utilityAppId: app.id });
        await expect(saveToolSettings({ ...form, utilityAppId: app.id })).rejects.toThrow("can't be used for background work");
      }
    } finally { await m.setSetting("tools", original); }
  });
  it("rejects Hermes default preference writes", async () => {
    const { updatePrefs } = await import("@/app/(chat)/actions");
    const { saveBranding } = await import("@/app/admin/actions");
    await expect(updatePrefs({ defaultAppId: manual.id })).rejects.toThrow("agent backend for bots");
    await expect(saveBranding({ ...branding, defaultAppId: manual.id })).rejects.toThrow("agent backend for bots");
  });
});
