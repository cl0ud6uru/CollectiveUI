import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ webSearch: {} }), setSetting: vi.fn() }));
vi.mock('@/lib/llm/chatgpt/store', () => ({ rewrapChatGPTSecrets: async () => 0 }));
vi.mock('@/lib/mcp/member-connections', () => ({ rewrapMemberMcpSecrets: async () => 0 }));
import { db } from '@/db';
import { remoteHermesConnections as connections, users } from '@/db/schema';
import { decrypt, encrypt } from '@/lib/crypto';
import { rewrapAllSecrets } from '@/lib/secrets-rewrap';

const oldKey = randomBytes(32).toString('base64'), newKey = randomBytes(32).toString('base64');
const aad = (id: string, owner = 'owner') => `remote_hermes_connections.secret_enc|${id}|${owner}`;
const password = { mode: 'password', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: 1 };
const token = { mode: 'sessionToken', sessionToken: 'synthetic-session' };
const rows = () => db.select().from(connections);
const rotate = () => vi.stubEnv('ENCRYPTION_PRIMARY_KID', 'new');
async function seed(id: string, secret: object = password) {
  await db.insert(connections).values({ id, userId: 'owner', name: id, baseUrl: `https://${id}.invalid`,
    authMode: secret === token ? 'sessionToken' : 'password', secretEnc: encrypt(JSON.stringify(secret), aad(id)) });
}
beforeAll(async () => {
  await fixture.client!.waitReady;
  // Embedded PostgreSQL; no vector behavior is exercised here.
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort()) {
    const ddl = readFileSync(`src/db/migrations/${file}`, 'utf8')
      .replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]');
    await fixture.client!.exec(ddl);
  }
}, 45_000);
beforeEach(async () => {
  vi.stubEnv('ENCRYPTION_KEY', '');
  vi.stubEnv('ENCRYPTION_KEYS', `old:${oldKey},new:${newKey}`);
  vi.stubEnv('ENCRYPTION_PRIMARY_KID', 'old');
  await fixture.client!.exec('TRUNCATE users CASCADE');
  await db.insert(users).values({ id: 'owner', upn: 'owner', name: 'Fixture', identityRealm: 'local', authSource: 'local' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await fixture.client?.close(); });

it('global rewrap covers inactive password and session-token connections, with exact owner/row AAD', async () => {
  // Neither connection has a session; inactivity must not exclude credentials.
  await seed('password'); await seed('session', token); rotate();
  const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
  expect(await rewrapAllSecrets()).toBe(2);
  const current = await rows();
  expect(current.every(row => row.secretEnc.startsWith('v2.new.'))).toBe(true);
  expect(await rewrapAllSecrets()).toBe(0);
  expect(await rows()).toEqual(current);
  vi.stubEnv('ENCRYPTION_KEYS', `new:${newKey}`);
  for (const row of current) {
    expect(JSON.parse(decrypt(row.secretEnc, aad(row.id)))).toEqual(row.id === 'session' ? token : password);
    expect(() => decrypt(row.secretEnc, aad('different-row'))).toThrow();
    expect(() => decrypt(row.secretEnc, aad(row.id, 'different-owner'))).toThrow();
  }
  expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});

it('does not overwrite or count a refresh committed after the rewrap scan', async () => {
  await seed('password'); rotate();
  const refreshed = { ...password, accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiresAt: 9999999999 };
  const next = encrypt(JSON.stringify(refreshed), aad('password'));
  const select = db.select.bind(db);
  let scanned = false;
  vi.spyOn(db, 'select').mockImplementation(((...args: Parameters<typeof db.select>) => {
    const builder = select(...args);
    const from = builder.from.bind(builder);
    builder.from = ((table: Parameters<typeof builder.from>[0]) => {
      if (table !== connections || scanned) return from(table);
      scanned = true;
      return (async () => {
        const stale = await from(table);
        // Deterministically commit the refresh between scan and guarded rewrap write.
        await db.update(connections).set({ secretEnc: next }).where(eq(connections.id, 'password'));
        return stale;
      })();
    }) as typeof builder.from;
    return builder;
  }) as typeof db.select);
  expect(await rewrapAllSecrets()).toBe(0);
  expect(scanned).toBe(true);
  expect((await rows())[0].secretEnc).toBe(next);
  vi.stubEnv('ENCRYPTION_KEYS', `new:${newKey}`);
  expect(JSON.parse(decrypt(next, aad('password')))).toEqual(refreshed);
});
