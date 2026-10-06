import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { MobileSession } from "@/lib/auth/mobile";
import type { APNsConfig } from "@/lib/live-activities/apns";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from "@/db";
import { decrypt } from "@/lib/crypto";
import { registerActivity, registrationError, removeActivities, runForActivity, tokenAAD } from "@/lib/live-activities/store";
import { deliverActivities } from "@/lib/live-activities/delivery";
import { revokeMobileSession } from "@/lib/auth/mobile";
import { registration } from "@/lib/live-activities/protocol";
const now = () => new Date();
const config = {} as APNsConfig; // Mock delivery: never connects to Apple or signs anything.
let alice: Principal; let bob: Principal; let session: MobileSession; let otherDevice: MobileSession;
const input = (activityId = "activity", runId = "run", token = "ab".repeat(32), tokenVersion = 1) => registration.parse({ activityId, runId, pushToken: token, tokenVersion });
async function rows() { return db.select().from(schema.liveActivities); }
async function due() { await db.update(schema.liveActivities).set({ nextAttemptAt: new Date(0) }); }
async function run(id: string, chat = "chat", owner = "alice") {
  await db.insert(schema.agentRuns).values({ id, userId: owner, conversationId: chat, messageId: `message-${id}`, botId: "bot", appId: "model", status: "running" });
}

beforeAll(async () => {
  await fixture.client!.waitReady;
  // Real PostgreSQL tables/constraints and all production migrations. The unrelated pgvector
  // columns use real[] in this embedded fixture; embeddings are not exercised by this suite.
  for (const file of readdirSync("src/db/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    let ddl = readFileSync(`src/db/migrations/${file}`, "utf8");
    ddl = ddl.replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]");
    await fixture.client!.exec(ddl);
  }
}, 45_000);
beforeEach(async () => {
  vi.stubEnv("MOBILE_APP_ENABLED", "true"); vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("LDAP_URL", "ldaps://fixture.invalid");
  await fixture.client!.exec("TRUNCATE users, ai_apps CASCADE");
  const users = await db.insert(schema.users).values([
    { id: "alice", upn: "alice@fixture.invalid", name: "Alice", authSource: "ldap" },
    { id: "bob", upn: "bob@fixture.invalid", name: "Bob", authSource: "ldap" },
  ]).returning();
  alice = { user: users[0], groupIds: [], isAdmin: false, canCreateBots: true };
  bob = { user: users[1], groupIds: [], isAdmin: false, canCreateBots: true };
  [session, otherDevice] = await db.insert(schema.mobileSessions).values([
    { id: "device", userId: "alice", tokenHash: "fake-mobile-token-hash", deviceName: "Fixture", sessionVersion: 0, authProvider: "ldap", expiresAt: new Date(Date.now() + 3600_000) },
    { id: "other-device", userId: "alice", tokenHash: "fake-other-token-hash", deviceName: "Fixture 2", sessionVersion: 0, authProvider: "ldap", expiresAt: new Date(Date.now() + 3600_000) },
  ]).returning();
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic", model: "test", baseUrl: "https://fixture.invalid/v1" });
  await db.insert(schema.bots).values({ id: "bot", name: "Pet bot", ownerId: "alice", appId: "model", visibility: "org" });
  await db.insert(schema.conversations).values([{ id: "chat", userId: "alice", botId: "bot" }, { id: "bob-chat", userId: "bob", botId: "bot" }]);
  await run("run");
});
afterAll(async () => { vi.unstubAllEnvs(); await fixture.client?.close(); });

