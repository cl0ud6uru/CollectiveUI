import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { liveActivities, mobileAuthCodes, mobileSessions } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { sessionState } from "@/lib/auth/session-state";
import { mobileEnabled } from "@/lib/auth/config";
import { randomToken, sha256Hex } from "@/lib/crypto";

/**
 * Native app sign-in. The app opens /mobile/authorize in a system browser sheet (ASWebAuthenticationSession), where the
 * person signs in with any web method and approves the device. That returns a one-time code to the app's URL scheme;
 * the app redeems it with its PKCE verifier for an opaque bearer token. Tokens are stored hashed, expire, can be revoked
 * from Settings, and die with the account's sessionVersion like web sessions do.
 */

export const MOBILE_CALLBACK = "collectiveui://auth/callback";
const TOKEN_PREFIX = "cui_m_";
const CODE_TTL_MS = 2 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Operator switch (server configuration only). Off by default, like other new sign-in surfaces. */
export { mobileEnabled } from "@/lib/auth/config";

export function mobileSessionTtlMs() {
  const days = Number(process.env.MOBILE_SESSION_DAYS ?? 30);
  return (Number.isFinite(days) ? Math.min(Math.max(days, 1), 365) : 30) * 24 * 60 * 60 * 1000;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_RE = /^[A-Za-z0-9._~-]{8,128}$/;

export type AuthorizeRequest = { codeChallenge: string; state: string; deviceName: string };

/** Validates the app's authorize parameters (query string or the consent form). Null when anything is off. */
export function parseAuthorizeRequest(get: (name: string) => unknown): AuthorizeRequest | null {
  const codeChallenge = get("code_challenge");
  const state = get("state");
  const method = get("code_challenge_method");
  const rawName = get("device_name");
  if (typeof codeChallenge !== "string" || !CHALLENGE_RE.test(codeChallenge)) return null;
  if (typeof state !== "string" || !STATE_RE.test(state)) return null;
  if (method != null && method !== "" && method !== "S256") return null;
  return { codeChallenge, state, deviceName: deviceLabel(rawName) };
}

/** A display label only: printable, single line, bounded. */
export function deviceLabel(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[\p{C}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100) : "";
  return text || "iOS device";
}

export function callbackUrl(params: Record<string, string>) {
  return `${MOBILE_CALLBACK}?${new URLSearchParams(params).toString()}`;
}

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** After the person approved in the browser: a short-lived code bound to the PKCE challenge and their current sessions. */
export async function issueAuthCode(p: Principal, req: AuthorizeRequest, authProvider?: string | null): Promise<string> {
  const code = randomToken("", 32);
  await db.delete(mobileAuthCodes).where(lt(mobileAuthCodes.expiresAt, new Date()));
  await db.insert(mobileAuthCodes).values({
    hash: sha256Hex(`mobile-code|${code}`),
    userId: p.user.id,
    sessionVersion: p.user.sessionVersion,
    authProvider: authProvider ?? null,
    codeChallenge: req.codeChallenge,
    deviceName: req.deviceName,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

export class MobileAuthError extends Error {}

/** Redeems a code once (it is deleted whether or not the verifier matches). */
export async function exchangeAuthCode(code: unknown, verifier: unknown) {
  if (!mobileEnabled()) throw new MobileAuthError("Mobile sign-in is turned off on this server");
  if (typeof code !== "string" || code.length < 20 || code.length > 100 || typeof verifier !== "string" || !VERIFIER_RE.test(verifier))
    throw new MobileAuthError("Invalid sign-in code");
  const [row] = await db.delete(mobileAuthCodes)
    .where(and(eq(mobileAuthCodes.hash, sha256Hex(`mobile-code|${code}`)), gt(mobileAuthCodes.expiresAt, new Date())))
    .returning();
  if (!row || !sameString(pkceChallenge(verifier), row.codeChallenge)) throw new MobileAuthError("Invalid or expired sign-in code");
  const state = await sessionState(row.userId, row.sessionVersion, row.authProvider ?? undefined);
  if (!state || state.mustChangePassword) throw new MobileAuthError("Sign in on the web first");
  const principal = await loadPrincipal(row.userId);
  if (!principal) throw new MobileAuthError("Account unavailable");

  const token = randomToken(TOKEN_PREFIX, 32);
  const expiresAt = new Date(Date.now() + mobileSessionTtlMs());
  await db.insert(mobileSessions).values({
    userId: row.userId,
    tokenHash: sha256Hex(`mobile-token|${token}`),
    deviceName: row.deviceName,
    sessionVersion: row.sessionVersion,
    authProvider: row.authProvider,
    expiresAt,
  });
  return { token, expiresAt, principal };
}

/**
 * The bearer token of a request: undefined without a Bearer Authorization header (other schemes, e.g. Basic from a
 * reverse proxy, are not ours), null when it is a Bearer header but not a mobile token.
 */
export function bearerToken(headers: Headers): string | null | undefined {
  const value = headers.get("authorization")?.trim();
  if (!value || !/^Bearer(\s|$)/i.test(value)) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(value);
  return m && m[1].startsWith(TOKEN_PREFIX) && m[1].length <= 100 ? m[1] : null;
}

export type MobileSession = typeof mobileSessions.$inferSelect;

/** The principal behind a mobile token, re-checking the account like a web session refresh does. */
export async function mobilePrincipal(token: string): Promise<{ principal: Principal; session: MobileSession } | null> {
  if (!mobileEnabled()) return null;
  const now = new Date();
  const [session] = await db.select().from(mobileSessions)
    .where(and(eq(mobileSessions.tokenHash, sha256Hex(`mobile-token|${token}`)), isNull(mobileSessions.revokedAt), gt(mobileSessions.expiresAt, now)));
  if (!session) return null;
  const state = await sessionState(session.userId, session.sessionVersion, session.authProvider ?? undefined);
  if (!state || state.mustChangePassword) return null;
  const principal = await loadPrincipal(session.userId);
  if (!principal || principal.user.sessionVersion !== session.sessionVersion) return null;
  if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS)
    await db.update(mobileSessions).set({ lastUsedAt: now }).where(eq(mobileSessions.id, session.id)).catch(() => {});
  return { principal, session };
}

/** Signed-in devices for Settings: current ones only (not revoked, unexpired, same sessionVersion). */
export async function listMobileSessions(p: Principal) {
  const rows = await db.select({
    id: mobileSessions.id, deviceName: mobileSessions.deviceName, createdAt: mobileSessions.createdAt,
    lastUsedAt: mobileSessions.lastUsedAt, expiresAt: mobileSessions.expiresAt, sessionVersion: mobileSessions.sessionVersion,
  }).from(mobileSessions)
    .where(and(eq(mobileSessions.userId, p.user.id), isNull(mobileSessions.revokedAt), gt(mobileSessions.expiresAt, new Date())))
    .orderBy(desc(mobileSessions.lastUsedAt));
  return rows.filter((r) => r.sessionVersion === p.user.sessionVersion)
    .map((r) => ({ id: r.id, deviceName: r.deviceName, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt }));
}

export async function revokeMobileSession(userId: string, id?: string) {
  await db.transaction(async (tx) => {
    const revoked = await tx.update(mobileSessions).set({ revokedAt: new Date() })
      .where(and(eq(mobileSessions.userId, userId), isNull(mobileSessions.revokedAt), ...(id ? [eq(mobileSessions.id, id)] : [])))
      .returning({ id: mobileSessions.id });
    for (const row of revoked) await tx.delete(liveActivities).where(eq(liveActivities.sessionId, row.id));
  });
}
