import { and, eq, gt, lt, sql } from "drizzle-orm";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@collective/webauthn-server";
import { decodeClientDataJSON } from "@collective/webauthn-server/helpers";
import { db, type DbOrTx, type Tx } from "@/db";
import { auditLog, authFlows, localCredentials, localPasskeys, localRecoveryCodes, localSecurity, users } from "@/db/schema";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { authenticateLocalPassword, lockAccounts } from "./local";
import { localEnabled } from "./config";
import { allowFactorAttempt, allowPasswordAttempt } from "./throttle";
import { hasLocalFactors } from "./factor-state";
import { hashPassword, validateNewPassword, verifyPassword } from "./password";
import { checkTotp, createRecoveryCodes, createTotp, recoveryHash, securityConfig, SecurityError } from "./factors";

export type SecurityActor = { id: string; sessionVersion: number; sessionId: string };
export type SecurityOperation = "add-passkey" | "add-totp" | "remove-passkey" | "remove-totp" | "recovery" | "disable" | "password";
const operations: SecurityOperation[] = ["add-passkey", "add-totp", "remove-passkey", "remove-totp", "recovery", "disable", "password"];
function crossOriginResponse(data: string) {
  const client = decodeClientDataJSON(data);
  return client.crossOrigin === true || client.topOrigin !== undefined;
}
function fail(): never { throw new SecurityError(); }
function operation(value: string): asserts value is SecurityOperation { if (!operations.includes(value as SecurityOperation)) fail(); }
const digestBinding = (value: string) => { if (value.length < 20 || value.length > 200) fail(); return sha256Hex(`binding|${value}`); };
type Account = { id: string; sessionVersion: number };
type Flow = typeof authFlows.$inferSelect;

async function issue(q: DbOrTx, purpose: string, binding: string, account?: Account, data: Record<string, string> = {}, seconds = 300) {
  if (seconds <= 0) fail();
  const token = randomToken();
  await q.delete(authFlows).where(lt(authFlows.expiresAt, new Date()));
  await q.insert(authFlows).values({ hash: sha256Hex(token), purpose, bindingHash: digestBinding(binding),
    userId: account?.id, sessionVersion: account?.sessionVersion, data, expiresAt: new Date(Date.now() + seconds * 1000) });
  return token;
}
/** Commit consumption BEFORE verification. A failed verifier/transaction cannot resurrect a proof. */
async function take(token: string, purpose: string, binding: string): Promise<Flow> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail();
  const [flow] = await db.delete(authFlows).where(and(eq(authFlows.hash, sha256Hex(token)), eq(authFlows.purpose, purpose),
    eq(authFlows.bindingHash, digestBinding(binding)), gt(authFlows.expiresAt, new Date()))).returning();
  if (!flow) fail();
  return flow;
}
async function account(tx: Tx, expected: Account, permanent = false) {
  if (!localEnabled()) fail();
  const [row] = await tx.select({ user: users, credential: localCredentials }).from(users)
    .innerJoin(localCredentials, eq(localCredentials.userId, users.id)).where(eq(users.id, expected.id));
  if (!row || row.user.identityRealm !== "local" || row.user.disabled || row.user.sessionVersion !== expected.sessionVersion ||
    (row.credential.temporaryExpiresAt && row.credential.temporaryExpiresAt <= new Date()) || (permanent && row.credential.mustChangePassword)) fail();
  return row;
}
function flowAccount(flow: Flow): Account { if (!flow.userId || flow.sessionVersion === null) fail(); return { id: flow.userId, sessionVersion: flow.sessionVersion }; }
async function locked<T>(expected: Account, fn: (tx: Tx, row: Awaited<ReturnType<typeof account>>) => Promise<T>, permanent = false) {
  return db.transaction(async tx => { await lockAccounts(tx); return fn(tx, await account(tx, expected, permanent)); });
}
async function profile(tx: Tx, id: string) {
  await tx.insert(localSecurity).values({ userId: id, userHandle: randomToken() }).onConflictDoNothing();
  return (await tx.select().from(localSecurity).where(eq(localSecurity.userId, id)))[0];
}
async function audit(tx: Tx, userId: string, action: string) { await tx.insert(auditLog).values({ actorId: userId, action: `security.${action}`, target: userId }); }
async function changed(tx: Tx, userId: string, action: string) {
  await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, authChangedAt: sql`clock_timestamp()` }).where(eq(users.id, userId));
  await tx.delete(authFlows).where(eq(authFlows.userId, userId));
  await audit(tx, userId, action);
}
async function recoveryCodes(tx: Tx, id: string) {
  const codes = createRecoveryCodes();
  await tx.delete(localRecoveryCodes).where(eq(localRecoveryCodes.userId, id));
  await tx.insert(localRecoveryCodes).values(codes.map(code => ({ userId: id, hash: recoveryHash(id, code) })));
  return codes;
}
async function replenishFinalRecoveryCode(tx: Tx, userId: string, recovery: boolean) {
  if (!recovery || (await tx.select({ hash: localRecoveryCodes.hash }).from(localRecoveryCodes).where(eq(localRecoveryCodes.userId, userId)).limit(1)).length) return undefined;
  const codes = await recoveryCodes(tx, userId);
  await changed(tx, userId, "final_recovery_rotated");
  return codes;
}
async function verifyCode(tx: Tx, id: string, code: string, recovery: boolean) {
  if (recovery) {
    if (!/^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{8}){4}$/.test(code.trim())) fail();
    const rows = await tx.delete(localRecoveryCodes).where(and(eq(localRecoveryCodes.userId, id), eq(localRecoveryCodes.hash, recoveryHash(id, code)))).returning({ hash: localRecoveryCodes.hash });
    if (!rows.length) fail();
    await audit(tx, id, "recovery_used");
  } else {
    const [p] = await tx.select().from(localSecurity).where(eq(localSecurity.userId, id));
    if (!p?.totpSecretEnc) fail();
    const step = await checkTotp(p.totpSecretEnc, id, code, p.totpLastStep ?? undefined);
    await tx.update(localSecurity).set({ totpLastStep: step }).where(eq(localSecurity.userId, id));
  }
}

