import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { LdapUser } from "@/lib/auth/ldap";
import type { SecurityActor } from "@/lib/auth/security";
import { authIdentityFixtureURL } from "../fixtures/auth-identity/disposable-database";

const fixture = vi.hoisted(() => ({ directory: null as LdapUser | null, verified: null as { user: unknown; identity: LdapUser } | null,
  read: vi.fn(), authenticate: vi.fn(), atBinding: vi.fn(), webSession: null as Record<string, unknown> | null, requestHeaders: new Headers() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: async () => fixture.webSession }));
vi.mock("next/headers", () => ({ headers: async () => fixture.requestHeaders }));
vi.mock("@/lib/auth/ldap", async (original) => ({ ...await original<typeof import("@/lib/auth/ldap")>(), readLdapIdentity: fixture.read, authenticateLdapAtBinding: fixture.atBinding }));
vi.mock("@/lib/auth/ldap-account", () => ({ authenticateLdapPassword: fixture.authenticate }));
// Validate the destructive fixture target before importing any application database/network clients.
const enabled = process.env.AUTH_IDENTITY_POSTGRES_PROOF === "1";
const fixtureURL = enabled ? authIdentityFixtureURL() : undefined;
const run = enabled ? describe : describe.skip;
let db: typeof import("@/db").db, pool: typeof import("@/db").pool, s: typeof import("@/db/schema");
let beginPasswordLogin: typeof import("@/lib/auth/security").beginPasswordLogin,
  finishPasswordLogin: typeof import("@/lib/auth/security").finishPasswordLogin,
  consumeLoginTicket: typeof import("@/lib/auth/security").consumeLoginTicket,
  reauthenticatePassword: typeof import("@/lib/auth/security").reauthenticatePassword,
  securitySummary: typeof import("@/lib/auth/security").securitySummary;
let recoveryHash: typeof import("@/lib/auth/factors").recoveryHash;
let randomToken: typeof import("@/lib/crypto").randomToken, sha256Hex: typeof import("@/lib/crypto").sha256Hex;
let lockAccounts: typeof import("@/lib/auth/local").lockAccounts;
let pkceChallenge: typeof import("@/lib/auth/mobile").pkceChallenge,
  exchangeAuthCode: typeof import("@/lib/auth/mobile").exchangeAuthCode,
  mobilePrincipal: typeof import("@/lib/auth/mobile").mobilePrincipal;
let authorizeMobile: typeof import("@/app/api/mobile/auth/authorize/route").POST;
let sessionState: typeof import("@/lib/auth/session-state").sessionState;

