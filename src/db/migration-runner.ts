import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { MigrationConfig } from "drizzle-orm/migrator";
import type { Pool } from "pg";
import type { DB } from "./index";
import * as schema from "./schema";

// Stable across releases: every deployment must serialize before checking the journal.
const MIGRATION_LOCK = [0x435549, 0x4d4947];

/** Hold the session lock across Drizzle's journal check, migration transaction and bootstrap. */
export async function runMigrations(pool: Pool, config: MigrationConfig, bootstrap?: (db: Omit<DB, "$client">) => Promise<unknown>) {
  const client = await pool.connect();
  let locked = false;
  let discard = false;
  try {
    await client.query("select pg_advisory_lock($1, $2)", MIGRATION_LOCK);
    locked = true;
    const db = drizzle(client, { schema });
    await migrate(db, config);
    await bootstrap?.(db);
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock($1, $2)", MIGRATION_LOCK);
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      // A failed unlock must never return a session holding the lock to the pool.
      client.release(discard);
    }
  }
}
