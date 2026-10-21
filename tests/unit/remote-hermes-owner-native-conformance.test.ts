/** Optional local transport proof. This uses PGlite, NOT a PostgreSQL server.
 * The separate integration project runs the same production/native cases against disposable PostgreSQL. */
import { vi } from 'vitest';
vi.hoisted(() => {
  if (process.env.REMOTE_HERMES_PORTAL_LOCAL_CONFORMANCE !== '1') {
    process.env.REMOTE_HERMES_OWNER_CONFORMANCE = '0';
  } else {
    process.env.REMOTE_HERMES_OWNER_CONFORMANCE = '1';
    // No PostgreSQL driver/pool is imported: the module is replaced below before suite import.
    process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1/hermes_fixture';
  }
});
vi.mock('@/db', async () => {
  if (process.env.REMOTE_HERMES_PORTAL_LOCAL_CONFORMANCE !== '1') return { db: {}, pool: { end: async () => {} } };
  const { readFile } = await import('node:fs/promises');
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  await client.exec(`CREATE TABLE users (
    id text PRIMARY KEY,upn text NOT NULL,identity_realm text NOT NULL DEFAULT 'directory',session_version integer NOT NULL DEFAULT 0,
    auth_changed_at timestamptz,email text,name text NOT NULL,auth_source text NOT NULL,is_admin boolean NOT NULL DEFAULT false,
    disabled boolean NOT NULL DEFAULT false,prefs jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),last_login_at timestamptz
  ); CREATE TABLE settings (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz DEFAULT now() NOT NULL);`);
  for (const migration of ['0030_remote_hermes_connections', '0031_remote_hermes_sessions', '0032_remote_hermes_reservations', '0062_remote_hermes_hub_ownership', '0063_remote_hermes_recovery']) {
    await client.exec((await readFile(`src/db/migrations/${migration}.sql`, 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
  return { db: drizzle(client), pool: { end: async () => { await client.close(); } } };
});
await import('../integration/remote-hermes-owner-conformance.test');
