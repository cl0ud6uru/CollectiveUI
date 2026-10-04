import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { aiApps, appAccess, auditLog, bots, groups, providerConnections, users } from "@/db/schema";
import { HttpError, getAccessibleModel } from "@/lib/authz";
import { saveApp, testAppConnection } from "@/app/admin/actions";
import { saveProviderConnection, deleteProviderConnection, migrateAppProviderConnection } from "@/app/admin/provider-actions";
import { openProviderCredential } from "@/lib/llm/provider-connections";
import { providerContextFor, resolveEmbeddingModel, resolveModel } from "@/lib/llm/resolve";
import { sealAppSecret } from "@/lib/llm/secrets";
import { AAD, encrypt } from "@/lib/crypto";
import { userFacingMessage } from "@/lib/llm";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const actor = vi.hoisted(() => ({ id: "", allowed: true }));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => {
  if (!actor.allowed) throw new HttpError(403, "Admin only");
  return { user: { id: actor.id }, isAdmin: true, groupIds: [], canCreateBots: true };
} }));
const run = process.env.DATABASE_URL ? describe : describe.skip;

run("saved OpenAI provider credentials", () => {
  const appIds: string[] = [], connectionIds: string[] = [];
  const prefix = `it-provider-${Date.now()}`;
  const userId = `${prefix}-admin`, groupId = `${prefix}-group`;
  const base = { name: "Fixture model", provider: "openai" as const, model: "fixture-model", supportsVision: false, supportsTools: true, isPublic: false, enabled: true, groupIds: [groupId] };
  async function row(id: string) { return (await db.select().from(aiApps).where(eq(aiApps.id, id)))[0]; }
  async function connection(extra = {}) {
    const value = await saveProviderConnection({ name: "Named fixture", apiKey: "fixture-key-one", enabled: true, ...extra });
    connectionIds.push(value.id); return value;
  }
  async function model(extra = {}) { const result = await saveApp({ ...base, ...extra }); appIds.push(result.id); return row(result.id); }
  beforeAll(async () => {
    actor.id = userId;
    await db.insert(users).values({ id: userId, upn: `${userId}@fixture.invalid`, name: "Fixture admin", authSource: "ldap" });
    await db.insert(groups).values({ id: groupId, name: "Fixture restricted group" });
  });
  afterAll(async () => {
    actor.allowed = true;
    if (appIds.length) await db.delete(aiApps).where(inArray(aiApps.id, appIds));
    if (connectionIds.length) await db.delete(providerConnections).where(inArray(providerConnections.id, connectionIds));
    await db.delete(auditLog).where(eq(auditLog.actorId, userId));
    await db.delete(groups).where(eq(groups.id, groupId));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it("requires admin on every management, migration, model write and test action", async () => {
    actor.allowed = false;
    try {
      await expect(saveProviderConnection({ name: "Denied", apiKey: "fixture", enabled: true })).rejects.toMatchObject({ status: 403 });
      await expect(deleteProviderConnection("missing")).rejects.toMatchObject({ status: 403 });
      await expect(migrateAppProviderConnection("missing", "Denied")).rejects.toMatchObject({ status: 403 });
      await expect(saveApp(base)).rejects.toMatchObject({ status: 403 });
      await expect(testAppConnection({ provider: "openai", providerConnectionId: "missing" })).rejects.toMatchObject({ status: 403 });
    } finally { actor.allowed = true; }
    expect(await db.select().from(providerConnections).where(eq(providerConnections.createdBy, userId))).toHaveLength(0);
  });

  it("reuses one encrypted credential with independent model audiences and fresh rotation/disable", async () => {
    const c = await connection();
    expect(c).not.toHaveProperty("credentialEnc");
    const a = await model({ providerConnectionId: c.id });
    const b = await model({ providerConnectionId: c.id, model: "other-model", isPublic: true, groupIds: [] });
    for (const app of [a, b]) {
      expect(app.apiKeyEnc).toBeNull();
      expect((await providerContextFor(app)).secret).toEqual({ type: "api-key", apiKey: "fixture-key-one" });
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const principal = { user, isAdmin: false, canCreateBots: true, groupIds: [] };
    await expect(getAccessibleModel(principal, a.id)).rejects.toMatchObject({ status: 403 });
    await expect(getAccessibleModel(principal, b.id)).resolves.toMatchObject({ id: b.id });
    await expect(getAccessibleModel({ ...principal, groupIds: [groupId] }, a.id)).resolves.toMatchObject({ id: a.id });
    await saveProviderConnection({ ...c, apiKey: "fixture-key-rotated" });
    // The same previously fetched app rows resolve the replacement on the next request.
    for (const app of [a, b]) expect((await providerContextFor(app)).secret).toEqual({ type: "api-key", apiKey: "fixture-key-rotated" });
    await saveProviderConnection({ ...c, enabled: false });
    await expect(resolveModel(a, { purpose: "chat" })).rejects.toThrow(/disabled/);
    // Shown to the person in chat/background runs instead of a generic error.
    expect(userFacingMessage(await resolveModel(a, { purpose: "chat" }).catch(e => e))).toMatch(/disabled/);
    await expect(resolveModel(b, { purpose: "title", background: true })).rejects.toThrow(/disabled/);
    await expect(resolveEmbeddingModel({ ...a, embeddingModel: "fixture-embed" })).rejects.toThrow(/disabled/);
    await expect(model({ providerConnectionId: c.id })).rejects.toThrow(/disabled/);
    await expect(saveApp({ ...base, id: a.id, providerConnectionId: c.id, enabled: false })).resolves.toMatchObject({ id: a.id });
    await saveProviderConnection({ ...c, enabled: true });
    expect((await providerContextFor(b)).secret).toEqual({ type: "api-key", apiKey: "fixture-key-rotated" });
    const logs = await db.select().from(auditLog).where(eq(auditLog.actorId, userId));
    expect(JSON.stringify(logs)).not.toMatch(/fixture-key-(one|rotated)|credentialEnc|v2\.k0/);
  });

  it("guards dependencies with both an admin check and foreign key, including disabled models", async () => {
    const c = await connection();
    const a = await model({ providerConnectionId: c.id, enabled: false });
    await expect(deleteProviderConnection(c.id)).rejects.toThrow(/1 model/);
    await expect(db.delete(providerConnections).where(eq(providerConnections.id, c.id))).rejects.toThrow();
    await db.delete(aiApps).where(eq(aiApps.id, a.id));
    await deleteProviderConnection(c.id);
    expect(await db.select().from(providerConnections).where(eq(providerConnections.id, c.id))).toHaveLength(0);
  });

  it("pins endpoint/organization/project for save, test and runtime without a network request", async () => {
    const c = await connection({ baseUrl: "https://api.fixture.invalid/v1", organization: "org-fixture", project: "proj-fixture" });
    const a = await model({ providerConnectionId: c.id, baseUrl: c.baseUrl, config: { organization: c.organization!, project: c.project! } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      for (const change of [{ baseUrl: "https://attacker.invalid/v1" }, { config: { organization: "org-fixture", project: "other" } }, { config: { organization: "other", project: "proj-fixture" } }]) {
        await expect(saveApp({ ...base, id: a.id, providerConnectionId: c.id, baseUrl: c.baseUrl, config: a.providerConfig, ...change })).rejects.toThrow(/must match/);
        expect(await testAppConnection({ id: a.id, provider: "openai", providerConnectionId: c.id, baseUrl: c.baseUrl, config: a.providerConfig, ...change })).toMatchObject({ ok: false });
      }
      await expect(saveProviderConnection({ ...c, baseUrl: "https://attacker.invalid/v1", apiKey: "replacement" })).rejects.toThrow(/cannot be changed/);
      expect(fetch).not.toHaveBeenCalled();
      const ctx = await providerContextFor({ ...a, baseUrl: "https://attacker.invalid/v1", providerConfig: { project: "other", reasoning: true } });
      expect(ctx.baseUrl).toBe(c.baseUrl);
      expect(ctx.config).toMatchObject({ organization: "org-fixture", project: "proj-fixture", reasoning: true });
    } finally { vi.unstubAllGlobals(); }
  });

  it("migrates legacy and row-bound secrets explicitly without combining models or changing access", async () => {
    const legacy = await model({ credentials: { apiKey: "fixture-legacy" }, baseUrl: "https://legacy.fixture.invalid/v1", config: { organization: "org-old", project: "proj-old", reasoning: true }, enabled: false });
    const separate = await model({ credentials: { apiKey: "fixture-legacy" }, baseUrl: legacy.baseUrl, config: legacy.providerConfig });
    await db.update(aiApps).set({ apiKeyEnc: encrypt("fixture-legacy", AAD.appApiKey) }).where(eq(aiApps.id, legacy.id));
    const accessBefore = await db.select().from(appAccess).where(eq(appAccess.appId, legacy.id));
    const [{ id }, retried] = await Promise.all([migrateAppProviderConnection(legacy.id, "First migration"), migrateAppProviderConnection(legacy.id, "Repeated migration")]);
    connectionIds.push(id); expect(retried.id).toBe(id);
    const migrated = await row(legacy.id);
    expect(migrated).toEqual({ ...legacy, apiKeyEnc: null, providerConnectionId: id, updatedAt: expect.any(Date) });
    expect(await db.select().from(appAccess).where(eq(appAccess.appId, legacy.id))).toEqual(accessBefore);
    expect((await row(separate.id)).providerConnectionId).toBeNull();
    const [saved] = await db.select().from(providerConnections).where(eq(providerConnections.id, id));
    expect(saved).toMatchObject({ baseUrl: legacy.baseUrl, organization: "org-old", project: "proj-old", createdBy: userId });
    expect(openProviderCredential(saved)).toBe("fixture-legacy");
    expect(saved.credentialEnc).not.toContain("fixture-legacy");
    const second = await migrateAppProviderConnection(separate.id, "Second migration"); connectionIds.push(second.id);
    expect(second.id).not.toBe(id);
    // Old clients that omit the new field retain the existing reference when editing the same provider.
    await saveApp({ ...base, id: separate.id, baseUrl: separate.baseUrl, config: separate.providerConfig });
    expect((await row(separate.id)).providerConnectionId).toBe(second.id);
  });

  it("fails migration atomically on an unreadable key and excludes personal plans/Hermes", async () => {
    const a = await model({ credentials: { apiKey: "fixture-corrupt" } });
    await db.update(aiApps).set({ apiKeyEnc: sealAppSecret("wrong-row", "fixture-corrupt") }).where(eq(aiApps.id, a.id));
    const before = await db.select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.createdBy, userId));
    await expect(migrateAppProviderConnection(a.id, "Corrupt migration")).rejects.toThrow(/could not be decrypted/);
    expect((await row(a.id)).providerConnectionId).toBeNull();
    expect(await db.select({ id: providerConnections.id }).from(providerConnections).where(eq(providerConnections.createdBy, userId))).toEqual(before);
    await db.update(aiApps).set({ apiKeyEnc: sealAppSecret(a.id, "fixture-corrupt") }).where(eq(aiApps.id, a.id));
    for (const provider of ["chatgpt", "hermes"] as const) {
      const [app] = await db.insert(aiApps).values({ name: "Other auth", provider, credentialMode: provider === "chatgpt" ? "user" : "org", model: "fixture", baseUrl: provider === "hermes" ? "http://127.0.0.1:9999" : null }).returning();
      appIds.push(app.id);
      await expect(migrateAppProviderConnection(app.id, "Denied")).rejects.toThrow(/Only an OpenAI/);
    }
  });

  it("invalidates service publication when its model changes saved accounts, but not on key rotation", async () => {
    const { serviceConfigHash } = await import("@/lib/bots/service");
    const first = await connection(), second = await connection();
    const app = await model({ providerConnectionId: first.id });
    const [bot] = await db.insert(bots).values({ ownerId: userId, name: "Fixture service", appId: app.id, executionMode: "service" }).returning();
    try {
      const initial = await serviceConfigHash(bot);
      await saveProviderConnection({ ...first, apiKey: "fixture-key-replacement" });
      expect(await serviceConfigHash(bot)).toBe(initial);
      await saveApp({ ...base, id: app.id, providerConnectionId: second.id });
      expect(await serviceConfigHash(bot)).not.toBe(initial);
    } finally { await db.delete(bots).where(eq(bots.id, bot.id)); }
  });

  it("rewraps saved connection secrets under the primary encryption key", async () => {
    const c = await connection();
    const { rewrapAllSecrets } = await import("@/lib/secrets-rewrap");
    const [stored] = await db.select().from(providerConnections).where(eq(providerConnections.id, c.id));
    vi.stubEnv("ENCRYPTION_KEYS", "next:fixture-encryption-next"); vi.stubEnv("ENCRYPTION_PRIMARY_KID", "next");
    vi.stubEnv("ENCRYPTION_KEY", "dev-only-insecure-key");
    try {
      expect(await rewrapAllSecrets()).toBeGreaterThan(0);
      const [rotated] = await db.select().from(providerConnections).where(eq(providerConnections.id, c.id));
      expect(rotated.credentialEnc).toMatch(/^v2\.next\./);
      expect(openProviderCredential(rotated)).toBe("fixture-key-one");
      expect(rotated.credentialEnc).not.toBe(stored.credentialEnc);
      expect(await rewrapAllSecrets()).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });
});
