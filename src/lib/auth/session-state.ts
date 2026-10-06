import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { localCredentials, users } from "@/db/schema";
import { providerEnabled } from "./config";
export async function sessionState(id: string, version: unknown, provider?: unknown, q: DbOrTx = db) {
  const [user] = await q.select().from(users).where(eq(users.id, id));
  if (!user || user.disabled || user.sessionVersion !== (version ?? 0)) return null;
  // Existing pre-migration directory tokens have no provider/version. Preserve them until their original expiry.
  const source = typeof provider === "string" ? provider : user.authSource === "entra" ? "microsoft-entra-id" : user.authSource;
  if (!providerEnabled(source) || (source === "local") !== (user.identityRealm === "local")) return null;
  if (source !== "local") return { mustChangePassword: false };
  const [credential] = await q.select({ mustChangePassword: localCredentials.mustChangePassword, temporaryExpiresAt: localCredentials.temporaryExpiresAt }).from(localCredentials).where(eq(localCredentials.userId, id));
  if (!credential || (credential.temporaryExpiresAt && credential.temporaryExpiresAt <= new Date())) return null;
  return { mustChangePassword: credential.mustChangePassword };
}

/** Snapshot legacy exp before Auth.js renews it; subsequent cookie refreshes cannot extend this deadline. */
export function absoluteSessionDeadline(token: { sessionDeadline?: unknown; signedInAt?: unknown; exp?: unknown }) {
  if (typeof token.sessionDeadline === "number") return token.sessionDeadline;
  if (typeof token.signedInAt === "number") return token.signedInAt + 43200;
  return typeof token.exp === "number" ? token.exp : 0;
}
