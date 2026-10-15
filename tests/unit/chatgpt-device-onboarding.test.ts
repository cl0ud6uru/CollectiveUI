import { readFileSync, readdirSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, control: vi.fn(), plan: 'business', workspace: 'company-workspace' }));
vi.mock('server-only', () => ({}));
vi.mock('@/personal-codex/control', () => ({ personalControl: fixture.control }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { getSetting } from '@/lib/settings';
import { deviceAccountSetupView, prepareDeviceAccountRuntime, type RuntimeConsent } from '@/lib/llm/chatgpt/onboarding';
import { changeConnection } from '@/personal-codex/accounts';

const consent = { accepted: true, consentVersion: 1 } as const;
const expected = { email: 'openai-owner@test.invalid', workspaceId: 'company-workspace' };
let local: NonNullable<Awaited<ReturnType<typeof loadPrincipal>>>;

async function permit(overrides: Record<string, unknown> = {}) {
  const value = { enabled: true, access: 'everyone', allowedGroupIds: [], allowedUpns: [],
    allowedWorkspaceIds: ['company-workspace'], allowPersonalPlans: false, allowBackground: false, ...overrides };
  await db.insert(schema.settings).values({ key: 'chatgpt', value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(name => name.endsWith('.sql')).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8')
      .replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
  }
}, 45000);

beforeEach(async () => {
  vi.stubEnv('PERSONAL_CODEX_SOCKET', '/tmp/synthetic-device-onboarding.sock');
  vi.stubEnv('CHATGPT_SIWC_HOST_ID', '');
  vi.stubEnv('CHATGPT_SIWC_COMPANION_URL', '');
  fixture.plan = 'business'; fixture.workspace = 'company-workspace';
  fixture.control.mockReset().mockImplementation(async (_owner: string, action: string) => {
    if (action === 'readiness') return { state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' };
    if (action === 'prepare') return { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' };
    return { state: 'running', account: { account: { type: 'chatgpt', email: expected.email, planType: fixture.plan },
      workspaceRouting: { chatgptAccountId: fixture.workspace, backendOrigin: 'https://chatgpt.com/backend-api', accountRoutingOverride: 'NO_CONSTRAINT' } } };
  });
  await fixture.client!.exec('TRUNCATE users, settings, codex_runs CASCADE');
  await db.insert(schema.users).values([
    { id: 'local-owner', upn: 'local:jhartley', email: null, name: 'Local member', authSource: 'local', identityRealm: 'local' },
    { id: 'other-owner', upn: 'local:other', email: null, name: 'Other member', authSource: 'local', identityRealm: 'local' },
  ]);
  local = (await loadPrincipal('local-owner'))!;
  await permit();
});

afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('native ChatGPT device onboarding with synthetic owner accounts', () => {
  it('offers device sign-in to an allowed local login without email, SIWC host registration, or a companion', async () => {
    expect(local.user).toMatchObject({ upn: 'local:jhartley', email: null });
    await expect(deviceAccountSetupView(local, await getSetting('chatgpt'))).resolves.toMatchObject({
      eligible: true, reason: null, canPrepareRuntime: true,
      authentication: { state: 'device_code' }, runtime: { enrolled: false },
    });
    expect(fixture.control.mock.calls).toEqual([['local-owner', 'readiness']]);
    expect(await db.select().from(schema.personalCodexAccounts)).toHaveLength(0);
    expect(await db.select().from(schema.userCredentials)).toHaveLength(0);
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('prepares only the consenting owner before account facts are known and records infrastructure consent', async () => {
    await expect(prepareDeviceAccountRuntime(local, consent)).resolves.toMatchObject({ prepared: true, runtime: { enrolled: true, runtimeState: 'running' } });
    expect(fixture.control.mock.calls).toEqual([['local-owner', 'prepare', { consentVersion: 1, sessionVersion: local.user.sessionVersion }]]);
    expect(await db.select().from(schema.auditLog)).toMatchObject([{
      actorId: 'local-owner', target: 'local-owner', action: 'chatgpt.codex.device.prepare', details: { consentVersion: 1, sessionVersion: local.user.sessionVersion },
    }]);
    expect(await db.select().from(schema.personalCodexAccounts)).toHaveLength(0);
    expect(await db.select().from(schema.userCredentials)).toHaveLength(0);
  });

  it.each([
    { accepted: false, consentVersion: 1 }, { accepted: true, consentVersion: 2 },
    { accepted: true, consentVersion: 1, owner: 'other-owner' },
  ])('rejects invalid or caller-supplied owner consent %j before contacting the broker', async input => {
    await expect(prepareDeviceAccountRuntime(local, input as unknown as RuntimeConsent)).rejects.toMatchObject({ status: 400 });
    expect(fixture.control).not.toHaveBeenCalled();
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it.each(['disabled feature', 'excluded member', 'stale session', 'disabled owner', 'active work'] as const)
  ('checks current authorization before preparing for %s', async cause => {
    if (cause === 'disabled feature') await permit({ enabled: false });
    if (cause === 'excluded member') await permit({ access: 'selected', allowedUpns: ['local:other'] });
    if (cause === 'stale session') await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, local.user.id));
    if (cause === 'disabled owner') await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, local.user.id));
    if (cause === 'active work') await db.insert(schema.codexRuns).values({ runId: 'held-native-run', userId: local.user.id,
      runtimeId: `personal:${local.user.id}`, binding: 'synthetic-binding', funding: 'chatgpt_subscription', phase: 'running' });
    await expect(prepareDeviceAccountRuntime(local, consent)).rejects.toMatchObject({ status: cause === 'active work' ? 409 : 403 });
    expect(fixture.control).not.toHaveBeenCalled();
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('binds the explicitly reviewed allowed business account despite local identity lacking email', async () => {
    await prepareDeviceAccountRuntime(local, consent);
    await expect(changeConnection(local, 'confirm', expected)).resolves.toMatchObject({ state: 'connected', ...expected, planType: 'business' });
    expect(await db.select().from(schema.personalCodexAccounts)).toMatchObject([{
      userId: 'local-owner', email: expected.email, workspaceId: expected.workspaceId, connected: true, credentialBinding: expect.any(String),
    }]);
    expect(await db.select().from(schema.userCredentials)).toHaveLength(0);
  });

  it.each(['disallowed workspace', 'personal plan', 'revoked access'] as const)('enforces post-login policy for %s after allowing preparation', async cause => {
    await prepareDeviceAccountRuntime(local, consent);
    if (cause === 'disallowed workspace') fixture.workspace = 'unapproved-workspace';
    if (cause === 'personal plan') fixture.plan = 'plus';
    if (cause === 'revoked access') await permit({ access: 'selected', allowedUpns: [] });
    await expect(changeConnection(local, 'confirm', { ...expected, workspaceId: fixture.workspace })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.personalCodexAccounts)).toHaveLength(0);
    expect(await db.select().from(schema.userCredentials)).toHaveLength(0);
  });

  it('does not bind a changed account snapshot or pool the same OpenAI account across owners', async () => {
    await expect(changeConnection(local, 'confirm', { ...expected, workspaceId: 'stale-reviewed-workspace' })).rejects.toMatchObject({ status: 409 });
    await changeConnection(local, 'confirm', expected);
    const other = (await loadPrincipal('other-owner'))!;
    await expect(changeConnection(other, 'confirm', expected)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.personalCodexAccounts)).toMatchObject([{ userId: 'local-owner', connected: true }]);
    expect(fixture.control.mock.calls.every(([owner]) => ['local-owner', 'other-owner'].includes(owner))).toBe(true);
  });

  it('reports unavailable runtime preparation and leaves enrollment unrecorded', async () => {
    fixture.control.mockRejectedValue(new Error('synthetic broker offline'));
    await expect(deviceAccountSetupView(local, await getSetting('chatgpt'))).resolves.toMatchObject({
      eligible: true, canPrepareRuntime: false, runtime: { state: 'unavailable' },
    });
    fixture.control.mockResolvedValue({ state: 'ready', enrolled: true, runtimeState: 'stopped', reason: 'synthetic runtime failed to start' });
    await expect(prepareDeviceAccountRuntime(local, consent)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.auditLog)).toHaveLength(0);
    expect(await db.select().from(schema.personalCodexAccounts)).toHaveLength(0);
  });
});
