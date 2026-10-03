import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '@/db';
import { aiApps, bots, users, botPets, conversations, sharedLinks } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { newId } from '@/lib/ids';
import { pairDockerBot, nativeResources, authorizeDockerStream, isPersonalHermesConversation } from '@/lib/docker-hermes/store';
import { getAccessibleApp, getAccessibleBot, getEditableBot, listAccessibleApps, listAccessibleBots, HttpError } from '@/lib/authz';
import { resolveTurnTarget } from '@/lib/agent/target';
import { hermesTargetFor, resolveModel } from '@/lib/llm/resolve';
import { guardManagedBotMutation } from '@/lib/hermes-provisioning/bot-policy';
import { reconcileDockerRuntimes } from '@/lib/docker-hermes/lifecycle';
import type { DockerBinding } from '@/docker-hermes/types';
const f = vi.hoisted(() => ({ bindings: [] as DockerBinding[], calls: [] as { owner: string; action: string }[], principal: null as Principal | null }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerFetch: () => vi.fn(), dockerCleanupFetch: () => vi.fn(), dockerControl: async (owner: string, action: string) => {
  f.calls.push({ owner, action });
  if (action === '/admin/owners') return [...new Set(f.bindings.map(b => b.ownerId))];
  if (action === '/control/status') return { phase: 'ready', network: 'none', bindings: f.bindings.filter(b => b.ownerId === owner), unlinked: [] };
  if (action.startsWith('/resources/')) return { skills: [], memories: [{ id: 'MEMORY.md', content: owner }] };
  return {};
} }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => f.principal!, requireAdmin: async () => f.principal!,
  errorResponse: (e: unknown) => Response.json({ error: e instanceof HttpError ? e.message : 'Failed' }, { status: e instanceof HttpError ? e.status : 500 }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs', () => ({ enqueue: vi.fn(), QUEUES: {} }));
const suite = process.env.DOCKER_HERMES_DB_TEST === '1' ? describe : describe.skip;
suite('personal Docker Hermes app authorization and recovery (disposable PostgreSQL, mock broker)', () => {
  const ids: string[] = []; let alice: Principal, bob: Principal; let binding: DockerBinding;
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== '/collective_docker_hermes_test') throw new Error('Named disposable database required');
    for (const name of ['alice', 'bob']) {
      const id = newId(); ids.push(id); await db.insert(users).values({ id, upn: `${id}@example.invalid`, name, authSource: 'ldap', isAdmin: true });
    }
    [alice, bob] = await Promise.all(ids.map(async id => (await loadPrincipal(id))!)); f.principal = alice;
    vi.stubEnv('DOCKER_HERMES_SOCKET', '/tmp/mock-personal.sock'); vi.stubEnv('DOCKER_HERMES_ALLOWED_USER_IDS', ids.join(','));
    binding = { ownerId: alice.user.id, bindingId: 'b'.repeat(32), runtimeId: 'a'.repeat(64), botId: newId(), appId: newId(), name: 'Hermes', profile: 'default', identity: '1:100' };
    f.bindings = [binding];
  });
  afterAll(async () => {
    await db.delete(bots).where(inArray(bots.ownerId, ids));
    await db.delete(aiApps).where(inArray(aiApps.id, f.bindings.map(b => b.appId)));
    await db.delete(users).where(inArray(users.id, ids)); await pool.end(); vi.unstubAllEnvs();
  });
  it('recovers repeated/concurrent final pairing without duplicate app/bot/pet or organization-default changes', async () => {
    const [one, two] = await Promise.all([pairDockerBot(alice, binding), pairDockerBot(alice, binding)]); expect(one).toBe(two);
    const [bot] = await db.select().from(bots).where(eq(bots.id, one)); expect(bot).toMatchObject({ ownerId: alice.user.id, visibility: 'private', coordinatorEligible: false, executionMode: 'caller' });
    const pets = await db.select().from(botPets).where(and(eq(botPets.userId, alice.user.id), eq(botPets.botId, one)));
    expect(pets).toHaveLength(1); expect(pets[0]).toMatchObject({ appearance: 'moss', catalogId: null });
    // Retrying pairing must preserve an existing private avatar choice.
    await db.update(botPets).set({ appearance: 'ember' }).where(and(eq(botPets.userId, alice.user.id), eq(botPets.botId, one)));
    await pairDockerBot(alice, binding);
    const [retained] = await db.select().from(botPets).where(and(eq(botPets.userId, alice.user.id), eq(botPets.botId, one)));
    expect(retained).toMatchObject({ appearance: 'ember', catalogId: null });
  });
  it('denies a second user including administrator oversight for profile, edit, app, chat and native resources', async () => {
    for (const call of [() => getAccessibleBot(bob, binding.botId), () => getEditableBot(bob, binding.botId), () => getAccessibleApp(bob, binding.appId),
      () => resolveTurnTarget(bob, { botId: binding.botId, appId: null }), () => nativeResources(bob, binding.botId), () => pairDockerBot(bob, binding)])
      await expect(call()).rejects.toThrow();
    expect((await listAccessibleApps(bob)).some(a => a.id === binding.appId)).toBe(false);
    expect((await listAccessibleBots(bob)).some(b => b.id === binding.botId)).toBe(false);
    expect((await nativeResources(alice, binding.botId)).memories[0].content).toBe(alice.user.id);
  });
  it('preserves personal privacy and binding under edits, deletion, templates, groups and delegation', async () => {
    const [bot] = await db.select().from(bots).where(eq(bots.id, binding.botId));
    for (const change of [null, { ...bot, visibility: 'org' as const }, { ...bot, appId: 'another-app' }, { ...bot, executionMode: 'service' as const }])
      await expect(db.transaction(tx => guardManagedBotMutation(tx, alice, bot.id, change))).rejects.toThrow();
    const actions = await import('@/app/(chat)/bots/actions');
    for (const call of [() => actions.duplicateBot(bot.id), () => actions.createBotTemplate(bot.id), () => actions.createGroupChat([bot.id, 'other']),
      () => actions.saveSkill({ botId: bot.id, name: 'No editor', description: 'Native only', instructions: 'Do not copy state' })]) await expect(call()).rejects.toThrow();
    const { deleteApp, saveApp } = await import('@/app/admin/actions');
    await expect(deleteApp(binding.appId)).rejects.toThrow();
    await expect(saveApp({ id: binding.appId, provider: 'hermes', name: 'Changed', model: 'native-profile', config: {}, credentials: { mode: 'keep' } } as never)).rejects.toThrow();
  });
  it('uses its owner binding for native direct chat and refuses group/delegate/background use', async () => {
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, binding.appId));
    expect((await hermesTargetFor(app, { userId: alice.user.id, botId: binding.botId })).target.profile).toBe(binding.bindingId);
    await expect(hermesTargetFor(app, { userId: bob.user.id, botId: binding.botId })).rejects.toThrow();
    for (const purpose of ['group', 'delegate'] as const) await expect(resolveModel(app, { purpose, principal: alice, botId: binding.botId })).rejects.toThrow();
  });
  it('refuses new shares and historical share-token continuation for personal native transcripts', async () => {
    const conversationId = newId(), token = newId();
    await db.insert(conversations).values({ id: conversationId, userId: alice.user.id, botId: binding.botId, title: 'Private native transcript', currentLeafId: 'synthetic-cutoff' });
    try {
      const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      expect(await isPersonalHermesConversation(conversation)).toBe(true);
      const actions = await import('@/app/(chat)/actions'); f.principal = alice;
      await expect(actions.createShareLink(conversationId)).rejects.toThrow('remain private');
      await db.insert(sharedLinks).values({ id: token, conversationId, cutoffMessageId: 'synthetic-cutoff', createdBy: alice.user.id });
      f.principal = bob;
      await expect(actions.continueSharedConversation(token)).rejects.toThrow('Link not found');
    } finally { f.principal = alice; await db.delete(conversations).where(eq(conversations.id, conversationId)); }
  });
  it('allows editable name/avatar while refusing access after revocation and stopping via trusted reconciliation', async () => {
    const [bot] = await db.select().from(bots).where(eq(bots.id, binding.botId));
    await expect(db.transaction(tx => guardManagedBotMutation(tx, alice, bot.id, { ...bot, name: 'My Hermes', avatar: 'H' }))).resolves.toBeUndefined();
    await db.update(users).set({ disabled: true }).where(eq(users.id, alice.user.id));
    await expect(authorizeDockerStream(alice, bot.id)).rejects.toThrow();
    await expect(nativeResources(alice, bot.id)).rejects.toThrow();
    await expect(pairDockerBot(alice, binding)).rejects.toThrow();
    f.calls = []; await reconcileDockerRuntimes();
    expect(f.calls).toContainEqual({ owner: alice.user.id, action: '/control/stop' });
    expect(f.calls).not.toContainEqual({ owner: alice.user.id, action: '/control/lease' });
    await db.update(users).set({ disabled: false }).where(eq(users.id, alice.user.id));
    vi.stubEnv('DOCKER_HERMES_ALLOWED_USER_IDS', bob.user.id);
    await expect(authorizeDockerStream(alice, bot.id)).rejects.toThrow();
    f.calls = []; await reconcileDockerRuntimes(); expect(f.calls).toContainEqual({ owner: alice.user.id, action: '/control/stop' });
  });
});