describe("owner-scoped ActivityKit registration (embedded PostgreSQL)", () => {
  it("stores only encrypted tokens and makes reconnect registration idempotent", async () => {
    await registerActivity(alice, session, input());
    const [first] = await rows();
    expect(first.tokenEnc).not.toContain("ababab"); expect(first.tokenHash).toHaveLength(64);
    expect(decrypt(first.tokenEnc, tokenAAD("device", "activity"))).toBe(input().pushToken);
    expect(() => decrypt(first.tokenEnc, tokenAAD("other-device", "activity"))).toThrow();
    await db.update(schema.liveActivities).set({ fingerprint: "working", deliveredAt: now() });
    await registerActivity(alice, session, input());
    expect(await rows()).toHaveLength(1); expect((await rows())[0].fingerprint).toBe("working");
  });
  it("rejects cross-account runs and cross-session owner substitution", async () => {
    await expect(registerActivity(bob, { ...session, userId: "bob" }, input())).rejects.toMatchObject({ status: 404 });
    await expect(registerActivity(bob, session, input())).rejects.toMatchObject({ status: 401 });
    await expect(runForActivity(bob, "chat")).rejects.toMatchObject({ status: 404 });
    expect(await rows()).toHaveLength(0);
  });
  it("rotates tokens, rejects stale rotations, and never transfers a token between devices", async () => {
    await registerActivity(alice, session, input());
    await registerActivity(alice, session, input("activity", "run", "cd".repeat(32), 2));
    await expect(registerActivity(alice, session, input())).rejects.toMatchObject({ status: 409 });
    const [row] = await rows(); expect(decrypt(row.tokenEnc, tokenAAD("device", "activity"))).toBe("cd".repeat(32));
    await expect(registerActivity(alice, otherDevice, input("second", "run", "cd".repeat(32), 3))).rejects.toMatchObject({ status: 409 });
    await registerActivity(alice, session, input("activity", "run", "cd".repeat(32), 4));
    await expect(registerActivity(alice, session, input("activity", "run", "ef".repeat(32), 3))).rejects.toMatchObject({ status: 409 });
  });
  it("caps concurrent runs per device and rejects duplicate run registrations", async () => {
    await registerActivity(alice, session, input());
    for (let i = 2; i <= 4; i++) {
      await db.insert(schema.conversations).values({ id: `chat-${i}`, userId: "alice", botId: "bot" }); await run(`run-${i}`, `chat-${i}`);
      const operation = registerActivity(alice, session, input(`activity-${i}`, `run-${i}`, String(i).repeat(64)));
      if (i === 4) await expect(operation).rejects.toMatchObject({ status: 429 }); else await operation;
    }
    expect(await rows()).toHaveLength(3);
    await expect(registerActivity(alice, session, input("duplicate", "run", "ff".repeat(32))).catch(registrationError)).rejects.toMatchObject({ status: 429 });
  });
  it("logout removes only the revoked device's registrations; owner-scoped removal cannot remove another device", async () => {
    await registerActivity(alice, session, input()); await registerActivity(alice, otherDevice, input("other", "run", "cd".repeat(32)));
    await removeActivities("bob", "device"); expect(await rows()).toHaveLength(2);
    await revokeMobileSession("alice", "device"); expect((await rows()).map((r) => r.sessionId)).toEqual(["other-device"]);
    await expect(registerActivity(alice, session, input())).rejects.toMatchObject({ status: 401 });
  });
  it("rejects expired/ended subscriptions and inaccessible bots", async () => {
    await registerActivity(alice, session, input());
    await db.update(schema.liveActivities).set({ expiresAt: new Date(0) });
    await expect(registerActivity(alice, session, input())).rejects.toMatchObject({ status: 410 });
    await db.delete(schema.liveActivities);
    await db.update(schema.bots).set({ enabled: false });
    await expect(registerActivity(alice, session, input())).rejects.toMatchObject({ status: 403 });
  });
});
describe("server delivery while the app is suspended (synthetic APNs)", () => {
  it("deduplicates unchanged status, then delivers final state and stops", async () => {
    await registerActivity(alice, session, input());
    const send = vi.fn().mockResolvedValue("delivered");
    await deliverActivities(config, send); await due(); await deliverActivities(config, send);
    expect(send).toHaveBeenCalledTimes(1);
    await db.update(schema.agentRuns).set({ status: "succeeded", finishedAt: now(), updatedAt: now() });
    await due(); await deliverActivities(config, send);
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][2].phase).toBe("completed");
    expect(send.mock.calls[1][3]).toBeGreaterThan(send.mock.calls[0][3]);
    expect((await rows())[0].endedAt).not.toBeNull();
    await due(); await deliverActivities(config, send); expect(send).toHaveBeenCalledTimes(2);
  });
  it("delivers approval attention, confirmed cancellation, and failure without task text", async () => {
    await registerActivity(alice, session, input());
    const send = vi.fn().mockResolvedValue("delivered");
    await db.update(schema.agentRuns).set({ status: "waiting", updatedAt: now() });
    await deliverActivities(config, send); expect(send.mock.calls[0][2].phase).toBe("attention");
    await db.update(schema.agentRuns).set({ status: "cancelled", updatedAt: now(), error: "SENSITIVE" });
    await due(); await deliverActivities(config, send); expect(send.mock.calls[1][2].phase).toBe("cancelled");
    expect(JSON.stringify(send.mock.calls)).not.toContain("SENSITIVE");
  });
  it("retries network failures after worker restart and purges stale APNs tokens", async () => {
    await registerActivity(alice, session, input());
    const send = vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce("delivered").mockResolvedValueOnce("invalid-token");
    await deliverActivities(config, send); expect((await rows())[0].attempts).toBe(1);
    await deliverActivities(config, send); expect(send).toHaveBeenCalledTimes(1);
    await due(); await deliverActivities(config, send); expect((await rows())[0].attempts).toBe(0);
    await db.update(schema.agentRuns).set({ status: "failed", updatedAt: now() });
    await due(); await deliverActivities(config, send); expect(await rows()).toHaveLength(0);
  });
  it.each(["revoked", "expired", "version", "disabled-user", "disabled-bot", "permissions", "mobile-disabled", "subscription-expired"])("purges %s before any push", async (reason) => {
    await registerActivity(alice, session, input());
    if (reason === "revoked") await db.update(schema.mobileSessions).set({ revokedAt: now() }).where(eq(schema.mobileSessions.id, session.id));
    if (reason === "expired") await db.update(schema.mobileSessions).set({ expiresAt: new Date(0) }).where(eq(schema.mobileSessions.id, session.id));
    if (reason === "version") await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, "alice"));
    if (reason === "disabled-user") await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, "alice"));
    if (reason === "disabled-bot") await db.update(schema.bots).set({ enabled: false });
    if (reason === "permissions") await db.update(schema.bots).set({ ownerId: "bob", visibility: "private" });
    if (reason === "mobile-disabled") vi.stubEnv("MOBILE_APP_ENABLED", "false");
    if (reason === "subscription-expired") await db.update(schema.liveActivities).set({ expiresAt: new Date(0) });
    const send = vi.fn().mockResolvedValue("delivered"); await deliverActivities(config, send);
    expect(send).not.toHaveBeenCalled(); expect(await rows()).toHaveLength(0);
  });
});
