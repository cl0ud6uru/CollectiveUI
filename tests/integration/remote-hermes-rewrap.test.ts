import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ webSearch: {} }), setSetting: vi.fn() }));
import { db, pool } from '@/db';
import { remoteHermesConnections as connections, users } from '@/db/schema';
import { decrypt, encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { remoteConnectionAAD } from '@/lib/remote-hermes/secrets';
import { rewrapAllSecrets } from '@/lib/secrets-rewrap';

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const enabled = process.env.REMOTE_HERMES_INTEGRATION === '1' && url?.pathname === '/hermes_fixture';
const oldKey = randomBytes(32).toString('base64'), newKey = randomBytes(32).toString('base64');
const secret = { mode: 'password', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1 };
let owner: string, connection: string;
const aad = () => remoteConnectionAAD(connection, owner);
const row = async () => (await db.select().from(connections).where(eq(connections.id, connection)))[0];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe.skipIf(!enabled)('personal token rewrap with disposable PostgreSQL refresh locks', () => {
  beforeEach(async () => {
    owner = newId(); connection = newId();
    vi.stubEnv('ENCRYPTION_KEY', '');
    vi.stubEnv('ENCRYPTION_KEYS', `old:${oldKey},new:${newKey}`);
    vi.stubEnv('ENCRYPTION_PRIMARY_KID', 'old');
    await db.insert(users).values({ id: owner, upn: owner, name: 'Synthetic fixture', identityRealm: 'local', authSource: 'local' });
    await db.insert(connections).values({ id: connection, userId: owner, name: 'Fixture', baseUrl: `https://${connection}.invalid`, authMode: 'password', secretEnc: encrypt(JSON.stringify(secret), aad()) });
    vi.stubEnv('ENCRYPTION_PRIMARY_KID', 'new');
  });
  afterEach(async () => { await db.delete(users).where(eq(users.id, owner)); vi.unstubAllEnvs(); });
  afterAll(async () => { await pool.end(); });

  it('keeps inactive credentials readable after old-key removal', async () => {
    expect(await rewrapAllSecrets()).toBe(1);
    expect(await rewrapAllSecrets()).toBe(0);
    vi.stubEnv('ENCRYPTION_KEYS', `new:${newKey}`);
    expect(JSON.parse(decrypt((await row()).secretEnc, aad()))).toEqual(secret);
  });

  it('waits for a locked refresh and cannot replace its newly rotated token', async () => {
    const locked = deferred(), release = deferred();
    const refreshed = { ...secret, refreshToken: 'synthetic-rotated-refresh' };
    const refresh = db.transaction(async tx => {
      const [current] = await tx.select().from(connections).where(eq(connections.id, connection)).for('update');
      expect(JSON.parse(decrypt(current.secretEnc, aad()))).toEqual(secret);
      locked.resolve(); await release.promise;
      await tx.update(connections).set({ secretEnc: encrypt(JSON.stringify(refreshed), aad()) }).where(eq(connections.id, connection));
    });
    await locked.promise;
    const rewrapping = rewrapAllSecrets();
    try {
      // Observe the actual blocked UPDATE, not an arbitrary delay or a simulated lock.
      await vi.waitFor(async () => {
        const waiting = await pool.query("select pid from pg_stat_activity where datname = 'hermes_fixture' and wait_event_type = 'Lock' and query like 'update \"remote_hermes_connections\"%'");
        expect(waiting.rowCount).toBe(1);
      });
    } finally { release.resolve(); await refresh; }
    expect(await rewrapping).toBe(0);
    vi.stubEnv('ENCRYPTION_KEYS', `new:${newKey}`);
    expect(JSON.parse(decrypt((await row()).secretEnc, aad()))).toEqual(refreshed);
  });
});
