import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { architectDraftFixtureURL } from '../fixtures/architect-draft/disposable-database';

// Guard before dynamically importing pg, the application DB or migrations. Never fall back to DATABASE_URL.
const enabled = process.env.ARCHITECT_DRAFT_POSTGRES_PROOF === '1';
const fixtureURL = enabled ? architectDraftFixtureURL() : undefined;
vi.mock('server-only', () => ({}));

let q: typeof import('@/db');
let controller: import('pg').Client;
let ctx: import('@/lib/agent/types').AgentCtx;
let principal: import('@/lib/auth/groups').Principal;

describe.skipIf(!enabled)('Architect provider draft concurrency on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = fixtureURL!;
    process.env.DATABASE_POOL_MAX = '12';
    process.env.AUTH_SECRET = 'synthetic-architect-draft-proof-secret';
    process.env.ENCRYPTION_KEY = 'synthetic-architect-draft-proof-encryption';
    q = await import('@/db');
    // Destructive setup is permitted only for the exact dedicated loopback URL behind the opt-in guard above.
    await q.pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(q.db, { migrationsFolder: 'src/db/migrations' });
    const schema = q.schema;
    await q.db.insert(schema.users).values({ id: 'draft-admin', name: 'Synthetic admin', upn: 'draft-admin@fixture.invalid', authSource: 'ldap', isAdmin: true });
    await q.db.insert(schema.aiApps).values({ id: 'draft-model', name: 'Synthetic model', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', supportsTools: true });
    const { loadPrincipal } = await import('@/lib/auth/groups');
    principal = (await loadPrincipal('draft-admin'))!;
    const { installArchitectBot } = await import('@/lib/bots/architect-store');
    const installed = await installArchitectBot(principal, { appId: 'draft-model' });
    const [bot] = await q.db.select().from(schema.bots).where(eq(schema.bots.id, installed.id));
    const [app] = await q.db.select().from(schema.aiApps).where(eq(schema.aiApps.id, 'draft-model'));
    await q.db.insert(schema.conversations).values({ id: 'draft-chat', userId: principal.user.id, botId: bot.id, appId: app.id });
    const { getSetting } = await import('@/lib/settings');
    ctx = { principal, conversationId: 'draft-chat', bot, app, depth: 0, background: false, inGroup: false, toolSettings: await getSetting('tools') };
    const { Client } = await import('pg');
    controller = new Client({ connectionString: fixtureURL });
    await controller.connect();
  }, 60000);

  afterAll(async () => {
    await controller?.end();
    await q?.pool.end();
    vi.unstubAllGlobals();
  });

  it('observes same-admin requests waiting on the advisory lock and commits no more than three drafts', async () => {
    const { prepareArchitectProviderConnection } = await import('@/lib/admin/architect-connections');
    const actorScope = `architect-provider-draft:${principal.user.id}`;
    const held = await controller.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [actorScope]);
    expect(held.rowCount).toBe(1);
    const controllerPid = (await controller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const fetchMock = vi.fn(async () => { throw new Error('Provider access is prohibited in this proof.'); });
    vi.stubGlobal('fetch', fetchMock);
    const pending = Array.from({ length: 4 }, (_, index) => prepareArchitectProviderConnection(ctx, principal,
      { provider: 'openai', name: `Concurrent synthetic ${index}` }));
    let lockWaitsObserved = false;
    let waitError: unknown;
    try {
      await vi.waitFor(async () => {
        const result = await q.pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`, [controllerPid]);
        expect(result.rows[0].waiting).toBe(4);
      }, { timeout: 10000, interval: 25 });
      lockWaitsObserved = true;
    } catch (error) {
      waitError = error;
    } finally {
      await controller.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [actorScope]);
    }
    const outcomes = await Promise.allSettled(pending);
    expect(waitError).toBeUndefined();
    expect(lockWaitsObserved).toBe(true);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await q.db.select().from(q.schema.architectProviderConnectionDrafts)).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30000);
});
