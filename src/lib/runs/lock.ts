import { sql } from "drizzle-orm";
import type { Tx } from "@/db";

/** Serializes admission, approval continuation and conversation commands for one user, across web processes. */
export async function lockUserRuns(tx: Tx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('runs:' || ${userId}, 0))`);
}
