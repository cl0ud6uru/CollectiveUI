import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Server actions run as an admin (the real session layer needs a request).
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const admin = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/session", () => ({
  requireAdmin: async () => ({ user: { id: admin.id, upn: `${admin.id}@corp.local` }, isAdmin: true, groupIds: [], canCreateBots: true }),
}));
let adminId = "";
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("admin app actions (integration)", () => {
  const created: string[] = [];
  let originalTools: unknown;
  let originalChatGPT: unknown;

  beforeAll(async () => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { getSetting } = await import("@/lib/settings");
    adminId = `it-admin-${process.pid}-${Date.now()}`;
    admin.id = adminId;
    await db.insert(users).values({ id: adminId, upn: `${adminId}@corp.local`, name: "IT Admin", authSource: "ldap" });
    originalTools = await getSetting("tools");
    originalChatGPT = await getSetting("chatgpt");
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { aiApps, auditLog, users } = await import("@/db/schema");
    const { setSetting } = await import("@/lib/settings");
    await setSetting("tools", originalTools as never);
    await setSetting("chatgpt", originalChatGPT as never);
    const { bots } = await import("@/db/schema");
    if (created.length) await db.delete(bots).where(inArray(bots.appId, created));
    if (created.length) await db.delete(aiApps).where(inArray(aiApps.id, created));
    await db.delete(auditLog).where(eq(auditLog.actorId, adminId));
    await db.delete(users).where(eq(users.id, adminId));
    await pool.end();
  });

  const base = { supportsVision: false, supportsTools: true, isPublic: true, enabled: true, sortOrder: 99, groupIds: [] };

  it("a Hermes profile app keeps its key sealed, gets a bot, and is never used for background work", async () => {
    const { saveApp } = await import("@/app/admin/actions");
    const { db } = await import("@/db");
    const { aiApps, bots } = await import("@/db/schema");
    const { openAppSecret } = await import("@/lib/llm/secrets");
    const { isEligibleUtilityApp } = await import("@/lib/llm/catalog");
    const { resolveModel } = await import("@/lib/llm");
    const key = "hermes-profile-key-it-0123456789";
    const r = await saveApp({
      ...base,
      supportsTools: false,
      name: "IT Hermes",
      provider: "hermes",
      baseUrl: "http://127.0.0.1:8642/p/coder/v1",
      model: "coder",
      temperature: 0.7,
      config: { profile: "coder", approvalTimeoutSec: 300 },
      credentials: { apiKey: key },
    });
    created.push(r.id);
    const [row] = await db.select().from(aiApps).where(eq(aiApps.id, r.id));
    expect(row).toMatchObject({ provider: "hermes", credentialMode: "org", baseUrl: "http://127.0.0.1:8642", supportsTools: true, temperature: null });
    expect(row.providerConfig).toEqual({ profile: "coder", approvalTimeoutSec: 300, allowedModels: "" });
    expect(openAppSecret(row)).toBe(key);
    expect(row.apiKeyEnc).not.toContain(key);

    // Its bot is created with it, and only once.
    const [bot] = await db.select().from(bots).where(eq(bots.appId, r.id));
    expect(bot).toMatchObject({ id: r.botId, name: "IT Hermes", label: "Hermes", visibility: "org" });
    expect(bot.avatar).toMatch(/^blob:[a-z]+:[a-z]+$/);
    await saveApp({ ...base, id: r.id, name: "IT Hermes", provider: "hermes", baseUrl: "http://127.0.0.1:8642", model: "coder", config: { profile: "coder", approvalTimeoutSec: 300 } });
    expect(await db.select().from(bots).where(eq(bots.appId, r.id))).toHaveLength(1);

    // The key belongs to the profile: pointing the app at another profile needs that profile's key.
    await expect(
      saveApp({ ...base, id: r.id, name: "IT Hermes", provider: "hermes", baseUrl: "http://127.0.0.1:8642", model: "writer", config: { profile: "writer", approvalTimeoutSec: 300 } }),
    ).rejects.toThrow(/Re-enter the credentials/);

    // Titles, memory and drafts never run on it.
    expect(isEligibleUtilityApp(row)).toBe(false);
    await expect(resolveModel(row, { purpose: "title" })).rejects.toThrow(/background work/);

    // A plain-http key outside the private network is refused.
    await expect(
      saveApp({ ...base, name: "IT Hermes public", provider: "hermes", baseUrl: "http://93.184.216.34:8642", model: "coder", config: { profile: "" }, credentials: { apiKey: key } }),
    ).rejects.toThrow(/https/);
  });

  it("saves an Anthropic app with company credentials bound to its row", async () => {
    const { saveApp } = await import("@/app/admin/actions");
    const { db } = await import("@/db");
    const { aiApps } = await import("@/db/schema");
    const { openAppSecret } = await import("@/lib/llm/secrets");
    const { id } = await saveApp({ ...base, name: "IT Claude", provider: "anthropic", model: "claude-sonnet-4-5", credentials: { apiKey: "sk-ant-api03-it" } });
    created.push(id);
    const [row] = await db.select().from(aiApps).where(eq(aiApps.id, id));
    expect(row).toMatchObject({ provider: "anthropic", credentialMode: "org", kind: "model", baseUrl: null });
    expect(row.providerConfig).toEqual({ reasoning: false, promptCaching: true });
    expect(openAppSecret(row)).toBe("sk-ant-api03-it");
    expect(row.apiKeyEnc).not.toContain("sk-ant");

    // Editing without re-entering the key keeps it…
    await saveApp({ ...base, id, name: "IT Claude 2", provider: "anthropic", model: "claude-sonnet-4-5" });
    const [kept] = await db.select().from(aiApps).where(eq(aiApps.id, id));
    expect(openAppSecret(kept)).toBe("sk-ant-api03-it");

    // …but pointing it somewhere else requires the key again.
    await expect(
      saveApp({ ...base, id, name: "IT Claude", provider: "anthropic", baseUrl: "https://attacker.example.com/v1", model: "claude-sonnet-4-5" }),
    ).rejects.toThrow(/Re-enter/);
    await expect(saveApp({ ...base, id, name: "IT Claude", provider: "openai", model: "gpt-5" })).rejects.toThrow(/Re-enter/);
  });

  it("rejects native apps without credentials", async () => {
    const { saveApp } = await import("@/app/admin/actions");
    await expect(saveApp({ ...base, name: "IT OpenAI", provider: "openai", model: "gpt-5" })).rejects.toThrow(/Enter the credentials/);
  });

  it("ChatGPT plan apps need the feature on (acknowledged once), and never keep company credentials", async () => {
    const { saveApp, saveChatGPTSettings } = await import("@/app/admin/actions");
    const { db } = await import("@/db");
    const { aiApps } = await import("@/db/schema");
    const { getSetting, setSetting } = await import("@/lib/settings");
    await setSetting("chatgpt", { ...(await getSetting("chatgpt")), enabled: false, acknowledgedAt: undefined, acknowledgedBy: undefined });
    const gpt = { ...base, name: "IT GPT", provider: "chatgpt" as const, model: "gpt-5.1-codex", temperature: 0.5, maxTokens: 100 };
    await expect(saveApp(gpt)).rejects.toThrow(/Turn on Sign in with ChatGPT/);

    const settings = { enabled: true, access: "selected" as const, allowedGroupIds: [], allowedUpns: [" Jane@Corp.Local ", ""], allowedWorkspaceIds: [], allowPersonalPlans: true, allowBackground: false };
    await expect(saveChatGPTSettings(settings)).rejects.toThrow(/read the notice/);
    await saveChatGPTSettings({ ...settings, acknowledge: true });
    expect(await getSetting("chatgpt")).toMatchObject({ enabled: true, acknowledgedBy: `${adminId}@corp.local`, allowedUpns: ["jane@corp.local"] });

    const { id } = await saveApp(gpt);
    created.push(id);
    const [row] = await db.select().from(aiApps).where(eq(aiApps.id, id));
    expect(row).toMatchObject({ provider: "chatgpt", credentialMode: "user", baseUrl: null, apiKeyEnc: null, temperature: null, maxTokens: null });
    expect(row.providerConfig).toEqual({ reasoningEffort: "default" });

    // Switching a company app to a ChatGPT plan app drops its stored key.
    const { id: claudeId } = await saveApp({ ...base, name: "IT Switch", provider: "anthropic", model: "claude-sonnet-4-5", credentials: { apiKey: "sk-ant-api03-x" } });
    created.push(claudeId);
    await saveApp({ ...gpt, id: claudeId, name: "IT Switch" });
    const [switched] = await db.select().from(aiApps).where(eq(aiApps.id, claudeId));
    expect(switched).toMatchObject({ provider: "chatgpt", credentialMode: "user", apiKeyEnc: null });

    // Existing ChatGPT apps stay editable after the feature is turned off (e.g. to disable them).
    await saveChatGPTSettings({ ...settings, enabled: false });
    await saveApp({ ...gpt, id, enabled: false });
  });

  it("Test connection never sends the stored key to a changed endpoint", async () => {
    const { saveApp, testAppConnection } = await import("@/app/admin/actions");
    const { id } = await saveApp({ ...base, name: "IT OpenAI", provider: "openai", model: "gpt-5", credentials: { apiKey: "sk-it-openai" } });
    created.push(id);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await testAppConnection({ id, provider: "openai", baseUrl: "https://attacker.example.com/v1", config: {}, credentials: {} });
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/Re-enter/) });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("background apps must be eligible when newly chosen; an unchanged selection still saves", async () => {
    const { saveApp, saveToolSettings } = await import("@/app/admin/actions");
    const { getSetting, setSetting } = await import("@/lib/settings");
    const { id: claude } = await saveApp({ ...base, name: "IT Claude embed", provider: "anthropic", model: "claude-x", credentials: { apiKey: "sk-ant-api03-x" } });
    created.push(claude);
    const current = await getSetting("tools");
    const form = { ...current, webSearch: { provider: current.webSearch.provider } };
    await expect(saveToolSettings({ ...form, embeddingAppId: claude })).rejects.toThrow(/embeddings/);
    // Simulate a stored selection that became ineligible: saving the rest of the form must still work.
    await setSetting("tools", { ...current, embeddingAppId: claude });
    await expect(saveToolSettings({ ...form, embeddingAppId: claude, maxStepsCap: 24 })).resolves.toBeUndefined();
  });
});