export async function beginPasswordLogin(username: string, password: string, headers: Headers, binding: string) {
  const user = await authenticateLocalPassword(username, password, headers);
  if (!user) fail();
  return locked(user, async (tx, { credential }) => {
    if (!await hasLocalFactors(user.id, tx)) return { mustChangePassword: credential.mustChangePassword, ticket: await issue(tx, "login-ticket", binding, user, {}, 60) };
    return { flow: await issue(tx, "password-factor", binding, user) };
  });
}
export async function finishPasswordLogin(token: string, code: string, recovery: boolean, binding: string) {
  const flow = await take(token, "password-factor", binding), expected = flowAccount(flow);
  if (!await allowFactorAttempt(expected.id)) fail();
  return locked(expected, async (tx, { credential }) => {
    if (!await hasLocalFactors(expected.id, tx)) fail();
    await verifyCode(tx, expected.id, code, recovery);
    await audit(tx, expected.id, "password_factor_login");
    const codes = await replenishFinalRecoveryCode(tx, expected.id, recovery);
    const current = { id: expected.id, sessionVersion: expected.sessionVersion + (codes ? 1 : 0) };
    return { codes, recoveryRotated: !!codes, mustChangePassword: credential.mustChangePassword, ticket: await issue(tx, "login-ticket", binding, current, {}, 60) };
  });
}
export async function consumeLoginTicket(token: string, binding: string) {
  const flow = await take(token, "login-ticket", binding);
  return locked(flowAccount(flow), async (tx, { user }) => {
    await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    return { id: user.id, name: user.name, email: user.email, sessionVersion: user.sessionVersion };
  });
}
export async function beginPasskey(binding: string, actor?: SecurityActor, op?: string) {
  const config = securityConfig();
  if (!localEnabled()) fail();
  const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: "required" });
  const data = { challenge: options.challenge, origin: config.origin, rpID: config.rpID, op: op ?? "" };
  if (actor) {
    operation(op ?? "");
    // Destructive method removal must prove the remaining password path is usable.
    if (op === "disable" || op === "remove-passkey") fail();
    return locked(actor, async tx => ({ options, flow: await issue(tx, "passkey-reauth", actor.sessionId, actor, data) }), op !== "password");
  }
  return { options, flow: await issue(db, "passkey-login", binding, undefined, data) };
}
async function assertion(tx: Tx, response: AuthenticationResponseJSON, flow: Flow, id: string) {
  const config = securityConfig();
  if (flow.data.origin !== config.origin || flow.data.rpID !== config.rpID) fail();
  const [p] = await tx.select().from(localSecurity).where(eq(localSecurity.userId, id));
  const [key] = await tx.select().from(localPasskeys).where(and(eq(localPasskeys.id, response.id), eq(localPasskeys.userId, id)));
  if (!p || !key || response.response.userHandle !== p.userHandle) fail();
  if (crossOriginResponse(response.response.clientDataJSON)) fail();
  const result = await verifyAuthenticationResponse({ response, expectedChallenge: flow.data.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID,
    requireUserVerification: true, credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: key.transports } });
  if (!result.verified || result.authenticationInfo.credentialDeviceType !== key.deviceType) fail();
  await tx.update(localPasskeys).set({ counter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp, lastUsedAt: new Date() }).where(eq(localPasskeys.id, key.id));
}
export async function finishPasskey(token: string, response: AuthenticationResponseJSON, binding: string, actor?: SecurityActor) {
  const flow = await take(token, actor ? "passkey-reauth" : "passkey-login", actor?.sessionId ?? binding);
  if (!response || typeof response.id !== "string" || response.id.length > 2048) fail();
  const [key] = await db.select({ userId: localPasskeys.userId }).from(localPasskeys).where(eq(localPasskeys.id, response.id));
  if (!key || !await allowFactorAttempt(key.userId)) fail();
  if (actor && (key.userId !== actor.id || flow.userId !== actor.id || flow.sessionVersion !== actor.sessionVersion)) fail();
  // For discoverable login, snapshot version before verification; under lock all checks are repeated.
  const [user] = await db.select({ id: users.id, sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, key.userId));
  if (!user) fail();
  return locked(actor ?? user, async (tx, { credential, user: currentUser }) => {
    // Anonymous discovery cannot bind an account version until the credential is known.
    // Database-clock timestamps invalidate even an already signed, unsubmitted old assertion.
    if (currentUser.authChangedAt && flow.createdAt <= currentUser.authChangedAt) fail();
    await assertion(tx, response, flow, key.userId);
    await audit(tx, key.userId, actor ? "reauth_passkey" : "passkey_login");
    if (actor) return { proof: await issue(tx, `reauth:${flow.data.op}`, actor.sessionId, actor) };
    return { mustChangePassword: credential.mustChangePassword, ticket: await issue(tx, "login-ticket", binding, user, {}, 60) };
  }, !!actor && flow.data.op !== "password");
}
export async function reauthenticatePassword(actor: SecurityActor, op: string, password: string, code: string, recovery: boolean, headers: Headers) {
  operation(op);
  if (!await allowPasswordAttempt("security-reauth", actor.id, headers) || !await allowFactorAttempt(actor.id)) fail();
  const [credential] = await db.select().from(localCredentials).where(eq(localCredentials.userId, actor.id));
  if (!credential || !await verifyPassword(password, credential.passwordHash)) fail();
  return locked(actor, async tx => {
    const protectedAccount = await hasLocalFactors(actor.id, tx);
    if (protectedAccount) await verifyCode(tx, actor.id, code, recovery);
    await audit(tx, actor.id, "reauth_password");
    const codes = await replenishFinalRecoveryCode(tx, actor.id, protectedAccount && recovery);
    if (codes) return { codes, signOut: true, recoveryRotated: true };
    return { proof: await issue(tx, `reauth:${op}`, actor.sessionId, actor, { passwordVerified: "true" }) };
  }, op !== "password");
}
async function takeReauth(actor: SecurityActor, op: string, token: string) {
  const flow = await take(token, `reauth:${op}`, actor.sessionId);
  if (flow.userId !== actor.id || flow.sessionVersion !== actor.sessionVersion) fail();
  return flow;
}
export async function securitySummary(actor: SecurityActor) {
  return locked(actor, async tx => {
    const [p] = await tx.select({ totp: localSecurity.totpSecretEnc }).from(localSecurity).where(eq(localSecurity.userId, actor.id));
    const passkeys = await tx.select({ id: localPasskeys.id, name: localPasskeys.name, createdAt: localPasskeys.createdAt, lastUsedAt: localPasskeys.lastUsedAt, deviceType: localPasskeys.deviceType, backedUp: localPasskeys.backedUp }).from(localPasskeys).where(eq(localPasskeys.userId, actor.id));
    const codes = await tx.select({ hash: localRecoveryCodes.hash }).from(localRecoveryCodes).where(eq(localRecoveryCodes.userId, actor.id));
    return { totp: !!p?.totp, passkeys, recoveryCount: codes.length };
  });
}
export async function beginRegistration(actor: SecurityActor, proof: string, name: string) {
  const grant = await takeReauth(actor, "add-passkey", proof);
  if (!name.trim() || name.trim().length > 80) fail();
  return locked(actor, async (tx, { credential }) => {
    const p = await profile(tx, actor.id);
    const keys = await tx.select().from(localPasskeys).where(eq(localPasskeys.userId, actor.id));
    if (keys.length >= 10) fail();
    const config = securityConfig();
    const options = await generateRegistrationOptions({ rpID: config.rpID, rpName: config.rpName, userID: new Uint8Array(Buffer.from(p.userHandle, "base64url")),
      userName: credential.username, attestationType: "none", excludeCredentials: keys.map(k => ({ id: k.id, transports: k.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    return { options, flow: await issue(tx, "register", actor.sessionId, actor, { challenge: options.challenge, origin: config.origin, rpID: config.rpID, name: name.trim() }, (grant.expiresAt.getTime() - Date.now()) / 1000) };
  }, true);
}
export async function finishRegistration(actor: SecurityActor, token: string, response: RegistrationResponseJSON) {
  const flow = await take(token, "register", actor.sessionId);
  if (flow.userId !== actor.id || flow.sessionVersion !== actor.sessionVersion || !await allowFactorAttempt(actor.id)) fail();
  return locked(actor, async tx => {
    const config = securityConfig();
    if (flow.data.origin !== config.origin || flow.data.rpID !== config.rpID) fail();
    if (crossOriginResponse(response.response.clientDataJSON)) fail();
    const result = await verifyRegistrationResponse({ response, expectedChallenge: flow.data.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo || response.clientExtensionResults.credProps?.rk === false) fail();
    const keys = await tx.select({ id: localPasskeys.id }).from(localPasskeys).where(eq(localPasskeys.userId, actor.id));
    if (keys.length >= 10) fail();
    const wasProtected = await hasLocalFactors(actor.id, tx);
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    await tx.insert(localPasskeys).values({ id: credential.id, userId: actor.id, name: flow.data.name, publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter, deviceType: credentialDeviceType, backedUp: credentialBackedUp, transports: credential.transports ?? [] });
    const codes = wasProtected ? undefined : await recoveryCodes(tx, actor.id);
    await changed(tx, actor.id, "passkey_added");
    return { codes, signOut: true };
  }, true);
}
export async function beginTotp(actor: SecurityActor, proof: string) {
  const grant = await takeReauth(actor, "add-totp", proof);
  return locked(actor, async (tx, { credential }) => {
    const p = await profile(tx, actor.id);
    if (p.totpSecretEnc) fail();
    const totp = createTotp(actor.id, credential.username);
    return { secret: totp.secret, uri: totp.uri, flow: await issue(tx, "totp-enroll", actor.sessionId, actor, { totpEnc: totp.totpEnc }, (grant.expiresAt.getTime() - Date.now()) / 1000) };
  }, true);
}
export async function finishTotp(actor: SecurityActor, token: string, code: string) {
  const flow = await take(token, "totp-enroll", actor.sessionId);
  if (flow.userId !== actor.id || flow.sessionVersion !== actor.sessionVersion || !await allowFactorAttempt(actor.id)) fail();
  return locked(actor, async tx => {
    const p = await profile(tx, actor.id);
    if (p.totpSecretEnc) fail();
    const step = await checkTotp(flow.data.totpEnc, actor.id, code);
    const wasProtected = await hasLocalFactors(actor.id, tx);
    await tx.update(localSecurity).set({ totpSecretEnc: flow.data.totpEnc, totpLastStep: step }).where(eq(localSecurity.userId, actor.id));
    const codes = wasProtected ? undefined : await recoveryCodes(tx, actor.id);
    await changed(tx, actor.id, "totp_enabled");
    return { codes, signOut: true };
  }, true);
}
export async function manageSecurity(actor: SecurityActor, op: string, proof: string, value = "") {
  operation(op);
  if (["add-passkey", "add-totp"].includes(op)) fail();
  const grant = await takeReauth(actor, op, proof);
  if ((op === "disable" || op === "remove-passkey") && grant.data.passwordVerified !== "true") fail();
  let passwordHash: string | undefined;
  if (op === "password") { validateNewPassword(value); passwordHash = await hashPassword(value); }
  return locked(actor, async tx => {
    const protectedAccount = await hasLocalFactors(actor.id, tx);
    let codes: string[] | undefined;
    if (op === "remove-passkey") {
      const removed = await tx.delete(localPasskeys).where(and(eq(localPasskeys.id, value), eq(localPasskeys.userId, actor.id))).returning({ id: localPasskeys.id });
      if (!removed.length || !await hasLocalFactors(actor.id, tx)) fail();
    } else if (op === "remove-totp") {
      const [p] = await tx.select().from(localSecurity).where(eq(localSecurity.userId, actor.id));
      if (!p?.totpSecretEnc) fail();
      await tx.update(localSecurity).set({ totpSecretEnc: null, totpLastStep: null }).where(eq(localSecurity.userId, actor.id));
      if (!await hasLocalFactors(actor.id, tx)) fail();
    } else if (op === "recovery") {
      if (!protectedAccount) fail();
      codes = await recoveryCodes(tx, actor.id);
    } else if (op === "disable") {
      if (!protectedAccount) fail();
      await tx.delete(localPasskeys).where(eq(localPasskeys.userId, actor.id));
      await tx.delete(localRecoveryCodes).where(eq(localRecoveryCodes.userId, actor.id));
      await tx.update(localSecurity).set({ totpSecretEnc: null, totpLastStep: null }).where(eq(localSecurity.userId, actor.id));
    } else if (op === "password" && passwordHash) {
      await tx.update(localCredentials).set({ passwordHash, mustChangePassword: false, temporaryExpiresAt: null, updatedAt: new Date() }).where(eq(localCredentials.userId, actor.id));
    }
    await changed(tx, actor.id, op.replaceAll("-", "_"));
    return { codes, signOut: true };
  }, op !== "password");
}
