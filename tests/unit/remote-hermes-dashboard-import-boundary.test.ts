import { expect, it, vi } from 'vitest';
const f = vi.hoisted(() => {
  process.env.REMOTE_HERMES_NATIVE_DATABASE_CONFORMANCE = '0';
  process.env.REMOTE_HERMES_INTEGRATION = '0';
  process.env.REMOTE_HERMES_PORTAL_RECOVERY_CONFORMANCE = '0';
  return { databaseImported: false };
});
vi.mock('@/db', () => { f.databaseImported = true; return { db: {}, pool: {} }; });
// Discovery/skip must be safe even when no disposable database was authorized.
// A transitive authz import from client/socket previously constructed the pool here.
import '../integration/remote-hermes-dashboard-conformance.test';
import '../integration/remote-hermes-reservations.test';
import '../integration/remote-hermes-portal-recovery.test';
it('does not import a database-backed module while discovering opt-in native fixtures', () => {
  expect(f.databaseImported).toBe(false);
});
