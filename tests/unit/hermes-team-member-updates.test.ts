import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as unknown,
  inventory: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  apply: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  abort: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock('@/lib/session', async () => {
  const { HttpError } = await import('@/lib/authz');
  return { requirePrincipal: async () => { if (!fixture.principal) throw new HttpError(401, 'Unauthorized'); return fixture.principal; } };
});
vi.mock('@/lib/hermes-team/transport', () => ({ inventoryTeamMemberResources: fixture.inventory, applyTeamMemberResources: fixture.apply, abortTeamMemberResources: fixture.abort }));
import { db, schema } from '@/db';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { capturePublishableResources } from '@/lib/hermes-team/resources';
import { applyTeamResourcePlan, abortUnstartedResourceUpdate, assertResourceUpdatesSettled, inventoryMemberResources } from '@/lib/hermes-team/native-resources';
import { createMemberUpdateService, memberUpdateRequestSchema, memberResolveRequestSchema, type MemberUpdateDependencies } from '@/lib/hermes-team/member-updates';
import { createTeamPublicationService } from '@/lib/hermes-team/publication';
import { POST as updateRoute, GET as previewRoute } from '@/app/api/bots/[id]/team/updates/route';
import { POST as resolveRoute } from '@/app/api/bots/[id]/team/updates/resolve/route';
import { POST as cancelRoute } from '@/app/api/bots/[id]/team/updates/cancel/route';
let admin: Principal, alice: Principal, bob: Principal, home: string, working: string;
const roots = new Map<string, string>(), journals = new Map<string, string>();
let beforeInventory: (() => Promise<void>) | undefined, beforeApply: (() => Promise<void>) | undefined, afterApply: (() => Promise<void>) | undefined;
let checkpoint: ((phase: string) => Promise<void>) | undefined;
const dependencies: MemberUpdateDependencies = {
  inventoryResources: (p, b, t) => fixture.inventory(p, b, t), applyResources: (p, b, i) => fixture.apply(p, b, i), abortResources: (p, b, i) => fixture.abort(p, b, i),
};
const service = createMemberUpdateService(dependencies);
const publisher = createTeamPublicationService({ captureResources: (_p, _b, selection) => capturePublishableResources(working, selection, { settleMs: 0 }) });
const file = async (root: string, relative: string, content: string) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), content); };
const skillFile = (root: string, name: string, content: string) => file(root, `skills/${name}/SKILL.md`, content);
const readSkill = (owner: string, name = 'support') => readFile(path.join(roots.get(owner)!, `skills/${name}/SKILL.md`), 'utf8');
const profileFor = async (owner: string) => (await db.select().from(schema.hermesTeamProfiles).where(eq(schema.hermesTeamProfiles.userId, owner)))[0];
const updateInput = (expectedInstalledRevision: number | null, targetRevision?: number) => ({ expectedInstalledRevision, ...(targetRevision === undefined ? {} : { targetRevision }), requestId: randomUUID() });
async function publishWorking(expectedRevision = 0, packages = ['support'], removals: string[] = []) {
  const captured = await publisher.capture(admin, 'team', { expectedRevision, selection: { skillPackages: packages } });
  return publisher.publish(admin, 'team', { snapshotId: captured.snapshotId, expectedRevision, selectedKeys: captured.changes.filter(change => change.change !== 'removed').map(change => change.packageId),
    removalKeys: removals, releaseNote: `Synthetic procedure release ${expectedRevision + 1}.`, requestId: randomUUID() });
}
const request = (suffix: string, body: unknown, origin = 'https://portal.test.invalid') => new Request(`https://portal.test.invalid/api/bots/team/team/updates${suffix}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = { params: Promise.resolve({ id: 'team' }) };
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const migration of readdirSync('src/db/migrations').filter(name => name.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${migration}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('AUTH_URL', 'https://portal.test.invalid');
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  beforeInventory = beforeApply = afterApply = checkpoint = undefined;
  home = await mkdtemp('/tmp/hermes-team-core-'); working = path.join(home, 'working'); await mkdir(working); roots.clear(); journals.clear();
  await db.insert(schema.users).values([
    { id: 'admin', name: 'Admin', upn: 'admin@test.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true },
    { id: 'alice', name: 'Alice', upn: 'alice@test.invalid', authSource: 'local', identityRealm: 'local' },
    { id: 'bob', name: 'Bob', upn: 'bob@test.invalid', authSource: 'local', identityRealm: 'local' },
  ]);
  admin = (await loadPrincipal('admin'))!; alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!; fixture.principal = alice;
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values([{ botId: 'team', userId: 'alice' }, { botId: 'team', userId: 'bob' }]);
  await configureTeam(admin, 'team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 0 });
  for (const person of [alice, bob]) {
    const profile = await reserveTeamProfile(person, 'team', 'member');
    await db.update(schema.hermesTeamProfiles).set({ binding: { profile: `server-derived-${person.user.id}` }, state: 'connection_needed' }).where(eq(schema.hermesTeamProfiles.id, profile.id));
    roots.set(person.user.id, path.join(home, `private-${person.user.id}`)); journals.set(person.user.id, path.join(home, `protected-${person.user.id}`)); await mkdir(roots.get(person.user.id)!);
  }
  await skillFile(working, 'support', 'Team support procedure v1');
  fixture.inventory.mockReset(); fixture.apply.mockReset(); fixture.abort.mockReset();
  fixture.inventory.mockImplementation(async (...args: unknown[]) => {
    const [p, , tracked] = args as [Principal, string, string[]];
    await beforeInventory?.();
    if (await stat(journals.get(p.user.id)!).then(() => true, () => false)) await assertResourceUpdatesSettled(journals.get(p.user.id)!);
    return inventoryMemberResources(roots.get(p.user.id)!, tracked);
  });
  fixture.apply.mockImplementation(async (...args: unknown[]) => {
    const [p, , input] = args as [Principal, string, Parameters<MemberUpdateDependencies['applyResources']>[2]];
    await beforeApply?.();
    const receipt = await applyTeamResourcePlan(roots.get(p.user.id)!, input.operationId, input.plan, { journalRoot: journals.get(p.user.id)!, receipt: input.receipt, checkpoint });
    await afterApply?.(); return receipt;
  });
  fixture.abort.mockImplementation(async (...args: unknown[]) => {
    const [p, , input] = args as [Principal, string, Parameters<MemberUpdateDependencies['abortResources']>[2]];
    return abortUnstartedResourceUpdate(roots.get(p.user.id)!, input.operationId, input.plan, { journalRoot: journals.get(p.user.id)! });
  });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('Actual PostgreSQL and native filesystem Team cycle', () => {
  it('teaches, captures, publishes and installs a complete skill package without model calls or merging private learning', async () => {
    await file(working, 'skills/support/scripts/check.py', 'print("synthetic fixture; never execute")');
    await skillFile(working, 'deleted', 'Team deletion choice v1'); await skillFile(working, 'remove', 'Team removable v1');
    await publishWorking(0, ['support', 'deleted', 'remove']);
    const first = await service.update(alice, 'team', updateInput(null));
    expect(first).toMatchObject({ status: 'complete', installedRevision: 1, conflictCount: 0 });
    expect(await readSkill('alice')).toBe('Team support procedure v1');
    expect(await readFile(path.join(roots.get('alice')!, 'skills/support/scripts/check.py'), 'utf8')).toBe('print("synthetic fixture; never execute")');
    expect((await profileFor('alice')).state).toBe('connection_needed');
    await skillFile(roots.get('alice')!, 'support', 'Alice corrected this procedure privately');
    await skillFile(roots.get('alice')!, 'learned', 'Alice learned a separate skill');
    await rm(path.join(roots.get('alice')!, 'skills/deleted'), { recursive: true });
    await skillFile(working, 'support', 'Team support procedure v2'); await skillFile(working, 'deleted', 'Team deletion choice v2'); await skillFile(working, 'added', 'Team added v2');
    await rm(path.join(working, 'skills/remove'), { recursive: true });
    await publishWorking(1, ['support', 'deleted', 'added'], ['skills/remove']);
    const preview = await service.preview(alice, 'team');
    expect(preview.conflicts).toMatchObject([{ packageId: 'skills/support', recorded: false }]);
    const second = await service.update(alice, 'team', updateInput(1));
    expect(second).toMatchObject({ status: 'complete', installedRevision: 2, conflictCount: 1 });
    expect(await readSkill('alice')).toBe('Alice corrected this procedure privately'); expect(await readSkill('alice', 'learned')).toBe('Alice learned a separate skill');
    await expect(readSkill('alice', 'deleted')).rejects.toThrow(); await expect(readSkill('alice', 'remove')).rejects.toThrow(); expect(await readSkill('alice', 'added')).toBe('Team added v2');
    const reviewed = await service.preview(alice, 'team'), conflict = reviewed.conflicts[0];
    expect(conflict).toMatchObject({ packageId: 'skills/support', recorded: true });
    await service.resolve(alice, 'team', { ...updateInput(2, 2), packageId: conflict.packageId, choice: 'keep-member', expectedMemberHash: conflict.expectedMemberHash, expectedTeamHash: conflict.expectedTeamHash });
    const kept = await service.preview(alice, 'team');
    expect(kept.conflicts).toEqual([]); expect(kept.overrides).toMatchObject([{ packageId: 'skills/deleted', choice: 'deleted', recorded: true }, { packageId: 'skills/support', choice: 'keep-member', recorded: true }]);
    expect(await readSkill('alice')).toBe('Alice corrected this procedure privately');
    // Shared rollback publishes the exact immutable old manifest as NEW revision 3; members use the same preservation rules.
    const [old] = await db.select().from(schema.hermesTeamRevisions).where(eq(schema.hermesTeamRevisions.revision, 1));
    const restorePublisher = createTeamPublicationService({ captureResources: async () => old.manifest });
    const restore = await restorePublisher.capture(admin, 'team', { expectedRevision: 2, selection: {} });
    const rollback = await restorePublisher.publish(admin, 'team', { snapshotId: restore.snapshotId, expectedRevision: 2,
      selectedKeys: restore.changes.filter(change => change.change !== 'removed').map(change => change.packageId), removalKeys: restore.changes.filter(change => change.change === 'removed').map(change => change.packageId), releaseNote: 'Restore the earlier team procedure.', requestId: randomUUID() });
    expect(rollback.revision).toBe(3); expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(3);
    await service.update(alice, 'team', updateInput(2));
    expect(await readSkill('alice')).toBe('Alice corrected this procedure privately'); expect(await readSkill('alice', 'learned')).toBe('Alice learned a separate skill');
    await expect(readSkill('alice', 'deleted')).rejects.toThrow(); expect(await readSkill('alice', 'remove')).toBe('Team removable v1');
    await expect(readSkill('alice', 'added')).rejects.toThrow();
    const rollout = await publisher.rollout(admin, 'team');
    expect(rollout.updatesNeeded).toBe(1); expect(JSON.stringify(rollout)).not.toMatch(/Alice|private|support|manifest|content|hash|profileId/);
  });
  it('resolves an exact preview with the team version and supports private historical restore without changing the shared revision', async () => {
    await publishWorking(); await service.update(alice, 'team', updateInput(null));
    await skillFile(roots.get('alice')!, 'support', 'Alice correction'); await skillFile(working, 'support', 'Team v2'); await publishWorking(1);
    await service.update(alice, 'team', updateInput(1)); const conflict = (await service.preview(alice, 'team')).conflicts[0];
    await service.resolve(alice, 'team', { ...updateInput(2, 2), packageId: conflict.packageId, choice: 'use-team', expectedMemberHash: conflict.expectedMemberHash, expectedTeamHash: conflict.expectedTeamHash });
    expect(await readSkill('alice')).toBe('Team v2'); expect((await service.preview(alice, 'team')).conflicts).toEqual([]);
    expect((await service.preview(alice, 'team', { targetRevision: 1 })).targetRevision).toBe(1);
    await service.update(alice, 'team', updateInput(2, 1)); expect(await readSkill('alice')).toBe('Team support procedure v1');
    expect((await db.select().from(schema.hermesTeamDefinitions))[0].publishedRevision).toBe(2);
  });
  it('offers an exact private preview to explicitly reset deleted and kept copies without resurrecting them automatically', async () => {
    await publishWorking(); await service.update(alice, 'team', updateInput(null));
    await rm(path.join(roots.get('alice')!, 'skills/support'), { recursive: true });
    await skillFile(working, 'support', 'Team v2'); await publishWorking(1); await service.update(alice, 'team', updateInput(1));
    const deleted = (await service.preview(alice, 'team')).overrides[0]; expect(deleted).toMatchObject({ choice: 'deleted', memberResources: [], recorded: true });
    await service.resolve(alice, 'team', { ...updateInput(2, 2), packageId: deleted.packageId, choice: 'use-team', expectedMemberHash: deleted.expectedMemberHash, expectedTeamHash: deleted.expectedTeamHash });
    expect(await readSkill('alice')).toBe('Team v2'); expect((await service.preview(alice, 'team')).overrides).toEqual([]);
    await skillFile(roots.get('alice')!, 'support', 'Private correction'); await skillFile(working, 'support', 'Team v3'); await publishWorking(2); await service.update(alice, 'team', updateInput(2));
    const conflict = (await service.preview(alice, 'team')).conflicts[0];
    await service.resolve(alice, 'team', { ...updateInput(3, 3), packageId: conflict.packageId, choice: 'keep-member', expectedMemberHash: conflict.expectedMemberHash, expectedTeamHash: conflict.expectedTeamHash });
    const kept = (await service.preview(alice, 'team')).overrides[0]; expect(kept.choice).toBe('keep-member');
    await service.resolve(alice, 'team', { ...updateInput(3, 3), packageId: kept.packageId, choice: 'use-team', expectedMemberHash: kept.expectedMemberHash, expectedTeamHash: kept.expectedTeamHash });
    expect(await readSkill('alice')).toBe('Team v3'); expect((await service.preview(alice, 'team')).overrides).toEqual([]);
  });
});

describe('Durable recovery, exact hashes and native journal authority', () => {
  it('deduplicates double clicks and exact completed retries without erasing later native learning', async () => {
    await publishWorking(); const input = updateInput(null);
    const [first, second] = await Promise.all([service.update(alice, 'team', input), service.update(alice, 'team', input)]);
    expect(second).toEqual(first); expect(fixture.apply).toHaveBeenCalledTimes(1);
    await skillFile(roots.get('alice')!, 'support', 'later private learning');
    expect(await createMemberUpdateService(dependencies).update(alice, 'team', input)).toEqual(first);
    expect(fixture.apply).toHaveBeenCalledTimes(1); expect(await readSkill('alice')).toBe('later private learning');
    await expect(service.update(alice, 'team', { ...input, targetRevision: 0 })).rejects.toMatchObject({ status: 409 });
  });
  it('replays the original native-complete request after a lost database acknowledgement without recapture or duplicate writes', async () => {
    await publishWorking(); const input = updateInput(null); let failed = false;
    afterApply = async () => { if (!failed) { failed = true; throw new Error('synthetic lost helper acknowledgement'); } };
    await expect(service.update(alice, 'team', input)).rejects.toThrow('lost helper acknowledgement');
    expect(await readSkill('alice')).toBe('Team support procedure v1'); expect((await profileFor('alice')).installedRevision).toBeNull();
    await skillFile(roots.get('alice')!, 'support', 'new private learning after native completion');
    const pending = await service.preview(alice, 'team');
    expect(pending).toMatchObject({ state: 'needs_attention', pendingRequest: { kind: 'update', input } });
    expect(fixture.inventory).toHaveBeenCalledTimes(1);
    const retried = await createMemberUpdateService(dependencies).update(alice, 'team', pending.pendingRequest!.input);
    expect(retried).toMatchObject({ status: 'complete', installedRevision: 1 }); expect(fixture.inventory).toHaveBeenCalledTimes(1);
    expect(await readSkill('alice')).toBe('new private learning after native completion');
  });
  it('recovers a real parked-package interruption using the durable original plan and blocks cancellation/new requests until recovery', async () => {
    await publishWorking(); await service.update(alice, 'team', updateInput(null));
    await skillFile(working, 'support', 'Team v2'); await publishWorking(1); const input = updateInput(1);
    checkpoint = async phase => { if (phase === 'parked') throw new Error('synthetic process death'); };
    await expect(service.update(alice, 'team', input)).rejects.toThrow('process death'); checkpoint = undefined;
    await expect(service.update(alice, 'team', updateInput(1))).rejects.toMatchObject({ status: 409 });
    await expect(service.cancel(alice, 'team', { requestId: input.requestId })).rejects.toThrow('begun');
    const pending = await createMemberUpdateService(dependencies).preview(alice, 'team'); expect(pending.pendingRequest!.input).toEqual(input);
    expect(await createMemberUpdateService(dependencies).update(alice, 'team', input)).toMatchObject({ installedRevision: 2 });
    expect(await readSkill('alice')).toBe('Team v2'); await assertResourceUpdatesSettled(journals.get('alice')!);
  });
  it('keeps native-complete state replayable when the database completion transaction fails atomically', async () => {
    await publishWorking(); const input = updateInput(null);
    await fixture.client!.exec(`CREATE FUNCTION fixture_fail_install() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.installed_revision IS DISTINCT FROM OLD.installed_revision THEN RAISE EXCEPTION 'synthetic DB crash'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_fail_install BEFORE UPDATE ON hermes_team_profiles FOR EACH ROW EXECUTE FUNCTION fixture_fail_install();`);
    try { await expect(service.update(alice, 'team', input)).rejects.toThrow(); }
    finally { await fixture.client!.exec('DROP TRIGGER fixture_fail_install ON hermes_team_profiles; DROP FUNCTION fixture_fail_install();'); }
    expect((await profileFor('alice')).installedRevision).toBeNull(); expect(await db.select().from(schema.hermesTeamResourceStates)).toHaveLength(0);
    expect(await readSkill('alice')).toBe('Team support procedure v1');
    expect(await createMemberUpdateService(dependencies).update(alice, 'team', input)).toMatchObject({ installedRevision: 1 });
  });
  it('detects member changes after planning, safely cancels untouched work and preserves later changes', async () => {
    await publishWorking(); const input = updateInput(null);
    beforeApply = async () => { await skillFile(roots.get('alice')!, 'support', 'new private collision after review'); };
    expect(await service.update(alice, 'team', input)).toMatchObject({ status: 'needs_attention', installedRevision: null }); beforeApply = undefined;
    expect(await service.cancel(alice, 'team', { requestId: input.requestId })).toMatchObject({ status: 'cancelled', installedRevision: null });
    expect((await profileFor('alice')).state).toBe('connection_needed'); await assertResourceUpdatesSettled(journals.get('alice')!);
    expect(await service.update(alice, 'team', input)).toMatchObject({ status: 'cancelled' }); expect(await readSkill('alice')).toBe('new private collision after review');
    expect(await service.update(alice, 'team', updateInput(null))).toMatchObject({ status: 'complete', conflictCount: 1 });
  });
  it('rejects stale conflict hashes and allows cancellation of the untouched request before a fresh choice', async () => {
    await publishWorking(); await service.update(alice, 'team', updateInput(null)); await skillFile(roots.get('alice')!, 'support', 'Alice correction');
    await skillFile(working, 'support', 'Team v2'); await publishWorking(1); await service.update(alice, 'team', updateInput(1));
    const conflict = (await service.preview(alice, 'team')).conflicts[0]; await skillFile(roots.get('alice')!, 'support', 'Alice newer correction');
    const input = { ...updateInput(2, 2), packageId: conflict.packageId, choice: 'use-team', expectedMemberHash: conflict.expectedMemberHash, expectedTeamHash: conflict.expectedTeamHash };
    await expect(service.resolve(alice, 'team', input)).rejects.toMatchObject({ status: 409 }); expect(await readSkill('alice')).toBe('Alice newer correction');
    await service.cancel(alice, 'team', { requestId: input.requestId });
    const current = (await service.preview(alice, 'team')).conflicts[0];
    await service.resolve(alice, 'team', { ...input, expectedMemberHash: current.expectedMemberHash, requestId: randomUUID() }); expect(await readSkill('alice')).toBe('Team v2');
  });
  it('retains attention and refuses corrupt native receipts instead of claiming resource readiness', async () => {
    await publishWorking(); fixture.apply.mockResolvedValueOnce({ status: 'complete' });
    await expect(service.update(alice, 'team', updateInput(null))).rejects.toThrow();
    expect((await profileFor('alice'))).toMatchObject({ installedRevision: null, state: 'needs_attention' });
  });
});

describe('Private identity, fresh audience checks and compatible HTTP', () => {
  it('keeps supported previews, receipts and filesystem writes scoped to each current member', async () => {
    await publishWorking(); await service.update(alice, 'team', updateInput(null)); await skillFile(roots.get('alice')!, 'support', 'Alice PRIVATE correction');
    await skillFile(working, 'support', 'Team v2'); await publishWorking(1); const input = updateInput(1); await service.update(alice, 'team', input);
    await service.update(bob, 'team', updateInput(null)); const preview = await service.preview(bob, 'team');
    expect(JSON.stringify(preview)).not.toMatch(/Alice PRIVATE|private-alice|protected-alice/); expect(await readSkill('bob')).toBe('Team v2');
    await expect(service.cancel(bob, 'team', { requestId: input.requestId })).rejects.toMatchObject({ status: 404 });
    await expect(service.resolve(bob, 'team', { ...updateInput(2, 2), packageId: 'skills/support', choice: 'use-team', expectedMemberHash: '0'.repeat(64), expectedTeamHash: '0'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    for (const extra of [{ profileId: (await profileFor('alice')).id }, { profileRoot: roots.get('alice') }, { runtimeId: 'alice' }, { plan: {} }])
      expect(memberUpdateRequestSchema.safeParse({ ...updateInput(2), ...extra }).success).toBe(false);
    expect(memberResolveRequestSchema.safeParse({ ...updateInput(2), choice: 'use-team' }).success).toBe(false);
  });
  it('reauthorizes before completed receipts and after inventory so ownership cannot bypass revocation', async () => {
    await publishWorking(); const input = updateInput(null); await service.update(alice, 'team', input);
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'alice'));
    await expect(service.update(alice, 'team', input)).rejects.toMatchObject({ status: 403 }); await expect(service.preview(alice, 'team')).rejects.toMatchObject({ status: 403 });
    expect(fixture.apply).toHaveBeenCalledTimes(1);
    beforeInventory = async () => { await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'bob')); };
    await expect(service.update(bob, 'team', updateInput(null))).rejects.toMatchObject({ status: 403 }); expect(fixture.apply).toHaveBeenCalledTimes(1);
    await expect(readSkill('bob')).rejects.toThrow();
  });
  it('does not acknowledge a resource update if access is revoked during native work', async () => {
    await publishWorking(); const input = updateInput(null);
    afterApply = async () => { await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'alice')); await db.update(schema.hermesTeamProfiles).set({ state: 'revoked' }).where(eq(schema.hermesTeamProfiles.userId, 'alice')); };
    await expect(service.update(alice, 'team', input)).rejects.toMatchObject({ status: 403 });
    expect((await profileFor('alice'))).toMatchObject({ installedRevision: null, state: 'revoked' });
    await expect(service.preview(alice, 'team')).rejects.toMatchObject({ status: 403 });
    // Fixtures retain historical disk content; the production broker additionally kills/rechecks scoped work on grant loss.
    expect(await readSkill('alice')).toBe('Team support procedure v1');
  });
  it('reports unsupported/busy native helpers and stale installed revisions explicitly', async () => {
    await publishWorking(); await expect(service.update(alice, 'team', updateInput(1))).rejects.toMatchObject({ status: 409 });
    fixture.inventory.mockRejectedValueOnce(new HttpError(503, 'Native resource updates are unavailable.'));
    await expect(service.preview(alice, 'team')).rejects.toMatchObject({ status: 503 });
    fixture.apply.mockRejectedValueOnce(new HttpError(409, 'A sibling profile is active.')); const input = updateInput(null);
    await expect(service.update(alice, 'team', input)).rejects.toMatchObject({ status: 409 }); expect((await profileFor('alice')).state).toBe('needs_attention');
    await service.cancel(alice, 'team', { requestId: input.requestId }); expect((await profileFor('alice')).state).toBe('connection_needed');
  });
  it('rejects stale definitions after inventory and rejects unbounded/hijacked route requests', async () => {
    await publishWorking();
    beforeInventory = async () => { await configureTeam(admin, 'team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 1 }); };
    await expect(service.update(alice, 'team', updateInput(null))).rejects.toMatchObject({ status: 409 }); expect(fixture.apply).not.toHaveBeenCalled();
    fixture.principal = null; expect((await previewRoute(new Request('https://portal.test.invalid/api/bots/team/team/updates'), ctx)).status).toBe(401);
    fixture.principal = alice;
    expect((await previewRoute(new Request('https://portal.test.invalid/api/bots/team/team/updates?profileId=other'), ctx)).status).toBe(400);
    expect((await previewRoute(new Request('https://portal.test.invalid/api/bots/team/team/updates?targetRevision=1&targetRevision=2'), ctx)).status).toBe(400);
    expect((await previewRoute(new Request('https://portal.test.invalid/api/bots/team/team/updates?targetRevision=-1'), ctx)).status).toBe(400);
    expect((await updateRoute(request('', updateInput(null), 'https://attacker.test.invalid'), ctx)).status).toBe(403);
    expect((await updateRoute(request('', { ...updateInput(null), profileRoot: roots.get('bob') }), ctx)).status).toBe(400);
    expect((await resolveRoute(request('/resolve', { ...updateInput(null), content: 'x'.repeat(100000) }), ctx)).status).toBe(413);
    expect((await cancelRoute(request('/cancel', { requestId: 'not-uuid' }), ctx)).status).toBe(400);
  });
  it('returns no-store own review and completion responses on web/iOS-compatible routes', async () => {
    await publishWorking(); const preview = await previewRoute(new Request('https://portal.test.invalid/api/bots/team/team/updates'), ctx);
    expect(preview.status).toBe(200); expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.json()).toMatchObject({ installedRevision: null, targetRevision: 1, nativeUpdatesSupported: true, state: 'connection_needed' });
    const updated = await updateRoute(request('', updateInput(null)), ctx); expect(updated.status).toBe(200); expect(updated.headers.get('cache-control')).toBe('no-store');
    expect(await updated.json()).toMatchObject({ status: 'complete', installedRevision: 1 });
    expect((await profileFor('alice')).state).toBe('connection_needed');
  });
});
