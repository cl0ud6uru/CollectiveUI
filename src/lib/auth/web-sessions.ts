import { createHash } from "node:crypto";
import { and, eq, isNull, gt, lte, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { webSessions } from "@/db/web-sessions";

export type WebSessionIdentity = { userId: string; sessionId: string; sessionVersion: number; expiresAt: Date };
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const webSessionRegistryEnabled = (env: Record<string, string | undefined> = process.env) => env.AUTH_WEB_SESSION_REGISTRY_ENABLED === "1";
const hash = (id: string) => createHash("sha256").update(`collective:web-session:v1:${id}`).digest("hex");

export function webSessionIdentity(token: { uid?: unknown; authSessionId?: unknown; sessionVersion?: unknown; sessionDeadline?: unknown }): WebSessionIdentity | null {
  if (typeof token.uid !== "string" || !token.uid || token.uid.length > 200 || typeof token.authSessionId !== "string" || !SESSION_ID.test(token.authSessionId) ||
      !Number.isSafeInteger(token.sessionVersion) || Number(token.sessionVersion) < 0 || typeof token.sessionDeadline !== "number" || !Number.isFinite(token.sessionDeadline)) return null;
  const expiresAt = new Date(token.sessionDeadline * 1000);
  if (!Number.isFinite(expiresAt.getTime())) return null;
  return { userId: token.uid, sessionId: token.authSessionId, sessionVersion: Number(token.sessionVersion), expiresAt };
}

/** Call only after Auth.js verified the JWT and current account/sessionVersion. Never revive a revoked row. */
export async function admitWebSession(identity: WebSessionIdentity, q: DbOrTx = db): Promise<boolean> {
  if (!SESSION_ID.test(identity.sessionId) || identity.expiresAt <= new Date()) return false;
  await q.insert(webSessions).values({ sessionIdHash: hash(identity.sessionId), userId: identity.userId,
    sessionVersion: identity.sessionVersion, expiresAt: identity.expiresAt }).onConflictDoNothing({ target: webSessions.sessionIdHash });
  return activeWebSession(identity, q);
}

/** Read-only: a viewer cannot register or extend a session, and an old request cookie cannot override logout. */
export async function activeWebSession(identity: Pick<WebSessionIdentity, "userId" | "sessionId" | "sessionVersion">, q: DbOrTx = db): Promise<boolean> {
  if (!SESSION_ID.test(identity.sessionId)) return false;
  const [row] = await q.select({ hash: webSessions.sessionIdHash }).from(webSessions).where(and(
    eq(webSessions.sessionIdHash, hash(identity.sessionId)), eq(webSessions.userId, identity.userId),
    eq(webSessions.sessionVersion, identity.sessionVersion), isNull(webSessions.revokedAt), gt(webSessions.expiresAt, sql`clock_timestamp()`),
  ));
  return !!row;
}

/** Sign-out creates a tombstone even for pre-registry JWTs; a concurrent admission cannot resurrect it. */
export async function revokeWebSession(identity: WebSessionIdentity, q: DbOrTx = db): Promise<void> {
  if (!SESSION_ID.test(identity.sessionId)) throw new Error("Invalid authenticated web session");
  await q.insert(webSessions).values({ sessionIdHash: hash(identity.sessionId), userId: identity.userId,
    sessionVersion: identity.sessionVersion, expiresAt: identity.expiresAt, revokedAt: new Date() })
    .onConflictDoUpdate({ target: webSessions.sessionIdHash,
      setWhere: and(eq(webSessions.userId, identity.userId), eq(webSessions.sessionVersion, identity.sessionVersion)),
      set: { revokedAt: sql`coalesce(${webSessions.revokedAt}, clock_timestamp())` } });
}

/** Remove at most 1,000 expired rows using DB time. Never delete a still-valid revocation tombstone. */
export async function cleanupExpiredWebSessions(q: DbOrTx = db): Promise<number> {
  const expired = q.select({ id: webSessions.sessionIdHash }).from(webSessions)
    .where(lte(webSessions.expiresAt, sql`clock_timestamp()`)).orderBy(webSessions.expiresAt).limit(1000);
  const removed = await q.delete(webSessions).where(inArray(webSessions.sessionIdHash, expired)).returning({ id: webSessions.sessionIdHash });
  return removed.length;
}
