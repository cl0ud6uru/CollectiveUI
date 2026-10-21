import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, control: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: fixture.control, dockerFetch: () => fixture.fetch }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { authorizeTeam } from '@/lib/hermes-team/store';
import { reconcileDockerRuntimes } from '@/lib/docker-hermes/lifecycle';
import { ensureTeamRuntime } from '@/lib/hermes-team/transport';
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('DOCKER_HERMES_SOCKET', '/synthetic/never-opened.sock');
  fixture.control.mockReset(); fixture.fetch.mockReset(); fixture.fetch.mockImplementation(async () => Response.json({ accepted: true }));
  fixture.control.mockImplementation(async (_owner, action) => action === '/admin/owners' ? ['member', 'team-admin:team']
    : action === '/control/status' ? { phase: 'stopped', bindings: [] }
    : action === '/team/authorize' ? { grantId: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60000 } : { stopped: true, failed: false });
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await db.insert(schema.users).values([
    { id: 'admin', name: 'Admin', upn: 'admin@fixture.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true },
    { id: 'member', name: 'Member', upn: 'member@fixture.invalid', authSource: 'local', identityRealm: 'local' },
  ]);
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', visibility: 'org', hermesTeam: true });
  await db.insert(schema.hermesTeamDefinitions).values({ botId: 'team', enabled: true, modelPolicy: { mode: 'personal_required' }, updatedBy: 'admin' });
  await db.insert(schema.hermesTeamMaintainers).values({ botId: 'team', userId: 'admin' });
});
afterAll(async () => { await fixture.client?.close(); vi.unstubAllEnvs(); });
it('denies never-enrolled and revoked member runtime authority but permits an enrolled audience member', async () => {
  const member = (await loadPrincipal('member'))!;
  await expect(authorizeTeam(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  await db.insert(schema.dockerHermesEnrollments).values({ userId: 'member', enabled: true, changedBy: 'admin' });
  await expect(authorizeTeam(member, 'team', 'member')).resolves.toBeDefined();
  await db.update(schema.dockerHermesEnrollments).set({ enabled: false }).where(eq(schema.dockerHermesEnrollments.userId, 'member'));
  await expect(authorizeTeam(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  expect(fixture.control).not.toHaveBeenCalled();
});
it('keeps the dedicated maintainer runtime independent of personal enrollment without granting member mode', async () => {
  const admin = (await loadPrincipal('admin'))!;
  await expect(authorizeTeam(admin, 'team', 'admin')).resolves.toBeDefined();
  await expect(authorizeTeam(admin, 'team', 'member')).rejects.toMatchObject({ status: 403 });
});
it('renews an enrolled personal owner without revoking or leasing the reserved Team admin identity', async () => {
  await db.insert(schema.dockerHermesEnrollments).values({ userId: 'member', enabled: true, changedBy: 'admin' });
  await reconcileDockerRuntimes();
  expect(fixture.control).toHaveBeenCalledWith('member', '/control/lease', { canCreate: true }, 3000);
  expect(fixture.control.mock.calls.filter(([owner]) => owner === 'team-admin:team')).toEqual([]);
});
it('continues to revoke a personal owner without enrollment while leaving the Team admin owner alone', async () => {
  await reconcileDockerRuntimes();
  expect(fixture.control).toHaveBeenCalledWith('member', '/control/revoke', {}, 3000);
  expect(fixture.control.mock.calls.filter(([owner]) => owner === 'team-admin:team')).toEqual([]);
});
it('leases the first enrolled member open before its Team grant without requiring personal bot creation', async () => {
  const member = (await loadPrincipal('member'))!;
  await expect(ensureTeamRuntime(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  expect(fixture.control).not.toHaveBeenCalled(); expect(fixture.fetch).not.toHaveBeenCalled();
  await db.insert(schema.dockerHermesEnrollments).values({ userId: 'member', enabled: true });
  await db.insert(schema.settings).values({ key: 'tools', value: { botCreation: 'admins' } });
  await expect(ensureTeamRuntime(member, 'team', 'member')).resolves.toEqual({ accepted: true });
  expect(fixture.control).toHaveBeenNthCalledWith(1, 'member', '/control/lease', { canCreate: false }, 3000);
  expect(fixture.control).toHaveBeenNthCalledWith(2, 'member', '/team/authorize', { teamBotId: 'team', mode: 'member', modelPolicy: 'personal_required' });
  await db.update(schema.dockerHermesEnrollments).set({ enabled: false }).where(eq(schema.dockerHermesEnrollments.userId, 'member'));
  fixture.control.mockClear(); fixture.fetch.mockClear();
  await expect(ensureTeamRuntime(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  expect(fixture.control).not.toHaveBeenCalled(); expect(fixture.fetch).not.toHaveBeenCalled();
});
it('does not grant runtime access to an outsider, disabled user or stale session with an enrollment', async () => {
  await db.insert(schema.dockerHermesEnrollments).values({ userId: 'member', enabled: true });
  const member = (await loadPrincipal('member'))!;
  await db.update(schema.bots).set({ visibility: 'private' }).where(eq(schema.bots.id, 'team'));
  await expect(ensureTeamRuntime(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  await db.update(schema.bots).set({ visibility: 'org' }).where(eq(schema.bots.id, 'team'));
  await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'member'));
  await expect(ensureTeamRuntime(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  await db.update(schema.users).set({ sessionVersion: 0, disabled: true }).where(eq(schema.users.id, 'member'));
  await expect(ensureTeamRuntime(member, 'team', 'member')).rejects.toMatchObject({ status: 403 });
  expect(fixture.control).not.toHaveBeenCalled(); expect(fixture.fetch).not.toHaveBeenCalled();
});
