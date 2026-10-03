import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { localSecurity, localPasskeys } from "@/db/schema";
export async function hasLocalFactors(userId: string, q: DbOrTx = db) {
  const [security] = await q.select({ totp: localSecurity.totpSecretEnc }).from(localSecurity).where(eq(localSecurity.userId, userId));
  if (security?.totp) return true;
  return (await q.select({ id: localPasskeys.id }).from(localPasskeys).where(eq(localPasskeys.userId, userId)).limit(1)).length > 0;
}
