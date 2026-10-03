import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { generate } from "otplib";
import { db, pool } from "@/db";
import { authFlows, authThrottle, auditLog, localAuthBootstrap, localCredentials, localSecurity, localPasskeys, localRecoveryCodes, users } from "@/db/schema";
import { createLocalUser, authenticateLocal, resetLocalPassword, changeOwnPassword } from "@/lib/auth/local";
import { beginPasswordLogin, finishPasswordLogin, consumeLoginTicket, reauthenticatePassword, beginTotp, finishTotp, manageSecurity, securitySummary, beginRegistration, finishRegistration, beginPasskey, type SecurityActor } from "@/lib/auth/security";
import { sessionState } from "@/lib/auth/session-state";
import { hashPassword } from "@/lib/auth/password";
import { recoveryHash } from "@/lib/auth/factors";
import { randomToken, sha256Hex } from "@/lib/crypto";
const run = process.env.LOCAL_MFA_INTEGRATION === "1" ? describe : describe.skip;
const password = "Synthetic-factor-fixture-phrase!42", replacement = "Synthetic-factor-replacement!43";
const headers = new Headers(), binding = randomToken(), otherBinding = randomToken();
let actor: SecurityActor; let secret: string; let codes: string[]; let originalHash: string;
const proof = async (op: string, code = "", recovery = false) => (await reauthenticatePassword(actor, op, password, code, recovery, headers)).proof!;
async function clearThrottle() { await db.delete(authThrottle); }
async function recoverProof(op: string) { const code = codes.shift()!; return proof(op, code, true); }
run("local factors on a disposable database", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.endsWith("/collective_local_mfa_test")) throw new Error("Requires disposable collective_local_mfa_test");
    vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); vi.stubEnv("AUTH_URL", "http://localhost:3100"); vi.stubEnv("AUTH_SECRET", "synthetic-factor-session-secret-for-tests");
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 71).toString("base64")); vi.stubEnv("ENCRYPTION_KEYS", ""); vi.stubEnv("LOCAL_AUTH_OPERATOR", "bootstrap");
    await db.delete(users).where(like(users.upn, "local:%")); await db.delete(users).where(eq(users.upn, "mfa-fixture@example.invalid")); await db.delete(localAuthBootstrap); await clearThrottle();
    const created = await createLocalUser({ username: "mfa-fixture", name: "Synthetic MFA Fixture", email: "mfa-fixture@example.invalid", password }, "bootstrap");
    actor = { id: created.id, sessionVersion: 0, sessionId: randomToken() };
    originalHash = (await db.select().from(localCredentials).where(eq(localCredentials.userId, actor.id)))[0].passwordHash;
  });
  beforeEach(clearThrottle);
  afterAll(async () => { vi.unstubAllEnvs(); await pool.end(); });
  it("keeps unprotected users optional, uses hashed browser-bound one-shot tickets and validates expiry", async () => {
    expect(await authenticateLocal("mfa-fixture", password, headers)).toMatchObject({ id: actor.id });
    const first = await beginPasswordLogin("mfa-fixture@example.invalid", password, headers, binding);
    expect(first.ticket).toBeTruthy(); expect(first.flow).toBeUndefined();
    expect(JSON.stringify(await db.select().from(authFlows))).not.toContain(first.ticket!);
    await expect(consumeLoginTicket(first.ticket!, otherBinding)).rejects.toThrow();
    const race = await Promise.allSettled([consumeLoginTicket(first.ticket!, binding), consumeLoginTicket(first.ticket!, binding)]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const expired = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    await db.update(authFlows).set({ expiresAt: new Date(0) });
    await expect(consumeLoginTicket(expired.ticket!, binding)).rejects.toThrow();
    await expect(beginPasswordLogin("unknown", password, headers, binding)).rejects.toThrow();
  }, 15000);
  it("requires session/purpose-bound reauthentication, rejects temporary enrollment and consumes failed challenges", async () => {
    const grant = await proof("add-totp");
    await expect(beginTotp({ ...actor, sessionId: otherBinding }, grant)).rejects.toThrow();
    await expect(beginRegistration(actor, grant, "Wrong purpose")).rejects.toThrow();
    const pending = await beginTotp(actor, grant); secret = pending.secret;
    expect((await securitySummary(actor)).totp).toBe(false);
    expect(JSON.stringify(await db.select().from(authFlows))).not.toContain(secret);
    await expect(finishTotp(actor, pending.flow, "bad")).rejects.toThrow();
    await expect(finishTotp(actor, pending.flow, await generate({ secret }))).rejects.toThrow();
    await clearThrottle();
    await db.update(localCredentials).set({ mustChangePassword: true }).where(eq(localCredentials.userId, actor.id));
    await expect(proof("add-totp")).rejects.toThrow();
    await db.update(localCredentials).set({ mustChangePassword: false }).where(eq(localCredentials.userId, actor.id));
  }, 15000);
  it("activates only verified pending TOTP, supplies hashed recovery codes and revokes old sessions/tickets", async () => {
    const staleTicket = (await beginPasswordLogin("mfa-fixture", password, headers, binding)).ticket!;
    const pending = await beginTotp(actor, await proof("add-totp")); secret = pending.secret;
    const activationCode = await generate({ secret });
    const activated = await finishTotp(actor, pending.flow, activationCode); codes = activated.codes!;
    expect(codes).toHaveLength(10); expect(activated.signOut).toBe(true);
    expect(await sessionState(actor.id, actor.sessionVersion, "local")).toBeNull();
    await expect(consumeLoginTicket(staleTicket, binding)).rejects.toThrow();
    actor.sessionVersion++; actor.sessionId = randomToken();
    expect(await authenticateLocal("MFA-FIXTURE@example.invalid", password, headers)).toBeNull();
    const preauth = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    expect(preauth.ticket).toBeUndefined(); expect(preauth.flow).toBeTruthy();
    // Activation consumes the current TOTP step too.
    await expect(finishPasswordLogin(preauth.flow!, activationCode, false, binding)).rejects.toThrow();
    const stored = JSON.stringify(await db.select().from(localRecoveryCodes));
    for (const c of codes) expect(stored).not.toContain(c);
    expect((await securitySummary(actor)).totp).toBe(true);
    await expect(changeOwnPassword(actor, password, replacement, headers)).rejects.toThrow();
  }, 20000);
  it("atomically rejects TOTP/recovery replay and only mints a ticket after the password and factor", async () => {
    // Move synthetic accepted-step watermark back; production has no override/clock parameter.
    await db.update(localSecurity).set({ totpLastStep: 0 }).where(eq(localSecurity.userId, actor.id));
    const flows = await Promise.all([beginPasswordLogin("mfa-fixture", password, headers, binding), beginPasswordLogin("mfa-fixture@example.invalid", password, headers, binding)]);
    const code = await generate({ secret });
    const results = await Promise.allSettled(flows.map(f => finishPasswordLogin(f.flow!, code, false, binding)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const good = results.find(r => r.status === "fulfilled")! as PromiseFulfilledResult<{ ticket: string }>;
    expect(await consumeLoginTicket(good.value.ticket, binding)).toMatchObject({ id: actor.id });
    const recovery = codes.shift()!;
    const f1 = await beginPasswordLogin("mfa-fixture", password, headers, binding), f2 = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    const race = await Promise.allSettled([finishPasswordLogin(f1.flow!, recovery, true, binding), finishPasswordLogin(f2.flow!, recovery, true, binding)]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(localRecoveryCodes).where(eq(localRecoveryCodes.hash, recoveryHash(actor.id, recovery)))).toHaveLength(0);
  }, 20000);
  it("cannot remove the final factor; regeneration is strong, one-shot and invalidates prior codes", async () => {
    await expect(manageSecurity(actor, "remove-totp", await recoverProof("remove-totp"))).rejects.toThrow();
    expect((await securitySummary(actor)).totp).toBe(true);
    const old = [...codes];
    const grant = await recoverProof("recovery");
    const regenerated = await manageSecurity(actor, "recovery", grant); codes = regenerated.codes!;
    await expect(manageSecurity(actor, "recovery", grant)).rejects.toThrow();
    actor.sessionVersion++; actor.sessionId = randomToken();
    for (const c of old) expect(await db.select().from(localRecoveryCodes).where(eq(localRecoveryCodes.hash, recoveryHash(actor.id, c)))).toHaveLength(0);
    expect((await securitySummary(actor)).recoveryCount).toBe(10);
  }, 15000);
  it("preserves factors across operator password reset and handles restricted temporary-password changes", async () => {
    const preauth = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    vi.stubEnv("LOCAL_AUTH_OPERATOR", "recover-admin");
    await resetLocalPassword("recover-admin", actor.id, replacement);
    expect(await db.select().from(localSecurity).where(and(eq(localSecurity.userId, actor.id)))).toHaveLength(1);
    await expect(finishPasswordLogin(preauth.flow!, codes[0], true, binding)).rejects.toThrow();
    actor.sessionVersion++; actor.sessionId = randomToken();
    expect(await authenticateLocal("mfa-fixture", replacement, headers)).toBeNull();
    await db.update(localCredentials).set({ mustChangePassword: true }).where(eq(localCredentials.userId, actor.id));
    const p = await reauthenticatePassword(actor, "password", replacement, codes.shift()!, true, headers);
    await manageSecurity(actor, "password", p.proof!, password);
    actor.sessionVersion++; actor.sessionId = randomToken();
    expect(await sessionState(actor.id, actor.sessionVersion, "local")).toEqual({ mustChangePassword: false });
    expect((await securitySummary(actor)).totp).toBe(true);
    expect(originalHash).not.toBe((await db.select().from(localCredentials).where(eq(localCredentials.userId, actor.id)))[0].passwordHash);
  }, 20000);
  it("rechecks disabled/provider/version changes throughout and throttles failed attempts across aliases", async () => {
    const start = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    await db.update(users).set({ disabled: true }).where(eq(users.id, actor.id));
    await expect(finishPasswordLogin(start.flow!, codes[0], true, binding)).rejects.toThrow();
    await db.update(users).set({ disabled: false, sessionVersion: actor.sessionVersion + 1 }).where(eq(users.id, actor.id));
    await expect(proof("add-passkey", codes[0], true)).rejects.toThrow();
    actor.sessionVersion++; actor.sessionId = randomToken();
    const next = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    vi.stubEnv("AUTH_LOCAL_ENABLED", "false");
    await expect(finishPasswordLogin(next.flow!, codes[0], true, binding)).rejects.toThrow();
    vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); await clearThrottle();
    for (let i = 0; i < 5; i++) {
      const f = await beginPasswordLogin(i % 2 ? "mfa-fixture@example.invalid" : "mfa-fixture", password, headers, binding);
      await expect(finishPasswordLogin(f.flow!, "00000000", false, binding)).rejects.toThrow();
    }
    const last = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    await expect(finishPasswordLogin(last.flow!, codes[0], true, binding)).rejects.toThrow();
  }, 30000);
  it("blocks direct login for passkey-only accounts; owner/version checks and failed WebAuthn challenges are one-shot", async () => {
    const grant = await recoverProof("add-passkey");
    const registration = await beginRegistration(actor, grant, "Synthetic key");
    expect(registration.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(registration.options.user.id).not.toContain("mfa-fixture");
    await expect(finishRegistration(actor, registration.flow, {} as never)).rejects.toThrow();
    expect(await db.select().from(authFlows).where(eq(authFlows.hash, sha256Hex(registration.flow)))).toHaveLength(0);
    await db.insert(localPasskeys).values({ id: "synthetic-non-usable-public-credential", userId: actor.id, name: "Synthetic DB fixture", publicKey: "non-usable", counter: 0, deviceType: "multiDevice", backedUp: true, transports: [] });
    await db.update(localSecurity).set({ totpSecretEnc: null, totpLastStep: null }).where(eq(localSecurity.userId, actor.id));
    expect(await authenticateLocal("mfa-fixture", password, headers)).toBeNull();
    const begin = await beginPasskey(binding); expect(begin.options.userVerification).toBe("required"); expect(begin.options.allowCredentials ?? []).toHaveLength(0);
    for (const op of ["disable", "remove-passkey"]) await expect(beginPasskey("", actor, op)).rejects.toThrow();
    await expect(manageSecurity(actor, "remove-passkey", await recoverProof("remove-passkey"), "foreign-credential")).rejects.toThrow();
    expect((await securitySummary(actor)).passkeys).toHaveLength(1);
  }, 20000);
  it("replenishes the final recovery code at login so a lost-device user can actually recover", async () => {
    await db.delete(localRecoveryCodes).where(eq(localRecoveryCodes.userId, actor.id));
    const last = codes[0];
    await db.insert(localRecoveryCodes).values({ userId: actor.id, hash: recoveryHash(actor.id, last) });
    const start = await beginPasswordLogin("mfa-fixture", password, headers, binding);
    const result = await finishPasswordLogin(start.flow!, last, true, binding);
    expect(result.codes).toHaveLength(10); expect(result.recoveryRotated).toBe(true);
    expect(await sessionState(actor.id, actor.sessionVersion, "local")).toBeNull();
    actor.sessionVersion++; actor.sessionId = randomToken(); codes = result.codes!;
    expect(await consumeLoginTicket(result.ticket, binding)).toMatchObject({ id: actor.id, sessionVersion: actor.sessionVersion });
    const recovered = await manageSecurity(actor, "recovery", await recoverProof("recovery"));
    actor.sessionVersion++; actor.sessionId = randomToken(); codes = recovered.codes!;
    expect(codes).toHaveLength(10);
    // Final-code use during management also rotates safely instead of stranding a signed-in user.
    const finalManagementCode = codes[0];
    await db.delete(localRecoveryCodes).where(eq(localRecoveryCodes.userId, actor.id));
    await db.insert(localRecoveryCodes).values({ userId: actor.id, hash: recoveryHash(actor.id, finalManagementCode) });
    const rotated = await reauthenticatePassword(actor, "add-passkey", password, finalManagementCode, true, headers);
    expect(rotated.proof).toBeUndefined(); expect(rotated.signOut).toBe(true); expect(rotated.codes).toHaveLength(10);
    actor.sessionVersion++; actor.sessionId = randomToken(); codes = rotated.codes!;
  }, 15000);
  it("disables only with full reauthentication, revokes sessions and leaves no secret material in audit", async () => {
    const grant = await recoverProof("disable");
    await manageSecurity(actor, "disable", grant); actor.sessionVersion++;
    expect(await db.select().from(localPasskeys).where(eq(localPasskeys.userId, actor.id))).toHaveLength(0);
    expect(await db.select().from(localRecoveryCodes).where(eq(localRecoveryCodes.userId, actor.id))).toHaveLength(0);
    expect((await securitySummary(actor)).totp).toBe(false);
    const unprotected = await reauthenticatePassword(actor, "add-totp", password, "not-a-verified-code", true, headers);
    expect(unprotected.codes).toBeUndefined(); expect(unprotected.proof).toBeTruthy();
    expect((await securitySummary(actor)).recoveryCount).toBe(0);
    expect(await authenticateLocal("mfa-fixture", password, headers)).toMatchObject({ id: actor.id });
    const log = JSON.stringify(await db.select().from(auditLog));
    for (const sensitive of [secret, password, replacement, ...codes]) expect(log).not.toContain(sensitive);
    expect(log).toContain("security.recovery_used"); expect(log).toContain("security.disable");
    // Local and directory rows sharing email never share security profiles.
    const [directory] = await db.insert(users).values({ upn: "mfa-fixture@example.invalid", name: "Directory fixture", authSource: "entra", email: "mfa-fixture@example.invalid" }).returning();
    await expect(securitySummary({ ...actor, id: directory.id, sessionVersion: 0 })).rejects.toThrow();
    await expect(db.insert(localSecurity).values({ userId: directory.id, userHandle: randomToken() })).rejects.toThrow();
    expect(await hashPassword(password)).toBeTruthy();
  }, 15000);
});
