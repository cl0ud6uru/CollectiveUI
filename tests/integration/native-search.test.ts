import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { AiApp, Bot, Conversation } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { ToolSettings } from "@/lib/settings";
import { searchResponse } from "../fixtures/openai-search";

const session = vi.hoisted(() => ({ principal: null as unknown as Principal }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal, errorResponse: (err: { message: string; status?: number }) => Response.json({ error: err.message }, { status: err.status ?? 400 }) }));
vi.mock("@/lib/llm/apps", () => ({ utilityApp: async () => undefined, embeddingApp: async () => undefined }));
vi.mock("@/lib/jobs", () => ({ scheduleMemoryExtraction: async () => {}, enqueueRun: async () => {} }));
async function drain<T>(stream: ReadableStream<T>) {
  const chunks: T[] = []; const reader = stream.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) return chunks; chunks.push(value); }
}
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("hosted search database and agent fixtures", () => {
  const prefix = `search-${process.pid}-${Date.now()}`;
  let app: AiApp, bot: Bot, other: Principal, saved: ToolSettings;
  const calls: Record<string, unknown>[] = [];
  const ids: string[] = [];
  let seq = 0;
  const settings = { disabledTools: [], enforcedApproval: [], fetchAllowlist: [], webSearch: { provider: "none" }, maxStepsCap: 5, botCreation: "everyone", nativeSearch: { enabled: true, maxCalls: 2, allowedDomains: ["example.com"] } } satisfies ToolSettings;
  beforeAll(async () => {
    const { db } = await import("@/db");
    const { users, aiApps, bots, botTools } = await import("@/db/schema");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    const { getSetting, setSetting } = await import("@/lib/settings");
    saved = await getSetting("tools");
    await setSetting("tools", settings);
    await db.insert(users).values(["owner", "other"].map(role => ({ id: `${prefix}-${role}`, upn: `${prefix}-${role}`, name: role, authSource: "ldap" as const, prefs: { memoryEnabled: false } })));
    session.principal = (await loadPrincipal(`${prefix}-owner`))!;
    other = (await loadPrincipal(`${prefix}-other`))!;
    [app] = await db.insert(aiApps).values({ id: `${prefix}-app`, name: "Search fixture", provider: "openai", model: "gpt-4.1", supportsTools: true, isPublic: true, apiKeyEnc: sealAppSecret(`${prefix}-app`, "fixture-never-live") }).returning();
    [bot] = await db.insert(bots).values({ id: `${prefix}-bot`, ownerId: session.principal.user.id, appId: app.id, name: "Search One", visibility: "org" }).returning();
    await db.insert(botTools).values({ botId: bot.id, toolKey: "openai_web_search", approval: "auto" });
  });
  afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });
  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { users, aiApps, usageEvents } = await import("@/db/schema");
    const { setSetting } = await import("@/lib/settings");
    await setSetting("tools", saved);
    if (app) await db.delete(usageEvents).where(eq(usageEvents.appId, app.id));
    await db.delete(users).where(inArray(users.id, [`${prefix}-owner`, `${prefix}-other`]));
    if (app) await db.delete(aiApps).where(eq(aiApps.id, app.id));
    await pool.end();
  });
  function fixtureFetch() {
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return searchResponse({ calls: body.tools?.some((t: { type: string }) => t.type === "web_search") ? 1 : 0, id: `${seq++}`, model: body.model });
    });
  }
  async function conversation(mode: "off" | "auto" | null = "auto", botId: string | null = null) {
    const { db } = await import("@/db"); const { conversations } = await import("@/db/schema");
    const [conv] = await db.insert(conversations).values({ userId: `${prefix}-owner`, appId: botId ? null : app.id, botId, title: "Fixture search", nativeSearchMode: mode }).returning();
    ids.push(conv.id); return conv;
  }
  async function turn(conv: Conversation, member: Bot | null = null, history: import("@/lib/chat/store").PortalUIMessage[] = []) {
    const { runTurn } = await import("@/lib/agent/run");
    const { insertMessage } = await import("@/lib/chat/store");
    const { newId } = await import("@/lib/ids");
    const prompt = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "Fixture weather" }] };
    await insertMessage(conv.id, prompt, history.at(-1)?.id ?? null);
    const response = await runTurn({ principal: session.principal, conversation: conv, app, bot: member, history: [...history, prompt], continuation: false, background: true });
    const chunks = await drain(response.stream);
    return { prompt, chunks, ...await response.done };
  }
  it("direct auto streams sources, persists/reloads parts and avoids token double counting", async () => {
    fixtureFetch(); const conv = await conversation(); const result = await turn(conv);
    expect(result.error).toBeUndefined();
    expect(calls[0].max_tool_calls).toBe(2);
    expect(result.chunks.some(c => c.type === "source-url")).toBe(true);
    const { db } = await import("@/db"); const { usageEvents } = await import("@/db/schema");
    const { loadMessageRows, rowToUIMessage } = await import("@/lib/chat/store");
    const rows = await loadMessageRows(conv.id);
    expect(rowToUIMessage(rows.find(r => r.role === "assistant")!).parts).toEqual(result.responseMessage.parts);
    expect(result.responseMessage.parts.some(p => p.type === "source-url")).toBe(true);
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.conversationId, conv.id));
    expect(usage.reduce((n, r) => n + (r.inputTokens ?? 0), 0)).toBe(100);
    expect(usage.reduce((n, r) => n + (r.hostedSearchCalls ?? 0), 0)).toBe(1);
    expect(usage.find(r => r.hostedSearchCalls)?.searchToolCostEstimateMicros).toBe(10000);
  });
  it("off overrides the bot default without changing its legacy tools", async () => {
    fixtureFetch(); const result = await turn(await conversation("off", bot.id), bot);
    expect(result.error).toBeUndefined();
    expect(calls[0].tools).toBeUndefined();
  });
  it.each(["gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol"])("direct Auto and bot defaults persist across requests for %s", async model => {
    const { db } = await import("@/db"); const { aiApps, usageEvents } = await import("@/db/schema");
    const { GET } = await import("@/app/api/chat/native-search/route");
    const { loadMessageRows, rowToUIMessage } = await import("@/lib/chat/store");
    const previous = app;
    [app] = await db.update(aiApps).set({ model }).where(eq(aiApps.id, app.id)).returning();
    fixtureFetch();
    try {
      for (const member of [null, bot]) {
        const conv = await conversation(member ? null : "auto", member?.id ?? null);
        const first = await turn(conv, member);
        const second = await turn(conv, member, [first.prompt, first.responseMessage]);
        expect(first.error).toBeUndefined(); expect(second.error).toBeUndefined();
        const selected = await (await GET(new Request(`http://fixture/api/chat/native-search?conversationId=${conv.id}`))).json();
        expect(selected).toMatchObject({ mode: "auto", reason: null });
        const saved = await loadMessageRows(conv.id);
        const assistants = saved.filter(row => row.role === "assistant");
        expect(assistants).toHaveLength(2);
        expect(assistants.every(row => rowToUIMessage(row).parts.some(part => part.type === "source-url"))).toBe(true);
        const usage = await db.select().from(usageEvents).where(eq(usageEvents.conversationId, conv.id));
        expect(usage.reduce((n, row) => n + (row.hostedSearchCalls ?? 0), 0)).toBe(2);
        expect(usage.reduce((n, row) => n + (row.searchToolCostEstimateMicros ?? 0), 0)).toBe(20000);
        expect(usage.reduce((n, row) => n + (row.inputTokens ?? 0), 0)).toBe(200);
      }
      expect(calls).toHaveLength(4);
      for (const request of calls) {
        expect(request).toMatchObject({ model, max_tool_calls: 2, store: false, include: expect.arrayContaining(["web_search_call.action.sources"]) });
        expect(request.tool_choice ?? "auto").toBe("auto");
        expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: "web_search" })]));
      }
    } finally { await db.update(aiApps).set({ model: previous.model }).where(eq(aiApps.id, app.id)); app = previous; }
  });
  it("owner-only settings persist; failed updates do not change the owner choice", async () => {
    const conv = await conversation("off", bot.id);
    const { GET, PATCH } = await import("@/app/api/chat/native-search/route");
    const patch = (mode: string) => PATCH(new Request("http://fixture/api/chat/native-search", { method: "PATCH", body: JSON.stringify({ conversationId: conv.id, mode }) }));
    expect((await patch("auto")).status).toBe(200);
    expect(await (await GET(new Request(`http://fixture/api/chat/native-search?conversationId=${conv.id}`))).json()).toMatchObject({ mode: "auto", reason: null });
    const owner = session.principal; session.principal = other;
    try {
      expect((await patch("off")).status).toBe(404);
      expect((await GET(new Request(`http://fixture/api/chat/native-search?conversationId=${conv.id}`))).status).toBe(404);
    } finally { session.principal = owner; }
    const { setSetting } = await import("@/lib/settings");
    await setSetting("tools", { ...settings, enforcedApproval: ["web_search"] });
    expect((await patch("auto")).status).toBe(403);
    await setSetting("tools", settings);
  });
  it("checks the saved connection endpoint and enabled state, not a shadow app URL", async () => {
    const { db } = await import("@/db"); const { providerConnections } = await import("@/db/schema");
    const { nativeSearchAvailability } = await import("@/lib/agent/native-search");
    const id = `${prefix}-connection`;
    await db.insert(providerConnections).values({ id, name: "Fixture connection", baseUrl: "https://custom.invalid/v1", credentialEnc: "unused-fixture" });
    const connected = { ...app, baseUrl: null, providerConnectionId: id };
    try {
      expect(await nativeSearchAvailability(connected, settings)).toContain("custom endpoints");
      await db.update(providerConnections).set({ baseUrl: null, enabled: false }).where(eq(providerConnections.id, id));
      expect(await nativeSearchAvailability(connected, settings)).toContain("unavailable");
      await db.update(providerConnections).set({ enabled: true }).where(eq(providerConnections.id, id));
      expect(await nativeSearchAvailability(connected, settings)).toBeNull();
    } finally { await db.delete(providerConnections).where(eq(providerConnections.id, id)); }
  });
  it("native off and auto preserve explicitly selected legacy search tools", async () => {
    const { db } = await import("@/db"); const { botTools } = await import("@/db/schema");
    const { buildToolset } = await import("@/lib/agent/toolset");
    await db.insert(botTools).values({ botId: bot.id, toolKey: "web_search", approval: "auto" });
    try {
      for (const nativeSearchMode of ["off", "auto"] as const) {
        const tools = await buildToolset({ principal: session.principal, conversationId: (await conversation(nativeSearchMode, bot.id)).id, app, bot, depth: 0, background: false, toolSettings: settings, nativeSearchMode });
        expect(tools.tools.web_search).toBeDefined();
        expect(Boolean(tools.tools.openai_web_search)).toBe(nativeSearchMode === "auto");
        await tools.close();
      }
    } finally {
      const { and } = await import("drizzle-orm");
      await db.delete(botTools).where(and(eq(botTools.botId, bot.id), eq(botTools.toolKey, "web_search")));
    }
  });
  it("reservations serialize, survive a lost response, and cannot cross conversation owners", async () => {
    const conv = await conversation();
    const { durableSearchBudget } = await import("@/lib/llm/native-search");
    const ctx = { purpose: "chat" as const, billingSource: "org" as const, providerKind: "openai" as const, model: app.model, appId: app.id, conversationId: conv.id, scope: { pending: [], messageId: `${prefix}-budget` } };
    const budget = durableSearchBudget(ctx, 2);
    expect((await Promise.all([budget.reserve(), budget.reserve()])).sort()).toEqual([0, 2]);
    expect(await durableSearchBudget(ctx, 2).reserve()).toBe(0);
    await budget.settle(2, 1);
    expect(await budget.reserve()).toBe(1);
    await expect(durableSearchBudget({ ...ctx, conversationId: (await conversation()).id }, 2).reserve()).rejects.toThrow("budget is unavailable");
  });
  it("group speakers forward sources and share one call allowance", async () => {
    fixtureFetch(); const conv = await conversation();
    const { db } = await import("@/db"); const { bots, botTools, conversations, conversationBots } = await import("@/db/schema");
    const [second] = await db.insert(bots).values({ ownerId: session.principal.user.id, appId: app.id, name: "Search Two", visibility: "org" }).returning();
    await db.insert(botTools).values({ botId: second.id, toolKey: "openai_web_search", approval: "auto" });
    await db.update(conversations).set({ isGroup: true }).where(eq(conversations.id, conv.id));
    await db.insert(conversationBots).values([{ conversationId: conv.id, botId: bot.id, position: 0 }, { conversationId: conv.id, botId: second.id, position: 1 }]);
    const { GET, PATCH } = await import("@/app/api/chat/native-search/route");
    for (const mode of ["off", "auto"]) {
      expect((await PATCH(new Request("http://fixture/api/chat/native-search", { method: "PATCH", body: JSON.stringify({ conversationId: conv.id, mode }) }))).status).toBe(200);
      expect(await (await GET(new Request(`http://fixture/api/chat/native-search?conversationId=${conv.id}`))).json()).toMatchObject({ mode, reason: null });
    }
    const { runGroupTurn } = await import("@/lib/agent/group");
    const stream = await runGroupTurn({ principal: session.principal, conversation: { ...conv, isGroup: true }, members: [{ bot, app }, { bot: second, app }], history: [{ id: `${prefix}-group-prompt`, role: "user", parts: [{ type: "text", text: "@Search One @Search Two fixture weather" }] }] });
    const chunks = await drain(stream);
    expect(calls.map(c => c.max_tool_calls)).toEqual([2, 1]);
    expect(chunks.filter(c => c.type === "source-url")).toHaveLength(2);
    const { loadMessageRows } = await import("@/lib/chat/store");
    const rows = await loadMessageRows(conv.id);
    expect(rows.find(r => r.role === "assistant")?.parts.filter(p => (p as { type: string }).type === "source-url")).toHaveLength(2);
  });
});
