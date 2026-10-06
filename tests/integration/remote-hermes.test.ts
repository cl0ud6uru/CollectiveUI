import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { remoteHermesConnections, remoteHermesSessions, remoteHermesTurns, users } from '@/db/schema';
import { newId } from '@/lib/ids';
import { ownedNativeSession } from '@/lib/remote-hermes/sessions';

// This suite creates synthetic rows only in an explicitly opted-in disposable database.
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const enabled = process.env.REMOTE_HERMES_INTEGRATION === '1' && url?.pathname === '/hermes_fixture';
const owner = newId(), connection = newId(), session = newId();
describe.skipIf(!enabled)('native Hermes database bindings', () => {
  beforeAll(async () => {
    await db.insert(users).values({ id: owner, upn: `hermes-fixture-${owner}`, name: 'Synthetic Hermes owner', identityRealm: 'local', authSource: 'local' });
    await db.insert(remoteHermesConnections).values({ id: connection, userId: owner, name: 'Synthetic connection', baseUrl: `https://${connection}.example.com`, authMode: 'sessionToken', secretEnc: 'synthetic-not-a-real-credential' });
    await db.insert(remoteHermesSessions).values({ id: session, connectionId: connection, profile: 'default', storedId: 'native-stored' });
  });
  afterAll(async () => { await db.delete(users).where(eq(users.id, owner)); });
  it('loads a native binding only for its owner and connection', async () => {
    expect((await ownedNativeSession(owner, connection, session)).storedId).toBe('native-stored');
    await expect(ownedNativeSession('another-owner', connection, session)).rejects.toThrow('not found');
    await expect(ownedNativeSession(owner, 'another-connection', session)).rejects.toThrow('not found');
  });
  it('enforces unique native identities and per-session submission receipts', async () => {
    await expect(db.insert(remoteHermesSessions).values({ id: newId(), connectionId: connection, profile: 'default', storedId: 'native-stored' })).rejects.toThrow();
    await db.insert(remoteHermesTurns).values({ id: newId(), sessionId: session, requestId: 'fixture-receipt', digest: 'fixture-digest' });
    await expect(db.insert(remoteHermesTurns).values({ id: newId(), sessionId: session, requestId: 'fixture-receipt', digest: 'fixture-digest' })).rejects.toThrow();
  });
  it('cascades only the fixture owner’s connections, bindings and receipts', async () => {
    await db.delete(users).where(eq(users.id, owner));
    expect(await db.select().from(remoteHermesConnections).where(eq(remoteHermesConnections.id, connection))).toEqual([]);
    expect(await db.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, session))).toEqual([]);
    expect(await db.select().from(remoteHermesTurns).where(eq(remoteHermesTurns.sessionId, session))).toEqual([]);
  });
});
