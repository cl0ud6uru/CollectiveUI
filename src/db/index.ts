import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/portal",
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
if (process.env.NODE_ENV !== "production") globalForDb.pgPool = pool;

export const db = drizzle(pool, { schema });
export type DB = typeof db;
/** A transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Either the pool-backed client or a transaction; store helpers take one so callers can compose them in a transaction. */
export type DbOrTx = DB | Tx;
export { schema };
