import { drizzle } from "drizzle-orm/node-postgres";
import { pool, schema, type DB } from "@/db";

/**
 * Serializes workspace allocation, account retention, and destruction for one owner across portal processes.
 * The dedicated connection keeps the session lock while individual database transactions commit around I/O.
 */
export async function withWorkspaceUserLock<T>(userId: string, run: (database: DB) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  const key = `workspace-owner:${userId}`;
  let acquired = false;
  try {
    await connection.query("select pg_advisory_lock(hashtext($1))", [key]);
    acquired = true;
    // The transaction-capable drizzle client accepts PoolClient at runtime; its generic type expects Pool.
    return await run(drizzle(connection, { schema }) as unknown as DB);
  } finally {
    let releaseError: Error | undefined;
    if (acquired) {
      try {
        await connection.query("select pg_advisory_unlock(hashtext($1))", [key]);
      } catch (err) {
        releaseError = err instanceof Error ? err : new Error(String(err));
      }
    }
    connection.release(releaseError);
  }
}
