import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  f.client = new PGlite();
  return { db: drizzle(f.client, { schema }), schema };
});
vi.mock("@/lib/billing/secrets", () => ({ rewrapBillingSecrets: async () => 0 }));
vi.mock("@/lib/remote-hermes/store", () => ({ rewrapRemoteHermesSecrets: async () => 0 }));
vi.mock("@/lib/llm/chatgpt/store", () => ({ rewrapChatGPTSecrets: async () => 0 }));
vi.mock("@/lib/mcp/member-connections", () => ({ rewrapMemberMcpSecrets: async () => 0 }));

import { db, schema } from "@/db";
import { AAD, decrypt, encrypt } from "@/lib/crypto";
import { rewrapAllSecrets } from "@/lib/secrets-rewrap";

beforeAll(async () => {
  await f.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await f.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 60_000);
beforeEach(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "");
  vi.stubEnv("ENCRYPTION_KEYS", "old:synthetic-old-key,new:synthetic-new-key");
  vi.stubEnv("ENCRYPTION_PRIMARY_KID", "old");
  await f.client!.exec("TRUNCATE users, ai_apps, mcp_servers, settings CASCADE");
  await db.insert(schema.users).values({ id: "owner", upn: "owner@fixture.invalid", name: "Owner", authSource: "local", identityRealm: "local" });
  await db.insert(schema.bots).values({ id: "bot", ownerId: "owner", name: "Fixture bot" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await f.client!.close(); });

const rotate = () => vi.stubEnv("ENCRYPTION_PRIMARY_KID", "new");
const readTokens = async () => (await db.select().from(schema.userTokens))[0];
const readSettings = async () => (await db.select().from(schema.settings))[0]?.value as Record<string, unknown> | undefined;
const seedTokens = (refresh = true) => db.insert(schema.userTokens).values({ userId: "owner", accessTokenEnc: encrypt("old-access", AAD.userAccessToken),
  refreshTokenEnc: refresh ? encrypt("old-refresh", AAD.userRefreshToken) : null, expiresAt: new Date("2030-01-01"), scope: "old-scope" });
const seedMcp = () => db.insert(schema.mcpServers).values({ id: "mcp", name: "Fixture", url: "https://fixture.invalid/mcp", headersEnc: encrypt("old-headers", AAD.mcpHeaders) });
const seedRoutine = () => db.insert(schema.routines).values({ id: "routine", ownerId: "owner", botId: "bot", name: "Fixture", prompt: "hello", triggerType: "webhook", webhookSecret: "old-plaintext-webhook" });

/** Execute an independent writer after the SELECT resolves but before the rewrapper receives its stale rows. */
function afterScan(table: unknown, mutate: () => Promise<unknown>) {
  const select = db.select.bind(db);
  let fired = false;
  vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof db.select>) => {
    const builder = select(...args), from = builder.from.bind(builder);
    builder.from = ((target: Parameters<typeof builder.from>[0]) => {
      const query = from(target);
      if (target !== table || fired) return query;
      const then = query.then.bind(query);
      query.then = ((resolve, reject) => then(async rows => {
        if (!fired) { fired = true; await mutate(); }
        return rows;
      }).then(resolve, reject)) as typeof query.then;
      return query;
    }) as typeof builder.from;
    return builder;
  }) as typeof db.select);
  return () => expect(fired).toBe(true);
}

