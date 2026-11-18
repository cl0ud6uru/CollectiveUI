import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/db";
import { userTokens, users } from "@/db/schema";
import { getGraphToken, saveEntraTokens } from "@/lib/auth/entra";
import { AAD, decrypt } from "@/lib/crypto";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client) };
});

beforeAll(async () => {
  for (const file of readdirSync("src/db/migrations").filter(name => name.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8")
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 30_000);
beforeEach(async () => {
  vi.stubEnv("ENCRYPTION_KEYS", "test:synthetic-entra-test-key");
  vi.stubEnv("ENCRYPTION_PRIMARY_KID", "test");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", "https://fixture.invalid/v2.0");
  await fixture.client!.exec("TRUNCATE users CASCADE");
  await db.insert(users).values({ id: "owner", upn: "owner", name: "Owner", authSource: "entra" });
  await saveEntraTokens("owner", { access_token: "old", refresh_token: "old-refresh", expires_at: 0 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await fixture.client?.close(); });

function providerRefresh(duringRefresh?: () => Promise<unknown>, status = 200) {
  vi.stubGlobal("fetch", async () => {
    await duringRefresh?.();
    return Response.json({ access_token: "provider-access", refresh_token: "provider-refresh", expires_in: 3600 }, { status });
  });
}

it("stores newly refreshed credentials for the same sign-in", async () => {
  providerRefresh();
  expect(await getGraphToken("owner")).toBe("provider-access");
  const [row] = await db.select().from(userTokens);
  expect(decrypt(row.refreshTokenEnc!, AAD.userRefreshToken)).toBe("provider-refresh");
});

it.each([200, 400])("uses the newer sign-in when the delayed token response returns %s", async status => {
  providerRefresh(() => saveEntraTokens("owner", { access_token: "sign-in", refresh_token: "sign-in-refresh" }), status);
  expect(await getGraphToken("owner")).toBe("sign-in");
  const [row] = await db.select().from(userTokens);
  expect(decrypt(row.refreshTokenEnc!, AAD.userRefreshToken)).toBe("sign-in-refresh");
});

it("keeps credentials removed during refresh absent", async () => {
  providerRefresh(async () => { await db.delete(userTokens); });
  expect(await getGraphToken("owner")).toBeNull();
  expect(await db.select().from(userTokens)).toEqual([]);
});
