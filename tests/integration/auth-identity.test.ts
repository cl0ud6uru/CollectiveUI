import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { LdapUser } from "@/lib/auth/ldap";
import type { SecurityActor } from "@/lib/auth/security";

const fixture = vi.hoisted(() => ({ directory: null as LdapUser | null, verified: null as { user: unknown; identity: LdapUser } | null,
  read: vi.fn(), authenticate: vi.fn(), atBinding: vi.fn() }));
vi.mock("@/lib/auth/ldap", async (original) => ({ ...await original<typeof import("@/lib/auth/ldap")>(), readLdapIdentity: fixture.read, authenticateLdapAtBinding: fixture.atBinding }));
vi.mock("@/lib/auth/ldap-account", () => ({ authenticateLdapPassword: fixture.authenticate }));
import { db, pool, schema as s } from "@/db";
import { beginPasswordLogin, finishPasswordLogin, consumeLoginTicket, reauthenticatePassword } from "@/lib/auth/security";
import { recoveryHash } from "@/lib/auth/factors";

const run = process.env.AUTH_IDENTITY_POSTGRES_PROOF === "1" ? describe : describe.skip;
const binding = "synthetic-browser-binding-at-least-20-characters";
const recovery = "11111111-22222222-33333333-44444444-55555555";
const oldDn = "uid=alice,ou=old,dc=fixture", newDn = "uid=alice,ou=new,dc=fixture";
let actor: SecurityActor;
run("LDAP identity repair and account lock scope (disposable PostgreSQL, synthetic directory)", () => {
  beforeAll(() => {
    if (process.env.DATABASE_URL !== "postgres://fixture_auth:synthetic-auth-only@127.0.0.1:55444/collective_auth_identity_test") throw new Error("Requires exact disposable auth identity PostgreSQL target");
    vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("LDAP_URL", "ldaps://fixture.invalid"); vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); vi.stubEnv("AUTH_SECRET", "synthetic-auth-identity-session-secret");
  });
  beforeEach(async () => {
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
  afterAll(async () => { vi.unstubAllEnvs(); await pool.end(); });
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
  it("initially binds an unprotected directory account without changing its session version", async () => {
    await db.delete(s.localPasskeys); await db.delete(s.localRecoveryCodes); await db.delete(s.localSecurity);
    const login = await beginPasswordLogin("alice", "synthetic-password", new Headers(), binding, "ldap");
    expect(login.ticket).toBeTruthy(); expect(login.flow).toBeUndefined();
    expect((await db.select().from(s.localSecurity))[0]).toMatchObject({ ldapDn: newDn, ldapIdentity: "stable-identity" });
    expect((await db.select().from(s.users))[0].sessionVersion).toBe(actor.sessionVersion);
  });
});
