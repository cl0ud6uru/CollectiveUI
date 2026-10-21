import { attachmentPostgresURL } from './attachment-postgres-proof.mjs';

const connectionString = attachmentPostgresURL();
const { Pool } = await import('pg');
const { drizzle } = await import('drizzle-orm/node-postgres');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');
const pool = new Pool({ connectionString, max: 2 });
try {
  await migrate(drizzle(pool), { migrationsFolder: 'src/db/migrations' });
  console.log('Dedicated attachment PostgreSQL fixture migrated');
} finally {
  await pool.end();
}
