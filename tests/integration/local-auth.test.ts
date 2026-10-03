import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { auditLog, authThrottle, conversations, localAuthBootstrap, localCredentials, localLoginAliases, users, userExternalGroups } from "@/db/schema";
import { authenticateLocal, changeOwnPassword, changeUserAccess, createLocalUser, resetLocalPassword } from "@/lib/auth/local";
import { syncUserOnSignIn, loadPrincipal } from "@/lib/auth/groups";
import { sessionState } from "@/lib/auth/session-state";
import { getOwnedConversation } from "@/lib/authz";
import { allowPasswordAttempt } from "@/lib/auth/throttle";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const password = "Synthetic-local-fixture-phrase!42";
const replacement = "Synthetic-replacement-phrase!43";
const headers = new Headers();
let admin: { id: string; sessionVersion: number };
let member: { id: string; sessionVersion: number };
run("isolated local authentication lifecycle", () => {
  beforeAll(async () => {
    if (!/\/collective_local_[a-z_]*test$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Local auth suite requires an explicitly disposable collective_local_*test database");
    vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); vi.stubEnv("AUTH_SECRET", "synthetic-fixture-session-secret-not-for-production");
    vi.stubEnv("LOCAL_AUTH_OPERATOR", "bootstrap"); vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("LDAP_URL", "ldap://fixture.invalid");
    await db.delete(localAuthBootstrap);
    await db.delete(users).where(like(users.upn, "local:%"));
  });
  beforeEach(async () => { await db.delete(authThrottle); });
  afterAll(async () => { vi.unstubAllEnvs(); await pool.end(); });
  it("rejects bootstrap unless explicitly enabled, and races to exactly one initial admin", async () => {
    vi.stubEnv("LOCAL_AUTH_OPERATOR", "");
    await expect(createLocalUser({ username: "fixture-admin", name: "Fixture Admin", password }, "bootstrap")).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("LOCAL_AUTH_OPERATOR", "bootstrap");
    const attempts = await Promise.allSettled(["fixture-admin", "fixture-other"].map(username => createLocalUser({ username, name: "Fixture Admin", email: "fixture-admin@example.invalid", password }, "bootstrap")));
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(1);
    const [row] = await db.select().from(users).where(eq(users.identityRealm, "local"));
    admin = { id: row.id, sessionVersion: row.sessionVersion };
    expect(row.isAdmin).toBe(true);
    expect(await db.select().from(localAuthBootstrap)).toHaveLength(1);
  }, 15000);
  it("supports case-normalized username/email aliases and generic rejection cases", async () => {
    const user = await authenticateLocal("FIXTURE-ADMIN@example.invalid", password, headers);
    expect(user?.id).toBe(admin.id);
    for (const [name, pw] of [["fixture-admin@example.invalid", "wrong"], ["nobody", password], ["", ""], ["fixture-admin", "x".repeat(513)]]) expect(await authenticateLocal(name, pw, headers)).toBeNull();
    vi.stubEnv("AUTH_LOCAL_ENABLED", "false"); expect(await authenticateLocal("fixture-admin@example.invalid", password, headers)).toBeNull();
    expect(await sessionState(admin.id, 0, "local")).toBeNull(); vi.stubEnv("AUTH_LOCAL_ENABLED", "true");
  }, 15000);
  it("never links local accounts to directory identities, even matching emails and UPNs", async () => {
    const directory = await syncUserOnSignIn({ upn: "local:fixture-member", email: "fixture-member@example.invalid", name: "Directory Fixture", source: "ldap", groups: [{ externalId: "fixture-group" }] });
    const created = await createLocalUser({ username: "fixture-member", email: "fixture-member@example.invalid", name: "Local Fixture", password }, admin);
    member = { id: created.id, sessionVersion: 0 };
    expect(member.id).not.toBe(directory.id);
    const again = await syncUserOnSignIn({ upn: "local:fixture-member", email: "fixture-member@example.invalid", name: "Directory Fixture", source: "entra", groups: [] });
    expect(again.id).toBe(directory.id);
    vi.stubEnv("ADMIN_UPNS", "local:fixture-member"); vi.stubEnv("ADMIN_GROUPS", "fixture-group");
    await db.insert(userExternalGroups).values({ userId: member.id, source: "ldap", externalId: "fixture-group" });
    expect(await loadPrincipal(member.id)).toMatchObject({ isAdmin: false, groupIds: [] });
    expect(await sessionState(member.id, 0, "ldap")).toBeNull();
    expect(await sessionState(directory.id, 0, "local")).toBeNull();
    // Existing directory tokens without a version/provider remain valid; their disable switch is honored.
    expect(await sessionState(directory.id, undefined, "ldap")).not.toBeNull();
  }, 10000);
  it("limits temporary sessions, rejects reused passwords, changes own password and revokes old sessions", async () => {
    expect(await authenticateLocal("fixture-member@example.invalid", password, headers)).toMatchObject({ id: member.id, sessionVersion: 0 });
    expect(await sessionState(member.id, 0, "local")).toEqual({ mustChangePassword: true });
    await expect(changeOwnPassword(member, password, password, headers)).rejects.toMatchObject({ status: 400 });
    await expect(changeOwnPassword(member, "bad", replacement, headers)).rejects.toMatchObject({ status: 400 });
    await changeOwnPassword(member, password, replacement, headers);
    expect(await sessionState(member.id, 0, "local")).toBeNull();
    member.sessionVersion++;
    expect(await sessionState(member.id, 1, "local")).toEqual({ mustChangePassword: false });
    expect(await authenticateLocal("fixture-member", password, headers)).toBeNull();
    expect(await authenticateLocal("fixture-member", replacement, headers)).toMatchObject({ id: member.id, sessionVersion: 1 });
  }, 15000);
  it("denies ordinary/stale actors, duplicate aliases, directory resets and self-admin removal", async () => {
    await expect(createLocalUser({ username: "fixture-denied", name: "Denied", password }, member)).rejects.toMatchObject({ status: 403 });
    await expect(createLocalUser({ username: "fixture-duplicate", email: "fixture-member@example.invalid", name: "Duplicate", password }, admin)).rejects.toMatchObject({ status: 409 });
    await expect(changeUserAccess(member, admin.id, { disabled: true })).rejects.toMatchObject({ status: 403 });
    await expect(changeUserAccess({ ...admin, sessionVersion: 12 }, member.id, { isAdmin: true })).rejects.toMatchObject({ status: 403 });
    await expect(changeUserAccess(admin, admin.id, { isAdmin: false })).rejects.toMatchObject({ status: 400 });
    const [directory] = await db.select().from(users).where(and(eq(users.upn, "local:fixture-member"), eq(users.identityRealm, "directory")));
    await expect(resetLocalPassword(admin, directory.id, replacement)).rejects.toMatchObject({ status: 404 });
  }, 15000);
  it("revokes on disable/re-enable and reset, expires temporary credentials, and prevents stale password changes", async () => {
    await changeUserAccess(admin, member.id, { disabled: true });
    expect(await sessionState(member.id, 1, "local")).toBeNull();
    expect(await authenticateLocal("fixture-member", replacement, headers)).toBeNull();
    await changeUserAccess(admin, member.id, { disabled: false });
    expect(await sessionState(member.id, 1, "local")).toBeNull();
    await resetLocalPassword(admin, member.id, password);
    expect(await sessionState(member.id, 3, "local")).toBeNull();
    await expect(changeOwnPassword(member, password, replacement, headers)).rejects.toMatchObject({ status: 401 });
    member.sessionVersion = 4;
    expect(await sessionState(member.id, 4, "local")).toEqual({ mustChangePassword: true });
    await db.update(localCredentials).set({ temporaryExpiresAt: new Date(0) }).where(eq(localCredentials.userId, member.id));
    expect(await authenticateLocal("fixture-member", password, headers)).toBeNull();
    expect(await sessionState(member.id, 4, "local")).toBeNull();
  }, 15000);
  it("guards the final local admin even with a directory admin; operator recovers only existing admins", async () => {
    const directory = await syncUserOnSignIn({ upn: "fixture-external-admin@example.invalid", name: "Directory Admin", source: "ldap", groups: [] });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, directory.id));
    const actor = { id: directory.id, sessionVersion: 0 };
    for (const change of [{ isAdmin: false }, { disabled: true }]) await expect(changeUserAccess(actor, admin.id, change)).rejects.toMatchObject({ status: 400 });
    await expect(resetLocalPassword(actor, admin.id, replacement)).rejects.toMatchObject({ status: 400 });
    vi.stubEnv("LOCAL_AUTH_OPERATOR", ""); await expect(resetLocalPassword("recover-admin", admin.id, replacement)).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("LOCAL_AUTH_OPERATOR", "recover-admin");
    await expect(resetLocalPassword("recover-admin", member.id, replacement)).rejects.toMatchObject({ status: 403 });
    await db.update(users).set({ disabled: true }).where(eq(users.id, admin.id));
    await resetLocalPassword("recover-admin", admin.id, replacement);
    expect(await sessionState(admin.id, 0, "local")).toBeNull(); admin.sessionVersion = 1;
    expect(await sessionState(admin.id, 1, "local")).toEqual({ mustChangePassword: false });
  }, 20000);
  it("serializes concurrent demotions and preserves a working local administrator", async () => {
    const created = await createLocalUser({ username: "fixture-second", name: "Second admin", password, isAdmin: true }, admin);
    const second = { id: created.id, sessionVersion: 0 };
    await changeOwnPassword(second, password, replacement, headers); second.sessionVersion++;
    const [directory] = await db.select().from(users).where(eq(users.upn, "fixture-external-admin@example.invalid"));
    const actor = { id: directory.id, sessionVersion: 0 };
    const results = await Promise.allSettled([admin.id, second.id].map(id => changeUserAccess(actor, id, { isAdmin: false })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(users).where(and(eq(users.identityRealm, "local"), eq(users.isAdmin, true), eq(users.disabled, false)))).toHaveLength(1);
  }, 10000);
  it("enforces private conversation ownership across the separate identities", async () => {
    const p = (await loadPrincipal(member.id))!;
    const [conversation] = await db.insert(conversations).values({ userId: admin.id, title: "Synthetic private chat" }).returning();
    await expect(getOwnedConversation(p, conversation.id)).rejects.toMatchObject({ status: 404 });
  });
  it("atomically throttles parallel attempts, shares username/email buckets and expires counters", async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => allowPasswordAttempt("local", member.id, headers)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await authenticateLocal("fixture-member", password, headers)).toBeNull();
    expect(await authenticateLocal("fixture-member@example.invalid", password, headers)).toBeNull();
    await db.update(authThrottle).set({ expiresAt: new Date(0) });
    expect(await allowPasswordAttempt("local", member.id, headers)).toBe(true);
    const rows = await db.select().from(authThrottle);
    expect(rows.every(r => /^[a-f0-9]{64}$/.test(r.key))).toBe(true);
  });
  it("persists the bootstrap marker and never includes password material in audit records", async () => {
    const audit = JSON.stringify(await db.select().from(auditLog));
    expect(audit).not.toContain(password); expect(audit).not.toContain(replacement); expect(audit).not.toContain("scrypt$");
    expect(audit).toContain("local.operator_recovery");
    await db.delete(users).where(eq(users.identityRealm, "local"));
    expect(await db.select().from(localLoginAliases)).toHaveLength(0);
    vi.stubEnv("LOCAL_AUTH_OPERATOR", "bootstrap");
    await expect(createLocalUser({ username: "fixture-rebootstrap", name: "No", password }, "bootstrap")).rejects.toMatchObject({ status: 409 });
    await db.execute(sql`SELECT 1`);
  }, 10000);
});
