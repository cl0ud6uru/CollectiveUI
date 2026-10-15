import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedProviderKind } from "@/lib/llm/catalog";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, allowed: true }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/session", () => ({ requireAdmin: async () => {
  if (!fixture.allowed) throw Object.assign(new Error("Admin only"), { status: 403 });
  return { user: { id: "admin" }, isAdmin: true, groupIds: [], canCreateBots: true };
} }));
import { db, schema } from "@/db";
import { saveApp, testAppConnection } from "@/app/admin/actions";
import { saveProviderConnection, deleteProviderConnection, migrateAppProviderConnection } from "@/app/admin/provider-actions";
import { getAccessibleModel } from "@/lib/authz";
import { openProviderCredential } from "@/lib/llm/provider-connections";
import { providerContextFor, resolveEmbeddingModel, resolveModel } from "@/lib/llm/resolve";
import { sealAppSecret } from "@/lib/llm/secrets";
import { serviceConfigHash } from "@/lib/bots/service";

const baseUrl = "https://provider.example/api/v1";
const modelInput = (provider: SavedProviderKind) => ({ name: "Synthetic model", provider, baseUrl, model: "fixture/model", config: {}, supportsTools: true, supportsVision: false, isPublic: true, enabled: true });
const row = async (id: string) => (await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, id)))[0];
const connection = async (provider: SavedProviderKind) => saveProviderConnection({ provider, name: "Synthetic provider", baseUrl, apiKey: "synthetic-provider-one", enabled: true });

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(file => file.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 60000);
beforeEach(async () => {
  fixture.allowed = true;
  vi.stubEnv("ENCRYPTION_KEY", "synthetic-provider-fixture-only");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External network forbidden in provider fixture"); }));
  await fixture.client!.exec("TRUNCATE users, ai_apps, provider_connections, settings, groups, audit_log CASCADE");
  await db.insert(schema.users).values({ id: "admin", upn: "admin@fixture.invalid", name: "Synthetic administrator", authSource: "local", identityRealm: "local", isAdmin: true });
  await db.insert(schema.groups).values({ id: "audience", name: "Synthetic audience" });
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.each(["openai", "openai-compatible"] as const)("saved %s credentials through production actions and runtime", provider => {
  it("requires administrator authorization for all credential and model actions", async () => {
    fixture.allowed = false;
    await expect(connection(provider)).rejects.toMatchObject({ status: 403 });
    await expect(saveApp(modelInput(provider))).rejects.toMatchObject({ status: 403 });
    await expect(testAppConnection({ provider, providerConnectionId: "missing" })).rejects.toMatchObject({ status: 403 });
    await expect(deleteProviderConnection("missing")).rejects.toMatchObject({ status: 403 });
    await expect(migrateAppProviderConnection("missing", "Denied")).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.providerConnections)).toEqual([]);
  });

  it("reuses encrypted credentials with separate model audiences, rotation, disable and deletion guards", async () => {
    const c = await connection(provider);
    expect(c).not.toHaveProperty("credentialEnc");
    expect(JSON.stringify(c)).not.toContain("synthetic-provider-one");
    const first = await row((await saveApp({ ...modelInput(provider), providerConnectionId: c.id, isPublic: false, groupIds: ["audience"] })).id);
    const second = await row((await saveApp({ ...modelInput(provider), providerConnectionId: c.id })).id);
    const [user] = await db.select().from(schema.users);
    const member = { user, isAdmin: false, groupIds: [], canCreateBots: true };
    await expect(getAccessibleModel(member, first.id)).rejects.toMatchObject({ status: 403 });
    await expect(getAccessibleModel(member, second.id)).resolves.toMatchObject({ id: second.id });
    for (const app of [first, second]) {
      expect(app.apiKeyEnc).toBeNull();
      expect((await providerContextFor(app)).secret).toEqual({ type: "api-key", apiKey: "synthetic-provider-one" });
      const resolution = await resolveModel(app, { purpose: "chat" });
      expect(resolution.model.provider).toContain(provider === "openai" ? "openai.responses" : `app-${app.id}`);
    }
    await saveProviderConnection({ ...c, apiKey: "synthetic-provider-two" });
    for (const app of [first, second]) expect((await providerContextFor(app)).secret).toEqual({ type: "api-key", apiKey: "synthetic-provider-two" });
    await saveProviderConnection({ ...c, enabled: false });
    await expect(resolveModel(first, { purpose: "chat" })).rejects.toThrow(/disabled/);
    await expect(resolveModel(second, { purpose: "title", background: true })).rejects.toThrow(/disabled/);
    await expect(resolveEmbeddingModel({ ...first, embeddingModel: "fixture/embedding" })).rejects.toThrow(/disabled/);
    await expect(saveApp({ ...modelInput(provider), providerConnectionId: c.id })).rejects.toThrow(/disabled/);
    await saveProviderConnection({ ...c, enabled: true });
    await expect(deleteProviderConnection(c.id)).rejects.toThrow(/2 model/);
    await expect(db.delete(schema.providerConnections).where(eq(schema.providerConnections.id, c.id))).rejects.toThrow();
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toMatch(/synthetic-provider-(one|two)|credentialEnc|v2\.k0/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pins API type and exact destination, blocks credential injection and checks before any request", async () => {
    const c = await connection(provider);
    const app = await row((await saveApp({ ...modelInput(provider), providerConnectionId: c.id })).id);
    for (const target of ["https://other.example/v1", "https://provider.example/other/v1"]) {
      await expect(saveApp({ ...modelInput(provider), id: app.id, providerConnectionId: c.id, baseUrl: target })).rejects.toThrow(/must match/);
      expect(await testAppConnection({ provider, providerConnectionId: c.id, baseUrl: target, config: {} })).toMatchObject({ ok: false });
      await expect(saveProviderConnection({ ...c, baseUrl: target, apiKey: "synthetic-replacement" })).rejects.toThrow(/cannot be changed/);
    }
    const other = provider === "openai" ? "openai-compatible" : "openai";
    await expect(saveProviderConnection({ ...c, provider: other })).rejects.toThrow(/cannot be changed/);
    await expect(saveApp({ ...modelInput(other), providerConnectionId: c.id })).rejects.toThrow(/API type/);
    await expect(providerContextFor({ ...app, provider: other })).rejects.toMatchObject({ detail: "saved provider connection kind mismatch" });
    await expect(saveApp({ ...modelInput(provider), providerConnectionId: c.id, credentials: { apiKey: "synthetic-injected" } })).rejects.toThrow(/Rotate/);
    expect(await testAppConnection({ provider, providerConnectionId: c.id, baseUrl, credentials: { apiKey: "synthetic-injected" } })).toMatchObject({ ok: false });
    expect((await providerContextFor({ ...app, baseUrl: "https://other.example/v1" })).baseUrl).toBe(c.baseUrl);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects operation endpoints before saving or testing and lists the correct base route with synthetic fetch", async () => {
    for (const route of ["chat/completions", "responses", "models", "embeddings"]) {
      const bad = `${baseUrl}/${route}`;
      await expect(saveProviderConnection({ provider, name: "Invalid", baseUrl: bad, apiKey: "synthetic-unused", enabled: true })).rejects.toThrow(/API base URL/);
      await expect(saveApp({ ...modelInput(provider), baseUrl: bad, credentials: { apiKey: "synthetic-unused" } })).rejects.toThrow(/API base URL/);
      expect(await testAppConnection({ provider, baseUrl: bad, credentials: { apiKey: "synthetic-unused" } })).toMatchObject({ ok: false });
    }
    expect(fetch).not.toHaveBeenCalled();
    const c = await connection(provider);
    const syntheticFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "fixture/model" }] }));
    vi.stubGlobal("fetch", syntheticFetch);
    expect(await testAppConnection({ provider, providerConnectionId: c.id, baseUrl, config: {} })).toMatchObject({ ok: true, models: ["fixture/model"] });
    expect(syntheticFetch.mock.calls[0][0]).toBe(`${baseUrl}/models`);
  });

  it("explicitly migrates one legacy model and carries current service publication without changing its destination or audience", async () => {
    const app = await row((await saveApp({ ...modelInput(provider), credentials: { apiKey: "synthetic-legacy" }, isPublic: false, groupIds: ["audience"] })).id);
    const [bot] = await db.insert(schema.bots).values({ ownerId: "admin", name: "Synthetic service", appId: app.id, executionMode: "service" }).returning();
    await db.update(schema.bots).set({ publishedRevision: bot.revision, publishedConfigHash: await serviceConfigHash(bot) }).where(eq(schema.bots.id, bot.id));
    const { id } = await migrateAppProviderConnection(app.id, "Explicit fixture migration");
    expect(await migrateAppProviderConnection(app.id, "Retry")).toEqual({ id });
    const after = await row(app.id);
    expect(after).toEqual({ ...app, apiKeyEnc: null, providerConnectionId: id, updatedAt: expect.any(Date) });
    const [saved] = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.id, id));
    expect(saved).toMatchObject({ provider, baseUrl: app.baseUrl });
    expect(openProviderCredential(saved)).toBe("synthetic-legacy");
    const [published] = await db.select().from(schema.bots).where(eq(schema.bots.id, bot.id));
    expect(await serviceConfigHash(published)).toBe(published.publishedConfigHash);
    expect(await db.select().from(schema.appAccess).where(eq(schema.appAccess.appId, app.id))).toMatchObject([{ groupId: "audience" }]);
    await db.update(schema.aiApps).set({ apiKeyEnc: sealAppSecret(app.id, "synthetic-other"), providerConnectionId: null, baseUrl: `${baseUrl}/chat/completions` }).where(eq(schema.aiApps.id, app.id));
    await expect(migrateAppProviderConnection(app.id, "Invalid legacy endpoint")).rejects.toThrow(/API base URL/);
  });
});

