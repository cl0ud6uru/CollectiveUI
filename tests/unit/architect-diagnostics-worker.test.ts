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
  queueList: vi.fn(async () => [{ name: 'agent.run', readyCount: 0, deferredCount: 0, activeCount: 0, failedCount: 0, totalCount: 0 }]),
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
vi.mock('@/lib/jobs', () => ({
  QUEUES: { agentRun: 'agent.run', agentRunBackground: 'agent.run.bg', agentRunTasks: 'agent.run.tasks', routineRun: 'routine.run', memoryExtract: 'memory.extract', learningReview: 'learning.review', learningCurate: 'learning.curate', mcpRefresh: 'mcp.refresh', sandboxCleanup: 'sandbox.cleanup' },
  getBoss: async () => ({ getQueues: services.queueList }),
}));

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
}, 45_000);
beforeEach(async () => {
  vi.clearAllMocks();
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
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
afterEach(() => vi.unstubAllEnvs());

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
    expect(services.queueList).toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toContain('opaque-credential-sentinel');
  });
});
