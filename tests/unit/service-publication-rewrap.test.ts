import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ webSearch: {} }), setSetting: vi.fn() }));
vi.mock("@/lib/llm/chatgpt/store", () => ({ rewrapChatGPTSecrets: async () => 0 }));
vi.mock("@/lib/mcp/member-connections", () => ({ rewrapMemberMcpSecrets: async () => 0 }));

import { db, schema } from "@/db";
import { AAD, encrypt } from "@/lib/crypto";
import { openAppSecret, sealAppSecret } from "@/lib/llm/secrets";
import { serviceConfigHash } from "@/lib/bots/service";
import { rewrapAllSecrets } from "@/lib/secrets-rewrap";

const secret = "synthetic-service-key-not-an-account-credential";
const appRow = async () => (await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, "model")))[0];
const botRow = async (id = "current") => (await db.select().from(schema.bots).where(eq(schema.bots.id, id)))[0];
const rotate = () => vi.stubEnv("ENCRYPTION_PRIMARY_KID", "new");
async function publish(id: string) {
  const [bot] = await db.insert(schema.bots).values({ id, ownerId: "owner", appId: "model", name: "Synthetic service", executionMode: "service" }).returning();
  await db.update(schema.bots).set({ publishedRevision: bot.revision, publishedConfigHash: await serviceConfigHash(bot) }).where(eq(schema.bots.id, id));
  return botRow(id);
}
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 60_000);
beforeEach(async () => {
  vi.stubEnv("ENCRYPTION_KEY", "");
  vi.stubEnv("ENCRYPTION_KEYS", "old:synthetic-rotation-old-key,new:synthetic-rotation-new-key");
  vi.stubEnv("ENCRYPTION_PRIMARY_KID", "old");
  await fixture.client!.exec("TRUNCATE users, ai_apps CASCADE");
  await db.insert(schema.users).values({ id: "owner", upn: "owner@fixture.invalid", name: "Synthetic owner", authSource: "local", identityRealm: "local" });
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic model", provider: "anthropic", model: "fixture-model", supportsTools: true, apiKeyEnc: sealAppSecret("model", secret) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await fixture.client!.close(); });

it("keeps only immediately valid publications valid across primary-key rotation", async () => {
  await publish("current");
  await publish("stale-hash"); await publish("stale-revision");
  await db.update(schema.bots).set({ instructions: "Changed after publication" }).where(eq(schema.bots.id, "stale-hash"));
  await db.update(schema.bots).set({ revision: 2 }).where(eq(schema.bots.id, "stale-revision"));
  const staleHash = await botRow("stale-hash"), staleRevision = await botRow("stale-revision"), before = await appRow();
  rotate();
  expect(await rewrapAllSecrets()).toBe(1);
  const after = await appRow(), current = await botRow();
  expect(after.apiKeyEnc).not.toBe(before.apiKeyEnc);
  expect(after.apiKeyEnc).toMatch(/^v2\.new\./);
  expect(openAppSecret(after)).toBe(secret);
  expect(await serviceConfigHash(current)).toBe(current.publishedConfigHash);
  expect(await botRow("stale-hash")).toEqual(staleHash);
  expect(await botRow("stale-revision")).toEqual(staleRevision);
  expect(await serviceConfigHash(staleHash)).not.toBe(staleHash.publishedConfigHash);
  expect(await rewrapAllSecrets()).toBe(0);
  expect(await appRow()).toEqual(after);
  expect(JSON.stringify(current)).not.toContain(secret);
});

it("preserves a current legacy column-bound publication during row-binding upgrade", async () => {
  await db.update(schema.aiApps).set({ apiKeyEnc: encrypt(secret, AAD.appApiKey) }).where(eq(schema.aiApps.id, "model"));
  await publish("current");
  expect(await rewrapAllSecrets()).toBe(1);
  const current = await botRow();
  expect(await serviceConfigHash(current)).toBe(current.publishedConfigHash);
  expect(openAppSecret(await appRow())).toBe(secret);
  expect(await rewrapAllSecrets()).toBe(0);
});

it("keeps an actual credential replacement unpublished after its ciphertext is rewrapped", async () => {
  const published = await publish("current");
  await db.update(schema.aiApps).set({ apiKeyEnc: sealAppSecret("model", "synthetic-replacement-key") }).where(eq(schema.aiApps.id, "model"));
  rotate();
  expect(await rewrapAllSecrets()).toBe(1);
  expect(await botRow()).toEqual(published);
  expect(await serviceConfigHash(published)).not.toBe(published.publishedConfigHash);
  expect(openAppSecret(await appRow())).toBe("synthetic-replacement-key");
});

it("reads the current locked credential instead of overwriting a replacement after the initial scan", async () => {
  const published = await publish("current"); rotate();
  const replacement = sealAppSecret("model", "synthetic-concurrent-replacement");
  const select = db.select.bind(db);
  let scanned = false;
  vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof db.select>) => {
    const builder = select(...args), from = builder.from.bind(builder);
    builder.from = ((table: Parameters<typeof builder.from>[0]) => {
      const query = from(table);
      if (table !== schema.aiApps || scanned) return query;
      scanned = true;
      const where = query.where.bind(query);
      query.where = ((...conditions: Parameters<typeof query.where>) => (async () => {
        const stale = await where(...conditions);
        await db.update(schema.aiApps).set({ apiKeyEnc: replacement }).where(eq(schema.aiApps.id, "model"));
        return stale;
      })()) as typeof query.where;
      return query;
    }) as typeof builder.from;
    return builder;
  }) as typeof db.select);
  expect(await rewrapAllSecrets()).toBe(0);
  expect(scanned).toBe(true);
  expect((await appRow()).apiKeyEnc).toBe(replacement);
  expect(await botRow()).toEqual(published);
  expect(await serviceConfigHash(published)).not.toBe(published.publishedConfigHash);
});

it("rolls back ciphertext and publication together if publication persistence fails", async () => {
  const published = await publish("current"), before = await appRow(); rotate();
  await fixture.client!.exec(`CREATE FUNCTION reject_fixture_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture publication persistence failed'; END $$;
    CREATE TRIGGER reject_fixture_publication BEFORE UPDATE OF published_config_hash ON bots FOR EACH ROW EXECUTE FUNCTION reject_fixture_publication();`);
  try {
    await expect(rewrapAllSecrets()).rejects.toThrow();
    expect(await appRow()).toEqual(before);
    expect(await botRow()).toEqual(published);
  } finally {
    await fixture.client!.exec("DROP TRIGGER reject_fixture_publication ON bots; DROP FUNCTION reject_fixture_publication()");
  }
});