const binding = "synthetic-browser-binding-at-least-20-characters";
const recovery = "11111111-22222222-33333333-44444444-55555555";
const oldDn = "uid=alice,ou=old,dc=fixture", newDn = "uid=alice,ou=new,dc=fixture";
let actor: SecurityActor;
run("LDAP identity repair and account lock scope (disposable PostgreSQL, synthetic directory)", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", fixtureURL!); vi.stubEnv("DATABASE_POOL_MAX", "1");
    ({ db, pool, schema: s } = await import("@/db"));
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    ({ beginPasswordLogin, finishPasswordLogin, consumeLoginTicket, reauthenticatePassword, securitySummary } = await import("@/lib/auth/security"));
    ({ recoveryHash } = await import("@/lib/auth/factors"));
    ({ randomToken, sha256Hex } = await import("@/lib/crypto"));
    ({ lockAccounts } = await import("@/lib/auth/local"));
    ({ pkceChallenge, exchangeAuthCode, mobilePrincipal } = await import("@/lib/auth/mobile"));
    ({ POST: authorizeMobile } = await import("@/app/api/mobile/auth/authorize/route"));
    ({ sessionState } = await import("@/lib/auth/session-state"));
    vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("LDAP_URL", "ldaps://fixture.invalid"); vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); vi.stubEnv("AUTH_SECRET", "synthetic-auth-identity-session-secret");
  });
  beforeEach(async () => {
    vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("MOBILE_APP_ENABLED", "true"); vi.stubEnv("AUTH_ENTRA_ENABLED", "true");
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "synthetic-client"); vi.stubEnv("AUTH_URL", "https://fixture.invalid");
    fixture.webSession = null; fixture.requestHeaders = new Headers();
    await db.execute("TRUNCATE users, auth_flows, auth_throttle CASCADE");
    const [user] = await db.insert(s.users).values({ id: "alice", upn: "alice@fixture.invalid", name: "Alice", authSource: "ldap" }).returning();
    await db.insert(s.localSecurity).values({ userId: user.id, userHandle: "synthetic-user-handle", ldapDn: oldDn, ldapIdentity: "stable-identity" });
    await db.insert(s.localPasskeys).values({ id: "synthetic-nonusable-key", userId: user.id, name: "Synthetic key", publicKey: "not-a-real-key", counter: 7, deviceType: "multiDevice", backedUp: true, transports: [] });
    await db.insert(s.localRecoveryCodes).values([recovery, "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee"].map(code => ({ userId: user.id, hash: recoveryHash(user.id, code) })));
    fixture.directory = { dn: newDn, identity: "stable-identity", upn: user.upn, name: "Alice", groups: [] };
    fixture.verified = { user, identity: fixture.directory };
    fixture.authenticate.mockReset(); fixture.read.mockReset(); fixture.atBinding.mockReset();
    fixture.authenticate.mockImplementation(async () => fixture.verified);
    fixture.atBinding.mockImplementation(async () => fixture.directory);
    fixture.read.mockImplementation(async (dn: string, identity: string) => dn === fixture.directory?.dn && identity === fixture.directory.identity ? fixture.directory : null);
    actor = { id: user.id, sessionVersion: user.sessionVersion, sessionId: binding };
  });
  afterAll(async () => { vi.unstubAllEnvs(); await pool?.end(); });
  it("repairs a moved DN only after matching the verified stable identity, retaining and enforcing enrolled factors", async () => {
    const keys = await db.select().from(s.localPasskeys), codes = await db.select().from(s.localRecoveryCodes);
    const login = await beginPasswordLogin("alice", "synthetic-password", new Headers(), binding, "ldap");
    expect(login.flow).toBeTruthy(); expect(login.ticket).toBeUndefined();
    expect((await db.select().from(s.localSecurity))[0]).toMatchObject({ ldapDn: newDn, ldapIdentity: "stable-identity" });
    expect(await db.select().from(s.localPasskeys)).toEqual(keys); expect(await db.select().from(s.localRecoveryCodes)).toEqual(codes);
    const completed = await finishPasswordLogin(login.flow!, recovery, true, binding, "ldap");
    expect(await consumeLoginTicket(completed.ticket, binding, "ldap")).toMatchObject({ id: actor.id, sessionVersion: actor.sessionVersion });
    expect((await db.select().from(s.localPasskeys))[0].counter).toBe(7);
  });
  it.each(["replacement-identity", undefined])("refuses changed or missing verified identity %s without replacing factors", async identity => {
    fixture.verified!.identity = { ...fixture.directory!, identity };
    await expect(beginPasswordLogin("alice", "synthetic-password", new Headers(), binding, "ldap")).rejects.toThrow();
    expect((await db.select().from(s.localSecurity))[0]).toMatchObject({ ldapDn: oldDn, ldapIdentity: "stable-identity" });
    expect(await db.select().from(s.localPasskeys)).toHaveLength(1); expect(await db.select().from(s.localRecoveryCodes)).toHaveLength(2);
    expect(await db.select().from(s.authFlows)).toHaveLength(0);
  });
  it("repairs a moved DN during password reauthentication while still requiring the enrolled recovery factor", async () => {
    const keys = await db.select().from(s.localPasskeys);
    const result = await reauthenticatePassword(actor, "add-passkey", "synthetic-password", recovery, true, new Headers());
    expect(result.proof).toBeTruthy();
    expect(fixture.atBinding).toHaveBeenCalledWith(oldDn, "stable-identity", "synthetic-password", undefined, "alice@fixture.invalid");
    expect((await db.select().from(s.localSecurity))[0]).toMatchObject({ ldapDn: newDn, ldapIdentity: "stable-identity" });
    expect(await db.select().from(s.localPasskeys)).toEqual(keys);
    expect(await db.select().from(s.localRecoveryCodes)).toHaveLength(1);
  });
  it("does not attach an unbound directory identity to pre-existing factors", async () => {
    await db.update(s.localSecurity).set({ ldapDn: null, ldapIdentity: null }).where(eq(s.localSecurity.userId, actor.id));
    await expect(beginPasswordLogin("alice", "synthetic-password", new Headers(), binding, "ldap")).rejects.toThrow();
    expect((await db.select().from(s.localSecurity))[0]).toMatchObject({ ldapDn: null, ldapIdentity: null });
  });
  it("does not hold the installation account lock while awaiting LDAP and lets a local ticket finish", async () => {
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; }), ready = new Promise<void>(resolve => { release = resolve; });
    fixture.read.mockImplementation(async () => { entered(); await ready; return fixture.directory; });
    await db.insert(s.users).values({ id: "rescue", upn: "local:rescue", name: "Rescue", identityRealm: "local", authSource: "local", isAdmin: true });
    await db.insert(s.localCredentials).values({ userId: "rescue", username: "rescue", passwordHash: "synthetic-nonusable-password-hash" });
    const token = randomToken();
    await db.insert(s.authFlows).values({ hash: sha256Hex(token), purpose: "login-ticket", bindingHash: sha256Hex(`binding|${binding}`), userId: "rescue", sessionVersion: 0, data: { provider: "local" }, expiresAt: new Date(Date.now() + 60000) });
    const pending = securitySummary(actor);
    try {
      await reading;
      const probe = await pool.query("SELECT pg_try_advisory_xact_lock(632006, 11) AS acquired");
      expect(probe.rows[0].acquired).toBe(true);
      const local = await Promise.race([consumeLoginTicket(token, binding, "local"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Local ticket waited on LDAP")), 1500))]);
      expect(local.id).toBe("rescue");
    } finally { release(); await pending; }
  });

  it.each(["disabled", "sessionVersion", "ldapIdentity", "ldapDn", "upn", "identityRealm", "authSource", "provider"])("rejects a fresh locked %s change made during LDAP preflight", async mutation => {
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; }), ready = new Promise<void>(resolve => { release = resolve; });
    fixture.read.mockImplementation(async () => { entered(); await ready; return fixture.directory; });
    const pending = securitySummary(actor);
    const rejected = pending.then(() => false, () => true);
    try {
      await reading;
      await db.transaction(async tx => {
        await lockAccounts(tx);
        if (mutation === "ldapIdentity" || mutation === "ldapDn") await tx.update(s.localSecurity).set(mutation === "ldapIdentity" ? { ldapIdentity: "replacement-identity" } : { ldapDn: newDn }).where(eq(s.localSecurity.userId, actor.id));
        else if (mutation === "provider") vi.stubEnv("LDAP_ENABLED", "false");
        else await tx.update(s.users).set(mutation === "disabled" ? { disabled: true } : mutation === "sessionVersion" ? { sessionVersion: 1 }
          : mutation === "upn" ? { upn: "changed@fixture.invalid" } : mutation === "identityRealm" ? { identityRealm: "local", authSource: "local" } : { authSource: "entra" }).where(eq(s.users.id, actor.id));
      });
    } finally { release(); }
    expect(await rejected).toBe(true);
    expect(await db.select().from(s.authFlows)).toHaveLength(0);
  });
  async function consent(provider: string | null, session = actor) {
    fixture.webSession = { user: { id: session.id, sessionVersion: session.sessionVersion, sessionId: session.sessionId, mustChangePassword: false, authProvider: provider } };
    const verifier = "synthetic-pkce-verifier-with-at-least-43-characters-123456789";
    const form = new FormData();
    for (const [key, value] of Object.entries({ decision: "approve", state: "synthetic-state", auth_provider: "microsoft-entra-id", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" })) form.append(key, value);
    const request = new Request("https://fixture.invalid/api/mobile/auth/authorize", { method: "POST", headers: { origin: "https://fixture.invalid" }, body: form });
    fixture.requestHeaders = request.headers;
    const response = await authorizeMobile(request);
    return { response, verifier, code: response.headers.get("location") ? new URL(response.headers.get("location")!).searchParams.get("code") : null };
  }
  it.each([["ldap", "entra"], ["microsoft-entra-id", "ldap"]] as const)("pins a mobile code to the %s web session despite latest source %s", async (provider, latest) => {
    await db.update(s.users).set({ authSource: latest }).where(eq(s.users.id, actor.id));
    const approved = await consent(provider);
    expect(approved.response.status).toBe(303);
    expect((await db.select().from(s.mobileAuthCodes))[0].authProvider).toBe(provider);
    const mobile = await exchangeAuthCode(approved.code, approved.verifier);
    expect((await db.select().from(s.mobileSessions))[0].authProvider).toBe(provider);
    vi.stubEnv("LDAP_ENABLED", "false");
    expect(!!await mobilePrincipal(mobile.token)).toBe(provider === "microsoft-entra-id");
    if (provider === "microsoft-entra-id") {
      vi.stubEnv("AUTH_ENTRA_ENABLED", "false");
      expect(await mobilePrincipal(mobile.token)).toBeNull();
    }
  });
  it.each([null, "unknown"])("requires fresh web approval instead of minting an unattributed %s mobile code", async provider => {
    const approved = await consent(provider);
    expect(approved.response.status).toBe(403);
    expect(await db.select().from(s.mobileAuthCodes)).toHaveLength(0);
  });
  it("rejects a disabled approving provider before issuance and again between approval and exchange", async () => {
    await db.update(s.users).set({ authSource: "entra" }).where(eq(s.users.id, actor.id));
    vi.stubEnv("LDAP_ENABLED", "false");
    expect((await consent("ldap")).response.status).toBe(403);
    expect(await db.select().from(s.mobileAuthCodes)).toHaveLength(0);
    vi.stubEnv("LDAP_ENABLED", "true");
    const approved = await consent("ldap");
    vi.stubEnv("LDAP_ENABLED", "false");
    await expect(exchangeAuthCode(approved.code, approved.verifier)).rejects.toThrow(/Sign in/);
    expect(await db.select().from(s.mobileSessions)).toHaveLength(0);
  });
  it("preserves attributed local approvals and rejects them when the local provider is disabled", async () => {
    await db.update(s.users).set({ identityRealm: "local", authSource: "local", upn: "local:alice" }).where(eq(s.users.id, actor.id));
    await db.insert(s.localCredentials).values({ userId: actor.id, username: "alice", passwordHash: "synthetic-nonusable-password-hash", mustChangePassword: false });
    const approved = await consent("local");
    expect(approved.response.status).toBe(303);
    const mobile = await exchangeAuthCode(approved.code, approved.verifier);
    expect((await mobilePrincipal(mobile.token))?.session.authProvider).toBe("local");
    vi.stubEnv("AUTH_LOCAL_ENABLED", "false");
    expect(await mobilePrincipal(mobile.token)).toBeNull();
    vi.stubEnv("AUTH_LOCAL_ENABLED", "true");
  });
  it("requires the same current web session version and a real session id for device approval", async () => {
    const missing = await consent("ldap", { ...actor, sessionId: "" });
    expect(missing.response.status).toBe(403);
    const changed = await consent("ldap", { ...actor, sessionVersion: 1 });
    expect(changed.response.status).toBe(401);
    expect(await db.select().from(s.mobileAuthCodes)).toHaveLength(0);
  });
  it("rejects legacy unattributed mobile credentials but keeps known-provider credentials and web fallback", async () => {
    const verifier = "synthetic-pkce-verifier-with-at-least-43-characters-123456789", code = randomToken();
    await db.insert(s.mobileAuthCodes).values({ hash: sha256Hex(`mobile-code|${code}`), userId: actor.id, sessionVersion: actor.sessionVersion,
      authProvider: null, codeChallenge: pkceChallenge(verifier), deviceName: "Legacy fixture", expiresAt: new Date(Date.now() + 60000) });
    await expect(exchangeAuthCode(code, verifier)).rejects.toThrow(/approv/i);
    expect(await db.select().from(s.mobileAuthCodes)).toHaveLength(0);
    const token = "cui_m_" + randomToken();
    await db.insert(s.mobileSessions).values({ userId: actor.id, tokenHash: sha256Hex(`mobile-token|${token}`), deviceName: "Legacy fixture", sessionVersion: actor.sessionVersion,
      authProvider: null, expiresAt: new Date(Date.now() + 60000) });
    expect(await mobilePrincipal(token)).toBeNull();
    expect(await sessionState(actor.id, actor.sessionVersion)).toEqual({ mustChangePassword: false });
    const approved = await consent("ldap"), known = await exchangeAuthCode(approved.code, approved.verifier);
    expect(await mobilePrincipal(known.token)).toBeTruthy();
  });
  it("initially binds an unprotected directory account without changing its session version", async () => {
    await db.delete(s.localPasskeys); await db.delete(s.localRecoveryCodes); await db.delete(s.localSecurity);
    const login = await beginPasswordLogin("alice", "synthetic-password", new Headers(), binding, "ldap");
    expect(login.ticket).toBeTruthy(); expect(login.flow).toBeUndefined();
    expect((await db.select().from(s.localSecurity))[0]).toMatchObject({ ldapDn: newDn, ldapIdentity: "stable-identity" });
    expect((await db.select().from(s.users))[0].sessionVersion).toBe(actor.sessionVersion);
  });
});
