import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "@/db";
import { webSessions } from "@/db/web-sessions";
import { activeWebSession, admitWebSession, revokeWebSession, cleanupExpiredWebSessions, webSessionIdentity, type WebSessionIdentity } from "@/lib/auth/web-sessions";

vi.mock("@/db", () => ({ db: null }));
let engine: PGlite; let q: DbOrTx; let identity: WebSessionIdentity;
beforeEach(async () => {
  engine = new PGlite(); q = drizzle(engine) as unknown as DbOrTx;
  await engine.exec("create table users(id text primary key); insert into users values ('owner-a'), ('owner-b');");
  await engine.exec(await readFile("src/db/migrations/0056_web_sessions.sql", "utf8"));
  identity = { userId: "owner-a", sessionId: randomUUID(), sessionVersion: 1, expiresAt: new Date(Date.now() + 3600_000) };
});
afterEach(async () => { await engine.close(); });
describe("durable web-session revocation", () => {
  it("records only hashes and fixed owner/version/expiry, and admits the current session", async () => {
    expect(await activeWebSession(identity, q)).toBe(false);
    expect(await admitWebSession(identity, q)).toBe(true);
    const rows = await q.select().from(webSessions);
    expect(rows).toHaveLength(1); expect(rows[0].sessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(identity.sessionId);
    expect(rows[0].expiresAt).toEqual(identity.expiresAt);
  });
  it("old-cookie reads fail after logout; another login remains active", async () => {
    const otherLogin = { ...identity, sessionId: randomUUID() };
    await admitWebSession(identity, q); await admitWebSession(otherLogin, q);
    await revokeWebSession(identity, q);
    expect(await activeWebSession(identity, q)).toBe(false);
    expect(await admitWebSession(identity, q)).toBe(false);
    expect(await activeWebSession(otherLogin, q)).toBe(true);
  });
  it("refresh/admission racing logout never resurrects the session", async () => {
    await Promise.all([admitWebSession(identity, q), revokeWebSession(identity, q), ...Array.from({ length: 8 }, () => admitWebSession(identity, q))]);
    expect(await activeWebSession(identity, q)).toBe(false);
    const [row] = await q.select().from(webSessions); const revokedAt = row.revokedAt;
    await revokeWebSession(identity, q); expect((await q.select().from(webSessions))[0].revokedAt).toEqual(revokedAt);
  });
  it("logout creates a tombstone for a valid pre-registry session", async () => {
    await revokeWebSession(identity, q);
    expect(await admitWebSession(identity, q)).toBe(false);
  });
  it("rejects owner/version mismatch and cannot extend fixed expiry", async () => {
    await admitWebSession(identity, q);
    expect(await activeWebSession({ ...identity, userId: "owner-b" }, q)).toBe(false);
    expect(await activeWebSession({ ...identity, sessionVersion: 2 }, q)).toBe(false);
    await revokeWebSession({ ...identity, userId: "owner-b" }, q); expect(await activeWebSession(identity, q)).toBe(true);
    await q.update(webSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(webSessions.userId, identity.userId));
    expect(await admitWebSession({ ...identity, expiresAt: new Date(Date.now() + 7200_000) }, q)).toBe(false);
  });
  it("cleans expired rows while retaining active and revoked sessions until their fixed expiry", async () => {
    const active = { ...identity, sessionId: randomUUID() };
    const expired = { ...identity, sessionId: randomUUID() };
    await admitWebSession(active, q); await admitWebSession(expired, q); await revokeWebSession(identity, q);
    // Expire exactly the second admitted session using its stored hash, without exposing the identity in storage.
    const expiredHash = createHash("sha256").update(`collective:web-session:v1:${expired.sessionId}`).digest("hex");
    await q.update(webSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(webSessions.sessionIdHash, expiredHash));
    expect(await cleanupExpiredWebSessions(q)).toBe(1);
    expect(await cleanupExpiredWebSessions(q)).toBe(0);
    expect(await activeWebSession(active, q)).toBe(true);
    expect(await admitWebSession(identity, q)).toBe(false);
  });
  it("validates token identity and fails closed after database loss", async () => {
    const token = { uid: identity.userId, authSessionId: identity.sessionId, sessionVersion: 1, sessionDeadline: identity.expiresAt.getTime() / 1000 };
    expect(webSessionIdentity(token)).toEqual(identity);
    for (const bad of [{ ...token, authSessionId: "raw-cookie" }, { ...token, sessionVersion: -1 }, { ...token, sessionDeadline: Infinity }]) expect(webSessionIdentity(bad)).toBeNull();
    await engine.exec("drop table web_sessions");
    await expect(activeWebSession(identity, q)).rejects.toThrow();
  });
});
