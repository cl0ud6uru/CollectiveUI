import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const request = vi.hoisted(() => ({ headers: new Headers(), cookieUser: null as string | null }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
// A browser session for someone else: a bearer request must never fall back to it.
vi.mock("@/auth", () => ({
  auth: async () => request.cookieUser ? { user: { id: request.cookieUser, sessionVersion: 0, mustChangePassword: false, sessionId: "s" } } : null,
}));
const run = process.env.DATABASE_URL ? describe : describe.skip;

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

run("native app tokens (real Postgres)", () => {
  let alice: Principal;
  let bobId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("MOBILE_APP_ENABLED", "true");
    vi.stubEnv("LDAP_ENABLED", "true");
    vi.stubEnv("LDAP_URL", "ldaps://ldap.example.invalid");
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    for (const name of ["Alice", "Bob"]) {
      const id = `it-mobile-${newId()}`;
      const [user] = await db.insert(schema.users).values({ id, upn: `${id}@corp.local`, name, authSource: "ldap" }).returning();
      userIds.push(id);
      if (name === "Alice") alice = { user, groupIds: [], isAdmin: false, canCreateBots: true };
      else bobId = id;
    }
  });

  beforeEach(() => {
    vi.stubEnv("MOBILE_APP_ENABLED", "true");
    request.headers = new Headers();
    request.cookieUser = null;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const { db, pool, schema } = await import("@/db");
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await pool.end();
  });

  const req = { codeChallenge: challenge, state: "state-123456", deviceName: "Test iPhone" };

  async function signIn() {
    const { exchangeAuthCode, issueAuthCode } = await import("@/lib/auth/mobile");
    return exchangeAuthCode(await issueAuthCode(alice, req), verifier);
  }

  it("redeems a code once, only with its PKCE verifier, and stores only hashes", async () => {
    const { db, schema } = await import("@/db");
    const { exchangeAuthCode, issueAuthCode } = await import("@/lib/auth/mobile");
    const code = await issueAuthCode(alice, req);
    await expect(exchangeAuthCode(code, "x".repeat(43))).rejects.toThrow(/Invalid or expired/);
    await expect(exchangeAuthCode(code, verifier)).rejects.toThrow(/Invalid or expired/); // burned by the failed attempt

    const second = await issueAuthCode(alice, req);
    const { token, expiresAt, principal } = await exchangeAuthCode(second, verifier);
    expect(token).toMatch(/^cui_m_/);
    expect(principal.user.id).toBe(alice.user.id);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000);
    await expect(exchangeAuthCode(second, verifier)).rejects.toThrow(/Invalid or expired/);
    const rows = await db.select().from(schema.mobileSessions).where(eq(schema.mobileSessions.userId, alice.user.id));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token.slice(6));
  });

  it("rejects expired codes and codes while the app is turned off", async () => {
    const { db, schema } = await import("@/db");
    const { exchangeAuthCode, issueAuthCode } = await import("@/lib/auth/mobile");
    const code = await issueAuthCode(alice, req);
    await db.update(schema.mobileAuthCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.mobileAuthCodes.userId, alice.user.id));
    await expect(exchangeAuthCode(code, verifier)).rejects.toThrow(/Invalid or expired/);
    const fresh = await issueAuthCode(alice, req);
    vi.stubEnv("MOBILE_APP_ENABLED", "false");
    await expect(exchangeAuthCode(fresh, verifier)).rejects.toThrow(/turned off/);
  });

  it("authorizes bearer requests by the token alone, never by cookies", async () => {
    const { getPrincipal } = await import("@/lib/session");
    const { token } = await signIn();
    request.cookieUser = bobId;

    request.headers = new Headers({ authorization: `Bearer ${token}` });
    expect((await getPrincipal())?.user.id).toBe(alice.user.id);

    request.headers = new Headers({ authorization: "Bearer cui_m_not-a-real-token" });
    expect(await getPrincipal()).toBeNull();
    request.headers = new Headers({ authorization: "Bearer something-else" });
    expect(await getPrincipal()).toBeNull();

    // Without a Bearer header (or with another scheme) the browser session applies as before.
    request.headers = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    expect((await getPrincipal())?.user.id).toBe(bobId);
  });

  it("dies with sign-out, revocation, expiry, account changes and the operator switch", async () => {
    const { db, schema } = await import("@/db");
    const { listMobileSessions, mobilePrincipal, revokeMobileSession } = await import("@/lib/auth/mobile");

    const a = await signIn();
    expect((await mobilePrincipal(a.token))?.principal.user.id).toBe(alice.user.id);
    vi.stubEnv("MOBILE_APP_ENABLED", "false");
    expect(await mobilePrincipal(a.token)).toBeNull();
    vi.stubEnv("MOBILE_APP_ENABLED", "true");

    const b = await signIn();
    const listed = await listMobileSessions(alice);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((d) => d.deviceName === "Test iPhone")).toBe(true);
    for (const d of listed) await revokeMobileSession(bobId, d.id); // someone else's ids: no effect
    expect(await mobilePrincipal(b.token)).not.toBeNull();

    await db.update(schema.mobileSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.mobileSessions.tokenHash, (await import("@/lib/crypto")).sha256Hex(`mobile-token|${b.token}`)));
    expect(await mobilePrincipal(b.token)).toBeNull();

    await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, alice.user.id));
    expect(await mobilePrincipal(a.token)).toBeNull();
    await db.update(schema.users).set({ disabled: false }).where(eq(schema.users.id, alice.user.id));
    expect(await mobilePrincipal(a.token)).not.toBeNull();

    // A password reset, new factor or "sign out everywhere" bumps sessionVersion: every device token dies with it.
    await db.update(schema.users).set({ sessionVersion: alice.user.sessionVersion + 1 }).where(eq(schema.users.id, alice.user.id));
    expect(await mobilePrincipal(a.token)).toBeNull();
    expect(await listMobileSessions({ ...alice, user: { ...alice.user, sessionVersion: alice.user.sessionVersion + 1 } })).toEqual([]);
    await db.update(schema.users).set({ sessionVersion: alice.user.sessionVersion }).where(eq(schema.users.id, alice.user.id));

    await revokeMobileSession(alice.user.id);
    expect(await mobilePrincipal(a.token)).toBeNull();
    expect(await listMobileSessions(alice)).toEqual([]);
  });

  it("signs a device out through the session route", async () => {
    const { mobilePrincipal } = await import("@/lib/auth/mobile");
    const { GET, DELETE } = await import("@/app/api/mobile/v1/session/route");
    const { token } = await signIn();
    request.headers = new Headers({ authorization: `Bearer ${token}` });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: alice.user.id, name: "Alice" }, deviceName: "Test iPhone" });
    expect((await DELETE()).status).toBe(204);
    expect(await mobilePrincipal(token)).toBeNull();
  });
});
