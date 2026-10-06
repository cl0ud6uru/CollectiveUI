import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as unknown,
  capture: vi.fn(async () => null as unknown) }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock('@/lib/session', async () => {
  const { HttpError } = await import('@/lib/authz');
  return { requirePrincipal: async () => { if (!fixture.principal) throw new HttpError(401, 'Unauthorized'); return fixture.principal; } };
});
vi.mock('@/lib/hermes-team/transport', () => ({ captureTeamResources: fixture.capture }));
import { db, schema } from '@/db';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { createTeamResourceSnapshot, resourceSha256, type TeamResource, type TeamResourceSnapshot } from '@/lib/hermes-team/resources';
import { createTeamPublicationService, teamCaptureRequestSchema, teamPublishRequestSchema } from '@/lib/hermes-team/publication';
import { POST as captureRoute } from '@/app/api/bots/[id]/team/capture/route';
import { POST as publishRoute, GET as rolloutRoute } from '@/app/api/bots/[id]/team/publish/route';
let admin: Principal, otherAdmin: Principal, alice: Principal, clock: Date;
const resource = (content: string, packageName = 'support', filename = 'SKILL.md'): TeamResource => ({ path: `skills/${packageName}/${filename}`, kind: 'skill', packageId: `skills/${packageName}`,
  encoding: 'utf8', content, size: Buffer.byteLength(content), sha256: resourceSha256(content) });
const snapshot = (content = 'Reviewed support procedure.'): TeamResourceSnapshot => createTeamResourceSnapshot([resource(content), resource('print("fixture, never execute")', 'support', 'scripts/check.py')]);
const captureInput = { expectedRevision: 0, selection: { skillPackages: ['support'] } };
const service = createTeamPublicationService({ captureResources: fixture.capture, now: () => clock });
const publishInput = (snapshotId: string, overrides: Record<string, unknown> = {}) => ({ snapshotId, expectedRevision: 0,
  selectedKeys: ['skills/support'], removalKeys: [], releaseNote: 'Teach the shared support procedure.', requestId: randomUUID(), ...overrides });
