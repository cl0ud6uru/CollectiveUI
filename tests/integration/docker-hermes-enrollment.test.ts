import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '@/db';
import { auditLog, dockerHermesEnrollments, users } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { dockerAllowed, assertDockerCreate } from '@/lib/docker-hermes/policy';
import { setDockerEnrollment, dockerBrokerReadiness } from '@/lib/docker-hermes/enrollment';
import { freshDocker } from '@/lib/docker-hermes/store';
import { reconcileDockerRuntimes } from '@/lib/docker-hermes/lifecycle';
import { importLegacyEnrollment, legacyEnrollmentIds } from '@/lib/docker-hermes/legacy-enrollment';
import { newId } from '@/lib/ids';
import { HttpError } from '@/lib/authz';
const f = vi.hoisted(() => ({ calls: [] as { owner: string; action: string }[], owners: [] as string[], fail: false, leaseGate: null as Promise<void> | null, principal: null as Principal | null }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: async (owner: string, action: string) => {
  f.calls.push({ owner, action });
  if (f.fail) throw new Error('secret broker path / credentials must never escape');
  if (action === '/control/lease') await f.leaseGate;
  if (action === '/admin/owners') return f.owners;
  if (action === '/admin/ready') return { ready: true };
  return { phase: 'disabled', bindings: [], unlinked: [] };
} }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => f.principal!, requireAdmin: async () => {
  if (!f.principal?.isAdmin) throw new HttpError(403, 'Admin only'); return f.principal;
} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const suite = process.env.DOCKER_HERMES_DB_TEST === '1' ? describe : describe.skip;
suite('database personal Hermes enrollment (mock broker, real PostgreSQL)', () => {
  const ids: string[] = []; let admin: Principal, alice: Principal, bob: Principal;
  const row = async (id = alice.user.id) => (await db.select().from(dockerHermesEnrollments).where(eq(dockerHermesEnrollments.userId, id)))[0];
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== '/collective_docker_hermes_test') throw new Error('Named disposable database required');
    for (const name of ['admin', 'alice', 'bob']) { const id = newId(); ids.push(id); await db.insert(users).values({ id, upn: `${id}@example.invalid`, name, authSource: 'ldap', isAdmin: name === 'admin' }); }
    [admin, alice, bob] = await Promise.all(ids.map(async id => (await loadPrincipal(id))!));
    vi.stubEnv('DOCKER_HERMES_SOCKET', '/tmp/synthetic.sock');
  });
  afterAll(async () => { await db.delete(auditLog).where(inArray(auditLog.target, ids)); await db.delete(users).where(inArray(users.id, ids)); await pool.end(); vi.unstubAllEnvs(); });
  it('defaults to denial including admin, ignores the legacy environment, and guards admin action and store', async () => {
    vi.stubEnv('DOCKER_HERMES_ALLOWED_USER_IDS', ids.join(','));
    for (const p of [admin, alice, bob]) expect(await dockerAllowed(p)).toBe(false);
    await expect(setDockerEnrollment(alice, bob.user.id, true)).rejects.toThrow('Admin only');
    f.principal = alice;
    const { updateDockerEnrollment } = await import('@/app/admin/hermes/enrollment-actions');
    await expect(updateDockerEnrollment(bob.user.id, true)).rejects.toThrow('Admin only');
    expect(await row(bob.user.id)).toBeUndefined();
  });
  it('separates broker not configured/unavailable/ready from enrollment and never exposes broker errors', async () => {
    vi.stubEnv('DOCKER_HERMES_SOCKET', ''); expect((await dockerBrokerReadiness()).status).toBe('not-configured');
    vi.stubEnv('DOCKER_HERMES_SOCKET', '/tmp/synthetic.sock'); f.fail = true;
    expect(await dockerBrokerReadiness()).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(await dockerBrokerReadiness())).not.toContain('credentials'); f.fail = false;
    expect((await dockerBrokerReadiness()).status).toBe('ready');
  });
  it('grants without a broker call, audits atomically, and keeps bot-creation policy separate', async () => {
    f.calls = []; await setDockerEnrollment(admin, alice.user.id, true);
    expect(f.calls).toEqual([]); expect(await dockerAllowed(alice)).toBe(true);
    expect(await dockerAllowed(bob)).toBe(false);
    await expect(assertDockerCreate(alice, { botCreation: 'admins' })).rejects.toThrow('Bot-creation');
    await expect(assertDockerCreate(alice, { botCreation: 'all' })).resolves.toBeUndefined();
    expect((await db.select().from(auditLog).where(eq(auditLog.target, alice.user.id)))[0]).toMatchObject({ actorId: admin.user.id, action: 'hermes.docker.enroll' });
  });
  it('revokes fresh web/worker access despite cached principal; failed stop stays visible and is retried', async () => {
    f.fail = true; await setDockerEnrollment(admin, alice.user.id, false);
    expect(await row()).toMatchObject({ enabled: false, cleanup: 'failed' }); expect((await row()).error).not.toContain('credentials');
    await expect(freshDocker(alice)).rejects.toThrow('not authorized');
    const { enablePersonalHermes, createPersonalHermesBot, personalHermesStatus } = await import('@/app/(chat)/settings/hermes-actions'); f.principal = alice;
    for (const action of [enablePersonalHermes, personalHermesStatus, () => createPersonalHermesBot({ name: 'Denied', requestId: '00000000-0000-4000-8000-000000000000' })]) await expect(action()).rejects.toThrow('not authorized');
    await expect(setDockerEnrollment(admin, alice.user.id, true)).rejects.toThrow('stopped');
    f.fail = false; f.owners = [alice.user.id]; f.calls = []; await reconcileDockerRuntimes();
    expect(await row()).toMatchObject({ enabled: false, cleanup: 'stopped' });
    expect(f.calls.some(c => c.action === '/control/lease')).toBe(false);
    expect(f.calls).toContainEqual({ owner: alice.user.id, action: '/control/revoke' });
  });
  it('re-enrollment retains the same row/owner and waits for the user to enable', async () => {
    f.calls = []; await setDockerEnrollment(admin, alice.user.id, true);
    expect(await row()).toMatchObject({ userId: alice.user.id, enabled: true, cleanup: 'none' }); expect(f.calls).toEqual([]);
  });
  it('serializes concurrent enable and revoke so no stale lease is sent after denial commits', async () => {
    let release!: () => void; f.leaseGate = new Promise<void>(resolve => { release = resolve; }); f.calls = []; f.principal = alice;
    const { enablePersonalHermes } = await import('@/app/(chat)/settings/hermes-actions');
    const enable = enablePersonalHermes();
    await vi.waitFor(() => expect(f.calls).toContainEqual({ owner: alice.user.id, action: '/control/lease' }));
    const revoke = setDockerEnrollment(admin, alice.user.id, false);
    release(); await Promise.all([enable, revoke]); f.leaseGate = null;
    expect(f.calls.map(c => c.action)).toEqual(['/control/lease', '/control/enable', '/control/revoke']);
    await expect(enablePersonalHermes()).rejects.toThrow('not authorized'); expect(await row()).toMatchObject({ enabled: false, cleanup: 'stopped' });
  });
  it('worker rechecks enrollment before every lease and does not stop processing after one failed owner', async () => {
    await setDockerEnrollment(admin, alice.user.id, true); f.owners = [bob.user.id, alice.user.id]; f.calls = [];
    await reconcileDockerRuntimes();
    expect(f.calls).toContainEqual({ owner: bob.user.id, action: '/control/revoke' });
    expect(f.calls).toContainEqual({ owner: alice.user.id, action: '/control/lease' });
    await setDockerEnrollment(admin, alice.user.id, false); f.calls = []; await reconcileDockerRuntimes();
    expect(f.calls.some(c => c.action === '/control/lease')).toBe(false);
  });
  it('legacy migration is previewed, explicit, atomic on invalid IDs, audited and cannot override revocation', async () => {
    const raw = `${alice.user.id}, ${bob.user.id};bad/id;unknown-user`;
    expect(legacyEnrollmentIds(raw).invalid).toHaveLength(1);
    const preview = await importLegacyEnrollment(admin, raw, false);
    expect(preview).toMatchObject({ applied: false, eligible: 1 }); expect(preview.unknown).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain('bad/id');
    await expect(importLegacyEnrollment(admin, raw, true)).rejects.toThrow('No permissions changed'); expect(await dockerAllowed(bob)).toBe(false);
    await importLegacyEnrollment(admin, `${alice.user.id},${bob.user.id}`, true);
    expect(await dockerAllowed(alice)).toBe(false); expect(await dockerAllowed(bob)).toBe(true);
    expect((await importLegacyEnrollment(admin, bob.user.id, true)).eligible).toBe(0);
    await expect(importLegacyEnrollment(alice, alice.user.id, true)).rejects.toThrow('Admin only');
  });
  it('fails closed when database permission cannot be verified, without sending a worker lease', async () => {
    const spy = vi.spyOn(db, 'select');
    try {
      spy.mockImplementationOnce(() => { throw new Error('Database unavailable'); });
      await expect(dockerAllowed(bob)).rejects.toThrow('Database unavailable');
      spy.mockImplementationOnce(() => { throw new Error('Database unavailable'); }); f.calls = [];
      await expect(reconcileDockerRuntimes()).rejects.toThrow('Database unavailable'); expect(f.calls).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it('rejects a stale formerly-admin principal for enrollment writes', async () => {
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, admin.user.id));
    await expect(setDockerEnrollment(admin, alice.user.id, true)).rejects.toThrow('Admin only');
  });
});