it("defaults older provider-save calls to OpenAI and refuses compatible billing selectors and personal/runtime reuse", async () => {
  expect(await saveProviderConnection({ name: "Legacy caller", apiKey: "synthetic-default", enabled: true })).toMatchObject({ provider: "openai", baseUrl: null });
  await expect(saveProviderConnection({ provider: "openai-compatible", name: "Invalid billing", baseUrl, organization: "org-fixture", apiKey: "synthetic-unused", enabled: true })).rejects.toThrow(/billing selectors/);
  const c = await connection("openai-compatible");
  for (const provider of ["chatgpt", "hermes", "anthropic"] as const) {
    await expect(saveApp({ ...modelInput("openai"), provider, providerConnectionId: c.id })).rejects.toThrow();
    expect(await testAppConnection({ provider, providerConnectionId: c.id })).toMatchObject({ ok: false });
  }
});

it("retains a malformed legacy destination while permitting administrative disable and rotation", async () => {
  const [stored] = await db.insert(schema.providerConnections).values({ id: "legacy-bad", name: "Retained malformed fixture", baseUrl: `${baseUrl}/chat/completions`, credentialEnc: "opaque-unused-fixture", createdBy: "admin" }).returning();
  const view = { id: stored.id, name: stored.name, provider: stored.provider, baseUrl: stored.baseUrl, organization: null, project: null, enabled: false };
  await saveProviderConnection(view);
  await saveProviderConnection({ ...view, apiKey: "synthetic-rotated-legacy" });
  const [after] = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.id, stored.id));
  expect(after).toMatchObject({ baseUrl: stored.baseUrl, provider: stored.provider, enabled: false });
  expect(openProviderCredential(after)).toBe("synthetic-rotated-legacy");
  await expect(saveProviderConnection({ ...view, baseUrl: baseUrl })).rejects.toThrow(/cannot be changed/);
  await expect(saveApp({ ...modelInput("openai"), providerConnectionId: stored.id, baseUrl: stored.baseUrl })).rejects.toThrow(/must match/);
  expect(fetch).not.toHaveBeenCalled();
});