const captureThen = async (content = 'Reviewed support procedure.', expectedRevision = 0) => {
  fixture.capture.mockResolvedValueOnce(snapshot(content));
  return service.capture(admin, 'team', { ...captureInput, expectedRevision });
};
const request = (path: string, body: unknown, origin = 'https://portal.test.invalid') => new Request(`https://portal.test.invalid${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = { params: Promise.resolve({ id: 'team' }) };
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(name => name.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('AUTH_URL', 'https://portal.test.invalid');
  fixture.capture.mockReset(); fixture.capture.mockResolvedValue(snapshot()); clock = new Date('2026-10-06T20:00:00Z');
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await db.insert(schema.users).values([
    { id: 'admin', name: 'Admin', upn: 'admin@test.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true },
    { id: 'other-admin', name: 'Other admin', upn: 'other-admin@test.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true },
    { id: 'alice', name: 'Alice', upn: 'alice@test.invalid', authSource: 'local', identityRealm: 'local' },
  ]);
  admin = (await loadPrincipal('admin'))!; otherAdmin = (await loadPrincipal('other-admin'))!; alice = (await loadPrincipal('alice'))!; fixture.principal = admin;
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', name: 'Team', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values({ botId: 'team', userId: 'alice' });
  await configureTeam(admin, 'team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin', 'other-admin'], enabled: true, expectedVersion: 0 });
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('Team resource capture authorization and immutable review persistence', () => {
  it('checks the feature flag, current administrator and maintainer permission before broker capture', async () => {
    vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '');
    await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 404 });
    vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1');
    await expect(service.capture(alice, 'team', captureInput)).rejects.toMatchObject({ status: 403 });
    await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId, 'other-admin'));
    await expect(service.capture(otherAdmin, 'team', captureInput)).rejects.toMatchObject({ status: 403 });
    expect(fixture.capture).not.toHaveBeenCalled();
  });
  it('persists exact bounded bytes bound to actor, base revision, definition version and server expiry', async () => {
    const captured = await captureThen();
    expect(captured).toMatchObject({ expectedRevision: 0, definitionVersion: 1, expiresAt: '2026-10-06T20:15:00.000Z',
      changes: [{ packageId: 'skills/support', change: 'added' }] });
    const [saved] = await db.select().from(schema.hermesTeamCaptures);
    expect(saved).toMatchObject({ capturedBy: 'admin', expectedRevision: 0, definitionVersion: 1, manifestHash: snapshot().manifestHash, manifest: snapshot() });
    expect(fixture.capture).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ id: 'admin' }) }), 'team',
      { skillPackages: ['support'], includeRole: false, documents: [] });
    expect(JSON.stringify(saved)).not.toMatch(/profileRoot|profileId|runtimeId/);
  });
  it('rejects stale base revision before I/O and changed definition after I/O', async () => {
    await expect(service.capture(admin, 'team', { ...captureInput, expectedRevision: 2 })).rejects.toMatchObject({ status: 409 });
    expect(fixture.capture).not.toHaveBeenCalled();
    fixture.capture.mockImplementationOnce(async () => {
      await configureTeam(admin, 'team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin', 'other-admin'], enabled: true, expectedVersion: 1 });
      return snapshot();
    });
    await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamCaptures)).toHaveLength(0);
  });
  it('rechecks fresh maintainer and account access after broker I/O', async () => {
    fixture.capture.mockImplementationOnce(async () => {
      await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId, 'admin')); return snapshot();
    });
    await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.hermesTeamCaptures)).toHaveLength(0);
    await db.insert(schema.hermesTeamMaintainers).values({ botId: 'team', userId: 'admin' });
    fixture.capture.mockImplementationOnce(async () => { await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'admin')); return snapshot(); });
    await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(schema.hermesTeamCaptures)).toHaveLength(0);
  });
  it('rejects corrupt/unsafe broker manifests and keeps unsupported capture explicit', async () => {
    for (const invalid of [null, { ...snapshot(), manifestHash: '0'.repeat(64) }, { ...snapshot(), resources: [{ ...resource('private'), path: '../auth.json' }] }]) {
      fixture.capture.mockResolvedValueOnce(invalid);
      await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 422 });
    }
    fixture.capture.mockRejectedValueOnce(new HttpError(503, 'Native resource capture is not supported by this broker yet.'));
    await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 503 });
    expect(await db.select().from(schema.hermesTeamCaptures)).toHaveLength(0);
  });
  it('never accepts browser paths, profile IDs, manifests or arbitrary runtime fields', () => {
    for (const extra of [{ profileRoot: '/tmp/secret' }, { profileId: 'someone-else' }, { manifest: snapshot() }, { runtimeId: 'native' }])
      expect(teamCaptureRequestSchema.safeParse({ ...captureInput, ...extra }).success).toBe(false);
    for (const selection of [{ documents: ['../auth.json'] }, { skillPackages: ['.env'] }, { skillPackages: ['/tmp'] }])
      expect(teamCaptureRequestSchema.safeParse({ ...captureInput, selection }).success).toBe(false);
  });
});

describe('Atomic immutable publication and retries', () => {
  it('publishes the exact reviewed snapshot even when native learning changes afterward', async () => {
    const captured = await captureThen('exact reviewed content');
    fixture.capture.mockResolvedValue(snapshot('later native learning'));
    const input = publishInput(captured.snapshotId), result = await service.publish(admin, 'team', input);
    expect(result).toEqual({ revision: 1, manifestHash: snapshot('exact reviewed content').manifestHash, requestId: input.requestId });
    expect(fixture.capture).toHaveBeenCalledTimes(1);
    const [revision] = await db.select().from(schema.hermesTeamRevisions), [operation] = await db.select().from(schema.hermesTeamOperations);
    expect(revision.manifest).toEqual(snapshot('exact reviewed content')); expect(operation).toMatchObject({ state: 'complete', result });
    expect((await db.select().from(schema.hermesTeamDefinitions))[0].publishedRevision).toBe(1);
  });
  it('handles concurrent duplicate clicks and completed retries without another revision', async () => {
    const captured = await captureThen(), input = publishInput(captured.snapshotId);
    const [first, second] = await Promise.all([service.publish(admin, 'team', input), service.publish(admin, 'team', input)]);
    expect(second).toEqual(first); expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(1);
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    expect(await service.publish(admin, 'team', input)).toEqual(first); expect(await db.select().from(schema.hermesTeamOperations)).toHaveLength(1);
  });
  it('rejects reused request IDs with different selections or notes and stale independent screens', async () => {
    const captured = await captureThen(), secondCapture = await captureThen('another review'), input = publishInput(captured.snapshotId);
    await service.publish(admin, 'team', input);
    await expect(service.publish(admin, 'team', { ...input, releaseNote: 'Different request' })).rejects.toMatchObject({ status: 409 });
    await expect(service.publish(admin, 'team', publishInput(secondCapture.snapshotId))).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(1);
  });
  it('reauthorizes before serving even an exact completed operation receipt', async () => {
    const captured = await captureThen(), input = publishInput(captured.snapshotId); await service.publish(admin, 'team', input);
    await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId, 'admin'));
    await expect(service.publish(admin, 'team', input)).rejects.toMatchObject({ status: 403 });
    await expect(service.rollout(admin, 'team')).rejects.toMatchObject({ status: 403 });
  });
  it('binds each review to its capturing maintainer and bot and rejects missing/expired reviews', async () => {
    const captured = await captureThen();
    await expect(service.publish(otherAdmin, 'team', publishInput(captured.snapshotId))).rejects.toMatchObject({ status: 404 });
    await db.insert(schema.bots).values({ id: 'other-team', ownerId: 'admin', name: 'Other', visibility: 'org' });
    await configureTeam(admin, 'other-team', { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 0 });
    await expect(service.publish(admin, 'other-team', publishInput(captured.snapshotId))).rejects.toMatchObject({ status: 404 });
    await expect(service.publish(admin, 'team', publishInput('missing'))).rejects.toMatchObject({ status: 404 });
    clock = new Date('2026-10-06T20:15:00Z');
    await expect(service.publish(admin, 'team', publishInput(captured.snapshotId))).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(0);
  });
  it('invalidates a reviewed snapshot after bot definition changes even without a new publication', async () => {
    const captured = await captureThen();
    await configureTeam(admin, 'team', { modelPolicy: { mode: 'admin_provided' }, maintainerIds: ['admin', 'other-admin'], enabled: true, expectedVersion: 1 });
    await expect(service.publish(admin, 'team', publishInput(captured.snapshotId))).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamOperations)).toHaveLength(0);
  });
  it('rejects a publication racing a capture and independent concurrent publishes from the same base', async () => {
    const first = await captureThen('first review'), firstInput = publishInput(first.snapshotId);
    fixture.capture.mockImplementationOnce(async () => { await service.publish(admin, 'team', firstInput); return snapshot('stale in-flight capture'); });
    await expect(service.capture(admin, 'team', captureInput)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamCaptures)).toHaveLength(1);
    const a = await captureThen('revision two option A', 1), b = await captureThen('revision two option B', 1);
    const results = await Promise.allSettled([
      service.publish(admin, 'team', publishInput(a.snapshotId, { expectedRevision: 1 })),
      service.publish(admin, 'team', publishInput(b.snapshotId, { expectedRevision: 1 })),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(2);
  });
  it('checks completed receipt result against its exact immutable revision before returning it', async () => {
    const captured = await captureThen(), input = publishInput(captured.snapshotId), result = await service.publish(admin, 'team', input);
    await db.update(schema.hermesTeamOperations).set({ result: { ...result, revision: 2 } });
    await expect(service.publish(admin, 'team', input)).rejects.toMatchObject({ status: 409 });
    await db.update(schema.hermesTeamOperations).set({ result: { ...result, manifestHash: '0'.repeat(64) } });
    await expect(service.publish(admin, 'team', input)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(1);
  });
  it('preserves unselected packages and publishes removals only from the frozen review', async () => {
    fixture.capture.mockResolvedValueOnce(createTeamResourceSnapshot([resource('support v1'), resource('keep this', 'other')]));
    const first = await service.capture(admin, 'team', { ...captureInput, selection: { skillPackages: ['support', 'other'] } });
    await service.publish(admin, 'team', publishInput(first.snapshotId, { selectedKeys: ['skills/support', 'skills/other'] }));
    const second = await captureThen('support v2', 1);
    await expect(service.publish(admin, 'team', publishInput(second.snapshotId, { expectedRevision: 1, removalKeys: ['skills/arbitrary'] }))).rejects.toMatchObject({ status: 422 });
    await service.publish(admin, 'team', publishInput(second.snapshotId, { expectedRevision: 1 }));
    const revisions = await db.select().from(schema.hermesTeamRevisions);
    expect((revisions[1].manifest as unknown as TeamResourceSnapshot).resources.some(row => row.packageId === 'skills/other')).toBe(true);
    const third = await captureThen('support v3', 2);
    await service.publish(admin, 'team', publishInput(third.snapshotId, { expectedRevision: 2, removalKeys: ['skills/other'] }));
    const [revision] = await db.select().from(schema.hermesTeamRevisions).where(eq(schema.hermesTeamRevisions.revision, 3));
    expect((revision.manifest as unknown as TeamResourceSnapshot).resources.some(row => row.packageId === 'skills/other')).toBe(false);
  });
  it('rolls back all revision/receipt/version mutations on an injected transaction failure and safely retries', async () => {
    const captured = await captureThen(), input = publishInput(captured.snapshotId);
    await fixture.client!.exec(`CREATE FUNCTION fixture_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.published_revision <> OLD.published_revision THEN RAISE EXCEPTION 'synthetic crash'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_fail_publish BEFORE UPDATE ON hermes_team_definitions FOR EACH ROW EXECUTE FUNCTION fixture_fail_publish();`);
    try { await expect(service.publish(admin, 'team', input)).rejects.toThrow(); }
    finally { await fixture.client!.exec('DROP TRIGGER fixture_fail_publish ON hermes_team_definitions; DROP FUNCTION fixture_fail_publish();'); }
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(0); expect(await db.select().from(schema.hermesTeamOperations)).toHaveLength(0);
    expect((await db.select().from(schema.hermesTeamDefinitions))[0].publishedRevision).toBe(0);
    expect(await service.publish(admin, 'team', input)).toMatchObject({ revision: 1 });
  });
  it('enforces database immutability for both UPDATE and DELETE', async () => {
    const captured = await captureThen(); await service.publish(admin, 'team', publishInput(captured.snapshotId));
    await expect(fixture.client!.exec("UPDATE hermes_team_revisions SET release_note = 'tampered' WHERE bot_id = 'team'")).rejects.toThrow('immutable');
    await expect(fixture.client!.exec("DELETE FROM hermes_team_revisions WHERE bot_id = 'team'")).rejects.toThrow('immutable');
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(1);
  });
  it('rejects corrupt stored captures and pending operation receipts without making a new revision', async () => {
    const captured = await captureThen(), input = publishInput(captured.snapshotId);
    await db.update(schema.hermesTeamCaptures).set({ manifestHash: '0'.repeat(64) }).where(eq(schema.hermesTeamCaptures.id, captured.snapshotId));
    await expect(service.publish(admin, 'team', input)).rejects.toMatchObject({ status: 503 });
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(0);
    await db.update(schema.hermesTeamCaptures).set({ manifestHash: snapshot().manifestHash }).where(eq(schema.hermesTeamCaptures.id, captured.snapshotId));
    await service.publish(admin, 'team', input);
    await db.update(schema.hermesTeamOperations).set({ state: 'pending' });
    await expect(service.publish(admin, 'team', input)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(1);
  });
  it('returns only aggregate member rollout state/counts and explicitly reports unsupported native updates', async () => {
    const captured = await captureThen(); await service.publish(admin, 'team', publishInput(captured.snapshotId));
    const profile = await reserveTeamProfile(alice, 'team', 'member'); await reserveTeamProfile(admin, 'team', 'admin');
    await db.update(schema.hermesTeamProfiles).set({ state: 'ready', installedRevision: 0 }).where(eq(schema.hermesTeamProfiles.id, profile.id));
    await db.insert(schema.hermesTeamResourceStates).values({ profileId: profile.id, packageId: 'skills/private-learning', installedHash: 'private-hash', conflictRevision: 1, override: 'modified' });
    const rollout = await service.rollout(admin, 'team');
    expect(rollout).toEqual({ publishedRevision: 1, nativeUpdatesSupported: false, profileCount: 1, states: { ready: 1 }, conflictCount: 1, conflictedProfileCount: 1, updatesNeeded: 1 });
    expect(JSON.stringify(rollout)).not.toMatch(/private|skills|profileId|manifest|content|hash|alice/);
    await expect(service.rollout(alice, 'team')).rejects.toMatchObject({ status: 403 });
  });
});

describe('Publication HTTP boundaries', () => {
  it('authenticates, rejects cross-origin writes and invalid or oversized bodies without a broker call', async () => {
    fixture.principal = null;
    expect((await captureRoute(request('/api/bots/team/team/capture', captureInput), ctx)).status).toBe(401);
    fixture.principal = admin;
    expect((await captureRoute(request('/api/bots/team/team/capture', captureInput, 'https://attacker.test.invalid'), ctx)).status).toBe(403);
    expect((await captureRoute(new Request('https://portal.test.invalid/api/bots/team/team/capture', { method: 'POST', headers: { origin: 'https://portal.test.invalid', 'content-type': 'text/plain' }, body: '{}' }), ctx)).status).toBe(415);
    expect((await captureRoute(request('/api/bots/team/team/capture', { ...captureInput, profileRoot: '/tmp' }), ctx)).status).toBe(400);
    const malformed = new Request('https://portal.test.invalid/api/bots/team/team/capture', { method: 'POST', headers: { origin: 'https://portal.test.invalid', 'content-type': 'application/json' }, body: '{' });
    expect((await captureRoute(malformed, ctx)).status).toBe(400);
    expect((await captureRoute(request('/api/bots/team/team/capture', { text: 'x'.repeat(100000) }), ctx)).status).toBe(413);
    expect(fixture.capture).not.toHaveBeenCalled();
  });
  it('returns no-store reviewed capture, publishes by persistent request UUID and hides rollout from non-maintainers', async () => {
    const response = await captureRoute(request('/api/bots/team/team/capture', captureInput), ctx);
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
    const captured = await response.json(), input = publishInput(captured.snapshotId);
    const published = await publishRoute(request('/api/bots/team/team/publish', input), ctx);
    expect(published.status).toBe(200); expect(published.headers.get('cache-control')).toBe('no-store');
    expect(await published.json()).toMatchObject({ revision: 1, requestId: input.requestId });
    fixture.principal = alice;
    expect((await rolloutRoute(new Request('https://portal.test.invalid/api/bots/team/team/publish'), ctx)).status).toBe(403);
    expect((await publishRoute(request('/api/bots/team/team/publish', input), ctx)).status).toBe(403);
  });
  it('rejects per-file/duplicate selections and missing or arbitrary request UUIDs', () => {
    const input = publishInput('snapshot');
    for (const extra of [{ requestId: '../arbitrary' }, { requestId: undefined }, { selectedKeys: [] }, { selectedKeys: ['skills/support', 'skills/support'] },
      { profileId: 'foreign' }, { manifest: snapshot() }]) expect(teamPublishRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
});
