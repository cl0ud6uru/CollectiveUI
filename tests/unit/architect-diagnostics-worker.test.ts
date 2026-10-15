import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
import type { AgentCtx } from '@/lib/agent/types';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

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

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45_000);
beforeEach(async () => {
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await db.insert(s.users).values([
    { id: 'admin', name: 'Synthetic administrator', upn: 'private-admin@example.invalid', authSource: 'ldap', isAdmin: true },
    { id: 'member', name: 'Synthetic member', upn: 'private-member@example.invalid', authSource: 'ldap' },
  ]);
  admin = (await loadPrincipal('admin'))!;
  member = (await loadPrincipal('member'))!;
  await db.insert(s.aiApps).values({ id: 'model', name: 'Fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', supportsTools: true });
  const installed = await installArchitectBot(admin, { appId: 'model' });
  const [bot] = await db.select().from(s.bots).where(eq(s.bots.id, installed.id));
  const [app] = await db.select().from(s.aiApps);
  await db.insert(s.conversations).values({ id: 'chat', userId: admin.user.id, botId: bot.id, appId: app.id });
  ctx = { principal: admin, bot, app, conversationId: 'chat', depth: 0, background: false, toolSettings: await getSetting('tools') };
});
afterAll(async () => { await fixture.client?.close(); });

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
});
