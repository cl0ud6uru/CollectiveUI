import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export function clientAddress(headers: Headers) {
  // Opt in only behind a proxy that overwrites X-Real-IP and prevents direct access to the app.
  const value = headers.get("x-real-ip") ?? "";
  return process.env.AUTH_TRUST_PROXY === "true" && isIP(value) ? value : "shared";
}
function key(value: string) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is required");
  return createHmac("sha256", process.env.AUTH_SECRET).update(value).digest("hex");
}
async function consume(scope: string, limit: number, seconds: number) {
  const result = await db.execute<{ attempts: number }>(sql`
    INSERT INTO auth_throttle (key, attempts, expires_at)
    VALUES (${key(scope)}, 1, now() + ${seconds} * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN auth_throttle.expires_at <= now() THEN 1 ELSE LEAST(auth_throttle.attempts + 1, ${limit + 1}) END,
      expires_at = CASE WHEN auth_throttle.expires_at <= now() THEN now() + ${seconds} * interval '1 second' ELSE auth_throttle.expires_at END
    RETURNING attempts`);
  return result.rows[0].attempts <= limit;
}
/** Shared across replicas and restarts. Attempts include successes; never permanently lock an account. */
export async function allowPasswordAttempt(provider: string, identity: string, headers: Headers) {
  // Global first bounds both KDF work and adversarial growth of per-identity/source rows.
  if (!await consume("password:global", 120, 60)) return false;
  await db.execute(sql`DELETE FROM auth_throttle WHERE expires_at < now() - interval '1 hour'`);
  if (!await consume(`password:source:${clientAddress(headers)}`, 30, 900)) return false;
  return allowAccountAttempt(provider, identity);
}

/** Also used after LDAP lookup, before bind, to unify every alias of the same directory DN. */
export function allowAccountAttempt(provider: string, identity: string) {
  return consume(`password:${provider}:${identity}`, 10, 900);
}

/** Independent, persistent budgets for factor attempts and short-lived challenge allocation. */
export async function allowSecurityRequest(headers: Headers) {
  if (!await consume("security:global", 120, 60)) return false;
  await db.execute(sql`DELETE FROM auth_throttle WHERE expires_at < now() - interval '1 hour'`);
  return consume(`security:source:${clientAddress(headers)}`, 60, 300);
}
export function allowFactorAttempt(userId: string) { return consume(`security:factor:${userId}`, 5, 300); }