describe("startup secret rewrap concurrency", () => {
  it("rotates each unchanged row and remains idempotent", async () => {
    await seedMcp(); await seedRoutine(); await seedTokens();
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: ["workspace"], webSearch: { provider: "brave", apiKeyEnc: encrypt("old-search", AAD.webSearchKey) } } });
    rotate();
    expect(await rewrapAllSecrets()).toBe(4);
    expect(decrypt((await db.select().from(schema.mcpServers))[0].headersEnc!, AAD.mcpHeaders)).toBe("old-headers");
    expect(decrypt((await db.select().from(schema.routines))[0].webhookSecret!, AAD.routineWebhookSecret)).toBe("old-plaintext-webhook");
    const tokens = await readTokens();
    expect(tokens.accessTokenEnc).toMatch(/^v2\.new\./); expect(tokens.refreshTokenEnc).toMatch(/^v2\.new\./);
    expect(decrypt(tokens.accessTokenEnc, AAD.userAccessToken)).toBe("old-access");
    expect(decrypt(tokens.refreshTokenEnc!, AAD.userRefreshToken)).toBe("old-refresh");
    expect(await rewrapAllSecrets()).toBe(0);
  });

  it.each(["replacement", "revocation"])("preserves MCP header %s after the scan", async action => {
    await seedMcp(); rotate(); const replacement = action === "replacement" ? encrypt("new-headers", AAD.mcpHeaders) : null;
    const checked = afterScan(schema.mcpServers, () => db.update(schema.mcpServers).set({ headersEnc: replacement }).where(eq(schema.mcpServers.id, "mcp")));
    expect(await rewrapAllSecrets()).toBe(0); checked();
    expect((await db.select().from(schema.mcpServers))[0].headersEnc).toBe(replacement);
  });

  it.each(["replacement", "revocation"])("preserves webhook %s after the scan", async action => {
    await seedRoutine(); rotate(); const replacement = action === "replacement" ? encrypt("new-webhook", AAD.routineWebhookSecret) : null;
    const checked = afterScan(schema.routines, () => db.update(schema.routines).set({ webhookSecret: replacement }).where(eq(schema.routines.id, "routine")));
    expect(await rewrapAllSecrets()).toBe(0); checked();
    expect((await db.select().from(schema.routines))[0].webhookSecret).toBe(replacement);
  });

  it.each([true, false])("preserves a concurrently refreshed token pair (previous refresh token=%s)", async hadRefresh => {
    await seedTokens(hadRefresh); rotate();
    const replacement = { accessTokenEnc: encrypt("new-access", AAD.userAccessToken), refreshTokenEnc: encrypt("new-refresh", AAD.userRefreshToken),
      expiresAt: new Date("2031-01-01"), scope: "new-scope" };
    const checked = afterScan(schema.userTokens, () => db.update(schema.userTokens).set(replacement).where(eq(schema.userTokens.userId, "owner")));
    expect(await rewrapAllSecrets()).toBe(0); checked();
    expect(await readTokens()).toMatchObject(replacement);
  });

  it.each([true, false])("preserves a refresh-only change (previous refresh token=%s)", async hadRefresh => {
    await seedTokens(hadRefresh); const before = await readTokens(); rotate();
    const replacement = encrypt("replacement-refresh", AAD.userRefreshToken);
    const checked = afterScan(schema.userTokens, () => db.update(schema.userTokens).set({ refreshTokenEnc: replacement }).where(eq(schema.userTokens.userId, "owner")));
    expect(await rewrapAllSecrets()).toBe(0); checked();
    expect(await readTokens()).toMatchObject({ accessTokenEnc: before.accessTokenEnc, refreshTokenEnc: replacement });
  });

  it("does not partially overwrite a pair when only its access token changed", async () => {
    await seedTokens(); const before = await readTokens(); rotate();
    const replacement = encrypt("replacement-access", AAD.userAccessToken);
    const checked = afterScan(schema.userTokens, () => db.update(schema.userTokens).set({ accessTokenEnc: replacement }).where(eq(schema.userTokens.userId, "owner")));
    expect(await rewrapAllSecrets()).toBe(0); checked();
    expect(await readTokens()).toMatchObject({ accessTokenEnc: replacement, refreshTokenEnc: before.refreshTokenEnc });
  });

  it("cannot recreate a deleted token row", async () => {
    await seedTokens(); rotate();
    afterScan(schema.userTokens, () => db.delete(schema.userTokens).where(eq(schema.userTokens.userId, "owner")));
    expect(await rewrapAllSecrets()).toBe(0); expect(await readTokens()).toBeUndefined();
  });

  it("preserves unrelated settings edited concurrently, changing only the original ciphertext", async () => {
    const apiKeyEnc = encrypt("search-key", AAD.webSearchKey);
    await db.insert(schema.settings).values({ key: "tools", value: { webSearch: { provider: "brave", apiKeyEnc } } }); rotate();
    const concurrent = { disabledTools: ["workspace"], enforcedApproval: ["fetch_url"], fetchAllowlist: ["example.test"],
      webSearch: { provider: "bing", url: "https://search.fixture.invalid", apiKeyEnc }, futureSetting: { retained: true } };
    const checked = afterScan(schema.settings, () => db.update(schema.settings).set({ value: concurrent }).where(eq(schema.settings.key, "tools")));
    expect(await rewrapAllSecrets()).toBe(1); checked();
    const value = await readSettings(); const search = value!.webSearch as typeof concurrent.webSearch;
    expect(value).toEqual({ ...concurrent, webSearch: { ...concurrent.webSearch, apiKeyEnc: search.apiKeyEnc } });
    expect(search.apiKeyEnc).toMatch(/^v2\.new\./); expect(decrypt(search.apiKeyEnc, AAD.webSearchKey)).toBe("search-key");
  });

  it.each(["replace", "remove-key", "remove-row"])("does not undo a concurrent search-secret change: %s", async action => {
    await db.insert(schema.settings).values({ key: "tools", value: { webSearch: { provider: "brave", apiKeyEnc: encrypt("old-search", AAD.webSearchKey) } } }); rotate();
    const replacement = { webSearch: { provider: "none", ...(action === "replace" ? { apiKeyEnc: encrypt("replacement-search", AAD.webSearchKey) } : {}) } };
    afterScan(schema.settings, () => action === "remove-row" ? db.delete(schema.settings).where(eq(schema.settings.key, "tools"))
      : db.update(schema.settings).set({ value: replacement }).where(eq(schema.settings.key, "tools")));
    expect(await rewrapAllSecrets()).toBe(0);
    expect(await readSettings()).toEqual(action === "remove-row" ? undefined : replacement);
  });
});
