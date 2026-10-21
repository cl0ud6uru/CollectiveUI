import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
import type { AgentCtx } from '@/lib/agent/types';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
const services = vi.hoisted(() => ({
  sandboxHealth: vi.fn(async () => ({ ok: true, docker: { version: 'fixture', apiVersion: 'fixture' }, image: { present: true }, gvisor: { available: true }, defaultRuntime: 'runsc', warnings: [] })),
  sandboxList: vi.fn(async () => []),
  localStatus: vi.fn(async () => ({ status: 'ok' })),
  brokerReadiness: vi.fn(async () => ({ status: 'ready', message: 'synthetic fixture' })),
}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock('@/lib/sandbox/client', () => ({
  SandboxdClient: class { health = services.sandboxHealth; },
  sandboxd: () => ({ list: services.sandboxList }),
}));
vi.mock('@/lib/local-hermes/client', () => ({ localControl: services.localStatus }));
vi.mock('@/lib/docker-hermes/enrollment', () => ({ dockerBrokerReadiness: services.brokerReadiness }));

import { db, schema as s } from '@/db';
import { adminDiagnosticBundle } from '@/lib/admin/architect-diagnostics';
import { adminTools } from '@/lib/agent/tools/admin';
import { loadPrincipal } from '@/lib/auth/groups';
import { getSetting } from '@/lib/settings';
import { installArchitectBot } from '@/lib/bots/architect-store';

let admin: Principal, member: Principal, ctx: AgentCtx;
const executeBundle = async () => {
  const tool = adminTools(ctx).find(entry => entry.name === 'admin_diagnostic_bundle')!;
  return tool.tool.execute!({ days: 7, hours: 24 }, { toolCallId: 'worker-diagnostic', messages: [], context: undefined });
};
const executeReadTool = async (name: string, input: Record<string, unknown> = {}) => {
  const tool = adminTools(ctx).find(entry => entry.name === name);
  if (!tool) throw new Error(`Missing read tool: ${name}`);
  return tool.tool.execute!(input, { toolCallId: `worker-${name}`, messages: [], context: undefined });
};

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
  await fixture.client!.exec(`CREATE SCHEMA IF NOT EXISTS pgboss;
    CREATE TABLE IF NOT EXISTS pgboss.queue (name text primary key, ready_count integer not null default 0,
      deferred_count integer not null default 0, active_count integer not null default 0,
      failed_count integer not null default 0, total_count integer not null default 0)`);
}, 45_000);
beforeEach(async () => {
  vi.clearAllMocks();
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await fixture.client!.exec(`CREATE SCHEMA IF NOT EXISTS pgboss;
    CREATE TABLE IF NOT EXISTS pgboss.queue (name text primary key, ready_count integer not null default 0,
      deferred_count integer not null default 0, active_count integer not null default 0,
      failed_count integer not null default 0, total_count integer not null default 0)`);
  await fixture.client!.exec('TRUNCATE pgboss.queue');
  await fixture.client!.exec(`INSERT INTO pgboss.queue (name, ready_count, deferred_count, active_count, failed_count, total_count)
    VALUES ('agent.run', 1, 2, 3, 4, 10)`);
  await db.insert(s.users).values([
    { id: 'admin', name: 'Synthetic administrator', upn: 'private-admin@example.invalid', authSource: 'ldap', isAdmin: true },
    { id: 'member', name: 'Synthetic member', upn: 'private-member@example.invalid', authSource: 'ldap' },
  ]);
  admin = (await loadPrincipal('admin'))!;
  member = (await loadPrincipal('member'))!;
  await db.insert(s.aiApps).values({ id: 'model', name: 'Fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', supportsTools: true });
  await db.insert(s.providerBillingAccounts).values({ id: 'billing', name: 'Fixture account', organization: 'fixture-org', adminKeyEnc: 'opaque-credential-sentinel', createdBy: 'admin' });
  const installed = await installArchitectBot(admin, { appId: 'model' });
  const [bot] = await db.select().from(s.bots).where(eq(s.bots.id, installed.id));
  const [app] = await db.select().from(s.aiApps);
  await db.insert(s.conversations).values({ id: 'chat', userId: admin.user.id, botId: bot.id, appId: app.id });
  ctx = { principal: admin, bot, app, conversationId: 'chat', depth: 0, background: false, toolSettings: await getSetting('tools') };
});
afterAll(async () => { await fixture.client?.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('worker-safe Architect diagnostic summary', () => {
  it('invokes without importing server-only portal probes and returns only bounded aggregates', async () => {
    const result = await executeBundle() as Awaited<ReturnType<typeof adminDiagnosticBundle>>;
    expect(result.totals.users).toBe(2);
    expect(result.health.checks.map(check => check.id)).toEqual(['database', 'worker']);
    expect(Object.values(result.failureCounts).every(Number.isInteger)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic administrator|private-admin|example\.invalid|password|credential/i);
  });
  it('enforces its own admin check before reading operational data', async () => {
    await expect(adminDiagnosticBundle(member)).rejects.toMatchObject({ status: 403 });
  });

  it('executes every Architect read tool with server-only left unmocked and external services synthetic', async () => {
    vi.stubEnv('SANDBOXD_URL', 'http://sandboxd.fixture.invalid:8080/');
    vi.stubEnv('SANDBOXD_SECRET', 'x'.repeat(32));
    vi.stubEnv('DOCKER_HERMES_SOCKET', '/synthetic/docker-hermes.sock');
    vi.stubEnv('LOCAL_HERMES_SOCKET', '/synthetic/local-hermes.sock');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['admin_get_settings', {}], ['admin_diagnostic_bundle', { days: 7, hours: 24 }],
      ['admin_list_bots', {}], ['admin_get_bot', { botId: ctx.bot!.id }], ['admin_list_connections', {}],
      ['admin_list_users', {}], ['admin_status', { days: 7 }], ['admin_health', {}],
      ['admin_recent_errors', { hours: 24, limit: 10 }], ['admin_runs', { hours: 24, limit: 10 }],
      ['admin_jobs', {}], ['admin_spending', { days: 7 }], ['admin_workspaces_status', {}],
    ];
    const results = [];
    for (const [name, input] of calls) results.push(await executeReadTool(name, input));
    expect(results).toHaveLength(calls.length);
    expect(results.every(result => result !== undefined)).toBe(true);
    expect(services.sandboxHealth).toHaveBeenCalled();
    expect(services.sandboxList).toHaveBeenCalled();
    expect(services.localStatus).toHaveBeenCalled();
    expect(services.brokerReadiness).toHaveBeenCalled();
    expect(results[calls.findIndex(([name]) => name === 'admin_jobs')]).toMatchObject({ available: true, queues: [{ name: 'agent.run', ready: 1, deferred: 2, active: 3, failed: 4, total: 10 }] });
    expect(JSON.stringify(results)).not.toContain('opaque-credential-sentinel');
  });

  it('executes provider credential preparation in the worker with server-only unmocked and no credential input', async () => {
    const fetcher = vi.fn(async () => { throw new Error('External provider calls forbidden in this worker fixture'); });
    vi.stubGlobal('fetch', fetcher);
    const result = await executeReadTool('admin_prepare_provider_connection', {
      provider: 'openai-compatible', name: 'Worker fixture', baseUrl: 'https://provider.fixture.invalid/v1',
    }) as { status: string; draftId: string; formPath: string; note: string };
    expect(result).toMatchObject({ status: 'setup_required', formPath: `/admin/apps?architectConnectionDraft=${result.draftId}` });
    expect(result.note).toContain('never sent through this conversation');
    expect(await db.select().from(s.architectProviderConnectionDrafts)).toMatchObject([{ name: 'Worker fixture', provider: 'openai-compatible', conversationId: 'chat' }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports queue counters unavailable without initializing pg-boss when its catalog is absent', async () => {
    await fixture.client!.exec('DROP SCHEMA pgboss CASCADE');
    await expect(executeReadTool('admin_jobs')).resolves.toEqual({
      available: false,
      queues: [],
      reason: 'The persisted pg-boss queue counters are unavailable.',
    });
    await expect(fixture.client!.query("select to_regclass('pgboss.queue') as queue")).resolves.toMatchObject({ rows: [{ queue: null }] });
  });
});