it("saves OpenRouter models with reusable credentials and tests the key without inference or public-catalog false positives", async () => {
  const provider = "openrouter" as const;
  const baseUrl = "https://openrouter.ai/api/v1";
  const c = await saveProviderConnection({ provider, name: "Synthetic OpenRouter", apiKey: "synthetic-openrouter", enabled: true });
  expect(c).toMatchObject({ provider, baseUrl, organization: null, project: null });
  expect(c).not.toHaveProperty("credentialEnc");
  const input = { ...modelInput(provider), baseUrl, providerConnectionId: c.id, model: "vendor/catalog-model" };
  const app = await row((await saveApp(input)).id);
  expect(app).toMatchObject({ provider, model: input.model, baseUrl, apiKeyEnc: null, providerConnectionId: c.id });
  const resolved = await resolveModel(app, { purpose: "chat" });
  expect(resolved.model.provider).toContain(`app-${app.id}`);
  expect(fetch).not.toHaveBeenCalled();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { label: "Synthetic key" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await testAppConnection({ provider, providerConnectionId: c.id, baseUrl })).toMatchObject({ ok: true, models: [], note: expect.stringContaining("generation have not been tested") });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/key`, expect.objectContaining({ headers: { Authorization: "Bearer synthetic-openrouter" }, redirect: "error" }));
  fetcher.mockClear();
  fetcher.mockResolvedValue(new Response(null, { status: 401 }));
  expect(await testAppConnection({ provider, providerConnectionId: c.id, baseUrl })).toMatchObject({ ok: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockClear();
  await expect(saveApp({ ...input, model: " " })).rejects.toThrow();
  await expect(saveApp({ ...input, baseUrl: `${baseUrl}/chat/completions` })).rejects.toThrow();
  await expect(saveProviderConnection({ ...c, provider: "openai-compatible", apiKey: "synthetic-unused" })).rejects.toThrow(/cannot be changed/);
  await expect(saveProviderConnection({ provider, name: "Wrong billing", organization: "org-unused", apiKey: "synthetic-unused", enabled: true })).rejects.toThrow(/billing selectors/);
  expect(fetcher).not.toHaveBeenCalled();
  await saveProviderConnection({ ...c, enabled: false });
  await expect(resolveModel(app, { purpose: "chat" })).rejects.toThrow(/disabled/);
  expect(await testAppConnection({ provider, providerConnectionId: c.id, baseUrl })).toMatchObject({ ok: false });
  expect(fetcher).not.toHaveBeenCalled();
});
