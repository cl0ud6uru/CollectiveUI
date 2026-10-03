import { createCipheriv, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Integration: needs DATABASE_URL pointing at a migrated database. Skipped otherwise.
const run = process.env.DATABASE_URL ? describe : describe.skip;

const KEY = randomBytes(32).toString("base64");
function legacyEncrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

run("rewrapAllSecrets (integration)", () => {
  const ids = { user: `it-u-${Date.now()}`, app: "", mcp: "", bot: "", routine: "" };

  beforeAll(() => {
    vi.stubEnv("ENCRYPTION_KEY", KEY);
    vi.stubEnv("ENCRYPTION_KEYS", "");
    vi.stubEnv("ENCRYPTION_PRIMARY_KID", "");
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { aiApps, mcpServers, users } = await import("@/db/schema");
    if (ids.app) await db.delete(aiApps).where(eq(aiApps.id, ids.app));
    if (ids.mcp) await db.delete(mcpServers).where(eq(mcpServers.id, ids.mcp));
    await db.delete(users).where(inArray(users.id, [ids.user])); // cascades to bots and routines
    await pool.end();
    vi.unstubAllEnvs();
  });

  it("re-encrypts legacy values and plaintext webhook secrets, and is idempotent", async () => {
    const { db } = await import("@/db");
    const { aiApps, bots, mcpServers, routines, users } = await import("@/db/schema");
    const { AAD, decrypt } = await import("@/lib/crypto");
    const { openWebhookSecret } = await import("@/lib/routines");
    const { rewrapAllSecrets } = await import("@/lib/secrets-rewrap");
    const { appSecretAad } = await import("@/lib/llm/secrets");

    await db.insert(users).values({ id: ids.user, upn: `${ids.user}@corp.local`, name: "IT", authSource: "ldap" });
    [{ id: ids.app }] = await db
      .insert(aiApps)
      .values({ name: "it-app", baseUrl: "http://x/v1", model: "m", apiKeyEnc: legacyEncrypt("sk-legacy") })
      .returning({ id: aiApps.id });
    [{ id: ids.mcp }] = await db
      .insert(mcpServers)
      .values({ name: "it-mcp", url: "http://x/mcp", headersEnc: legacyEncrypt('{"Authorization":"Bearer t"}') })
      .returning({ id: mcpServers.id });
    [{ id: ids.bot }] = await db.insert(bots).values({ ownerId: ids.user, name: "it-bot" }).returning({ id: bots.id });
    [{ id: ids.routine }] = await db
      .insert(routines)
      .values({ ownerId: ids.user, botId: ids.bot, name: "hook", prompt: "p", triggerType: "webhook", webhookSecret: "plaintextsecret123" })
      .returning({ id: routines.id });

    expect(await rewrapAllSecrets()).toBeGreaterThanOrEqual(3);

    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, ids.app));
    expect(app.apiKeyEnc!.startsWith("v2.k0.")).toBe(true);
    // App credentials are now bound to their row.
    expect(decrypt(app.apiKeyEnc!, appSecretAad(ids.app))).toBe("sk-legacy");

    const [mcp] = await db.select().from(mcpServers).where(eq(mcpServers.id, ids.mcp));
    expect(JSON.parse(decrypt(mcp.headersEnc!, AAD.mcpHeaders))).toEqual({ Authorization: "Bearer t" });

    const [routine] = await db.select().from(routines).where(eq(routines.id, ids.routine));
    expect(routine.webhookSecret!.startsWith("v2.")).toBe(true);
    expect(openWebhookSecret(routine.webhookSecret)).toBe("plaintextsecret123");

    // Second pass: nothing of ours left to change.
    await rewrapAllSecrets();
    const [again] = await db.select().from(aiApps).where(eq(aiApps.id, ids.app));
    expect(again.apiKeyEnc).toBe(app.apiKeyEnc);
  });
});
