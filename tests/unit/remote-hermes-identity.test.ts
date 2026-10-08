import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns } from '@/db/schema';

const f = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle>, account: 'account-a', nextId: null as string | null }));
vi.mock('@/db', () => ({ get db() { return f.db; } }));
vi.mock('@/lib/ids', async original => {
  const actual = await original<typeof import('@/lib/ids')>();
  return { ...actual, newId: () => f.nextId ?? actual.newId() };
});
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: true, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardFetch: () => vi.fn() }));
vi.mock('@/lib/remote-hermes/client', async original => {
  const actual = await original<typeof import('@/lib/remote-hermes/client')>();
  return { ...actual, DashboardClient: class {
    status = async () => ({ version: 'fixture', authRequired: true });
    passwordLogin = async () => ({ mode: 'password', accessToken: `synthetic-${f.account}`, userId: f.account });
    profiles = async () => [{ name: 'default' }];
  } };
});
import { connectRemoteHermes } from '@/lib/remote-hermes/store';
import { registerNativeConnection } from '@/lib/remote-hermes/lifecycle';

let client: PGlite | undefined;
afterEach(async () => { await client?.close(); });
it('replaces authorization identity atomically without transferring account A bindings or receipts to overlapping account B profiles', async () => {
  client = new PGlite(); await client.waitReady;
  await client.exec('CREATE TABLE users (id text PRIMARY KEY); CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO users VALUES (\'owner\'), (\'other-owner\');');
  for (const tag of ['0030_remote_hermes_connections', '0031_remote_hermes_sessions', '0032_remote_hermes_reservations']) {
    await client.exec(readFileSync(`src/db/migrations/${tag}.sql`, 'utf8'));
  }
  f.db = drizzle(client); f.account = 'account-a';
  const input = { name: 'Fixture', baseUrl: 'https://hermes.example.com', mode: 'password' as const, username: 'synthetic', password: 'synthetic' };
  const accountA = await connectRemoteHermes('owner', input);
  const other = await connectRemoteHermes('other-owner', input);
  const retired = vi.fn(); const otherRetired = vi.fn();
  const unregister = registerNativeConnection('owner', accountA.connection.id, retired);
  const unregisterOther = registerNativeConnection('other-owner', other.connection.id, otherRetired);
  try {
    await f.db.insert(remoteHermesSessions).values([
      { id: 'a-idle', connectionId: accountA.connection.id, profile: 'default', storedId: 'shared-stored-id' },
      { id: 'a-active', connectionId: accountA.connection.id, profile: 'default', storedId: 'a-running', runtimeId: 'a-runtime', status: 'waiting', admissionRequestId: 'admitted' },
      { id: 'other-active', connectionId: other.connection.id, profile: 'default', storedId: 'shared-stored-id', status: 'running' },
    ]);
    await f.db.insert(remoteHermesTurns).values({ id: 'a-receipt', sessionId: 'a-active', requestId: 'admitted', digest: 'synthetic-digest' });
    f.account = 'account-b';
    const accountB = await connectRemoteHermes('owner', input);
    expect(accountB.profiles).toEqual(accountA.profiles);
    expect(accountB.connection.id).not.toBe(accountA.connection.id);
    expect(await f.db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, accountA.connection.id))).toEqual([]);
    expect((await f.db.select().from(remoteHermesSessions)).map(row => row.id)).toEqual(['other-active']);
    expect(await f.db.select().from(remoteHermesTurns)).toEqual([]);
    expect(retired).toHaveBeenCalledOnce(); expect(otherRetired).not.toHaveBeenCalled();
    // The replacement account may reopen only sessions it independently lists;
    // overlapping profile/native IDs never adopt the old local binding.
    await f.db.insert(remoteHermesSessions).values({ id: 'b-local', connectionId: accountB.connection.id, profile: 'default', storedId: 'shared-stored-id' });
    expect((await f.db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.connectionId, accountB.connection.id))).map(row => row.id)).toEqual(['b-local']);
    const failedRetirement = vi.fn();
    const unregisterB = registerNativeConnection('owner', accountB.connection.id, failedRetirement);
    try {
      // Force a real insert constraint failure after deleting the old binding.
      f.nextId = other.connection.id;
      await expect(connectRemoteHermes('owner', input)).rejects.toThrow();
      expect((await f.db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, accountB.connection.id))).map(row => row.id)).toEqual([accountB.connection.id]);
      expect((await f.db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, 'b-local'))).map(row => row.id)).toEqual(['b-local']);
      expect(failedRetirement).not.toHaveBeenCalled();
    } finally { f.nextId = null; unregisterB(); }
  } finally { unregister(); unregisterOther(); }
}, 60_000);
