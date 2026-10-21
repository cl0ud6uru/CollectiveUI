import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, auditLog } from '@/db/schema';

const f = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle>, transport: vi.fn() }));
vi.mock('@/db', () => ({ get db() { return f.db; } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: false, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardFetch: f.transport }));
import { prepareRemoteRemoval, removeRemoteConnection } from '@/lib/remote-hermes/store';
import { registerNativeConnection } from '@/lib/remote-hermes/lifecycle';
let client: PGlite;
beforeEach(async () => {
  vi.clearAllMocks(); f.transport.mockImplementation(() => { throw new Error('Removal must not contact Hermes'); });
  client = new PGlite(); await client.waitReady;
  await client.exec("CREATE TABLE users (id text PRIMARY KEY); CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO users VALUES ('owner'), ('other');");
  for (const tag of ['0030_remote_hermes_connections', '0031_remote_hermes_sessions', '0032_remote_hermes_reservations', '0062_remote_hermes_hub_ownership']) await client.exec(readFileSync(`src/db/migrations/${tag}.sql`, 'utf8'));
  await client.exec("CREATE TABLE audit_log (id text PRIMARY KEY, actor_id text REFERENCES users(id), action text NOT NULL, target text, details jsonb, created_at timestamptz NOT NULL DEFAULT now());");
  f.db = drizzle(client);
  await f.db.insert(remoteHermesConnections).values([
    { id: 'connection', userId: 'owner', name: 'Fixture', baseUrl: 'https://hermes.example.com', authMode: 'sessionToken', secretEnc: 'synthetic-retained-token' },
    { id: 'other-connection', userId: 'other', name: 'Other', baseUrl: 'https://hermes.example.com', authMode: 'sessionToken', secretEnc: 'synthetic-other-token' },
  ]);
  await f.db.insert(remoteHermesSessions).values({ id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored' });
  await f.db.insert(remoteHermesTurns).values({ id: 'receipt', sessionId: 'session', requestId: 'synthetic-request', digest: 'synthetic-digest' });
});
afterEach(async () => { await client.close(); });
describe('owner-scoped remote Hermes removal', () => {
  it('removes local credentials and cascaded bindings/receipts while admission is disabled, then retires its hub', async () => {
    const retired = vi.fn(), otherRetired = vi.fn();
    const unregister = registerNativeConnection('owner', 'connection', retired), unregisterOther = registerNativeConnection('other', 'other-connection', otherRetired);
    try {
      expect(await prepareRemoteRemoval('owner', 'connection')).toEqual({ activeSessions: 0 });
      expect(await removeRemoteConnection('owner', 'connection', { confirmActive: false })).toEqual({ removed: true, activeSessions: 0, upstreamRevoked: false, nativeConversationsRetained: true });
      expect(await f.db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, 'connection'))).toEqual([]);
      expect(await f.db.select().from(remoteHermesSessions)).toEqual([]);
      expect(await f.db.select().from(remoteHermesTurns)).toEqual([]);
      expect((await f.db.select().from(remoteHermesConnections)).map(row => row.id)).toEqual(['other-connection']);
      expect(await f.db.select().from(auditLog)).toMatchObject([{ actorId: 'owner', action: 'hermes.remote.removed', target: 'connection', details: { activeSessions: 0, upstreamRevoked: false } }]);
      expect(retired).toHaveBeenCalledOnce(); expect(otherRetired).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    } finally { unregister(); unregisterOther(); }
  });
  it.each(['running', 'waiting', 'admitting', 'uncertain', 'queued'] as const)('requires active-work confirmation for %s, including work admitted after preview', async status => {
    expect(await prepareRemoteRemoval('owner', 'connection')).toEqual({ activeSessions: 0 });
    await f.db.update(remoteHermesSessions).set(status === 'queued' ? { queueRequestId: 'queue', queueStatus: 'uncertain' } : { status }).where(eq(remoteHermesSessions.id, 'session'));
    const retired = vi.fn(); const unregister = registerNativeConnection('owner', 'connection', retired);
    try {
      expect(await removeRemoteConnection('owner', 'connection', { confirmActive: false })).toEqual({ removed: false, activeSessions: 1 });
      expect(retired).not.toHaveBeenCalled();
      expect((await f.db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, 'connection')))).toHaveLength(1);
      expect(await removeRemoteConnection('owner', 'connection', { confirmActive: true })).toMatchObject({ removed: true, activeSessions: 1 });
      expect(retired).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });
  it('rejects cross-owner preview/removal without contacting Hermes or retiring anything', async () => {
    const retired = vi.fn(); const unregister = registerNativeConnection('owner', 'connection', retired);
    try {
      await expect(prepareRemoteRemoval('other', 'connection')).rejects.toThrow('not found');
      await expect(removeRemoteConnection('other', 'connection', { confirmActive: true })).rejects.toThrow('not found');
      expect(retired).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
      expect(await f.db.select().from(remoteHermesConnections)).toHaveLength(2);
    } finally { unregister(); }
  });
  it('does not retire a hub or erase local state when credential deletion rolls back', async () => {
    await client.exec("CREATE FUNCTION reject_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic removal failure'; END; $$; CREATE TRIGGER refuse_removal BEFORE DELETE ON remote_hermes_connections FOR EACH ROW EXECUTE FUNCTION reject_removal();");
    const retired = vi.fn(); const unregister = registerNativeConnection('owner', 'connection', retired);
    try {
      await expect(removeRemoteConnection('owner', 'connection', { confirmActive: true })).rejects.toThrow();
      expect((await f.db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, 'connection')))[0].secretEnc).toBe('synthetic-retained-token');
      expect(await f.db.select().from(remoteHermesSessions)).toHaveLength(1);
      expect(await f.db.select().from(remoteHermesTurns)).toHaveLength(1);
      expect(retired).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it('rolls back credential deletion and keeps the hub when the transactional audit insert fails', async () => {
    await client.exec("CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END; $$; CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_audit();");
    const retired = vi.fn(); const unregister = registerNativeConnection('owner', 'connection', retired);
    try {
      await expect(removeRemoteConnection('owner', 'connection', { confirmActive: true })).rejects.toThrow();
      expect(await f.db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, 'connection'))).toHaveLength(1);
      expect(await f.db.select().from(remoteHermesSessions)).toHaveLength(1);
      expect(await f.db.select().from(remoteHermesTurns)).toHaveLength(1);
      expect(await f.db.select().from(auditLog)).toEqual([]);
      expect(retired).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

});
