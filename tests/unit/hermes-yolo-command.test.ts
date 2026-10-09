import { beforeEach, expect, it, vi } from 'vitest';
import type { AiApp, Bot, Conversation } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
type Settings = { conversationId: string; targetKey: string; model: string | null; revision: number };
const f = vi.hoisted(() => ({ conv: null as Conversation | null, app: {} as AiApp, bot: null as Bot | null, contexts: [] as unknown[], hermesSettings: null as Settings | null, idle: vi.fn(), lock: vi.fn(), mode: vi.fn(), target: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('@/db', async () => {
  const schema = await import('@/db/schema');
  const connection = {
    select: () => ({ from: (table: unknown) => {
      const rows = table === schema.conversations ? (f.conv ? [f.conv] : []) : table === schema.hermesRunContexts ? f.contexts : [];
      const chain = { where: () => chain, innerJoin: () => chain, orderBy: () => chain, limit: async () => rows, then: (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
      return chain;
    } }),
    insert: (table: unknown) => ({ values: (values: Settings) => ({
      onConflictDoNothing: async () => {
        f.insert();
        if (table === schema.hermesChatSettings) f.hermesSettings ??= { ...values };
        else f.conv ??= { id: 'chat123', userId: 'owner', appId: null, botId: 'bot456', isGroup: false, source: 'chat' } as Conversation;
      },
      onConflictDoUpdate: ({ set }: { set: Omit<Settings, 'conversationId'> }) => ({ returning: async () => {
        f.update(set);
        f.hermesSettings = { ...values, ...set };
        return [f.hermesSettings];
      } }),
    }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(connection),
  };
  return { db: connection };
});
vi.mock('@/lib/agent/target', () => ({ resolveTurnTarget: async () => ({ app: f.app, bot: f.bot }) }));
vi.mock('@/lib/llm/resolve', () => ({ hermesTargetFor: f.target }));
vi.mock('@/lib/llm/providers/hermes/client', () => ({ sessionApprovalMode: f.mode, discoverHermes: async () => ({ models: { available: true, items: ['allowed-model'] }, skills: { available: true, items: [] }, tools: { available: true, items: [] }, canStopRemotely: true }) }));
vi.mock('@/lib/runs/hermes-context', () => ({ assertHermesIdle: f.idle, hermesSettings: async () => f.hermesSettings }));
vi.mock('@/lib/runs/lock', () => ({ lockUserRuns: f.lock }));
vi.mock('@/lib/runs/hermes-stop', () => ({}));
vi.mock('@/lib/runs/store', () => ({}));
vi.mock('@/lib/chat/fresh', () => ({}));
import { commandCatalog, executeHermesCommand, resolveCommandTarget } from '@/lib/chat/hermes-command-service';
import { hermesTargetKey } from '@/lib/llm/providers/hermes/scope';
const principal = { user: { id: 'owner' }, isAdmin: false } as Principal;
const remote = { baseUrl: 'https://hermes.test', profile: 'alice', apiKey: 'synthetic' };
const command = (text: string, p = principal, revision?: number) => executeHermesCommand(p, { conversationId: 'chat123', botId: 'bot456', text, revision });
beforeEach(() => {
  vi.clearAllMocks();
  f.app = { id: 'app789', name: 'Fixture', model: 'default', provider: 'hermes', baseUrl: remote.baseUrl, apiKeyEnc: 'synthetic', providerConfig: { profile: 'alice', allowedModels: 'allowed-model' } } as unknown as AiApp;
  f.bot = { id: 'bot456', ownerId: 'owner' } as Bot;
  f.conv = { id: 'chat123', userId: 'owner', botId: 'bot456', appId: null, source: 'chat', isGroup: false } as Conversation;
  f.contexts = []; f.hermesSettings = null; f.idle.mockResolvedValue(undefined);
  f.target.mockResolvedValue({ target: remote });
  f.mode.mockResolvedValue({ session_id: 'portal-chat123-bot456', profile: 'alice', enabled: true, scope: 'session' });
});
it.each(['/yolo', '/yolo status', '/yolo on', '/yolo off'])('executes %s without inference on exact Runs identity', async text => {
  const result = await command(text);
  expect(result.title).toBe('Session YOLO');
  expect(f.mode).toHaveBeenCalledWith(remote, 'portal-chat123-bot456', text.endsWith(' on') ? true : text.endsWith(' off') ? false : undefined);
  if (text.endsWith(' on') || text.endsWith(' off')) {
    expect(f.lock).toHaveBeenCalled(); expect(f.idle).toHaveBeenCalled(); expect(result.conversationId).toBe('chat123');
  }
});
it('supports persisted portal conversation before first run', async () => {
  f.conv = null;
  await command('/yolo on');
  expect(f.insert).toHaveBeenCalled();
});
it('publishes verified backend state in the chat catalog', async () => {
  expect(await commandCatalog(await resolveCommandTarget(principal, { conversationId: 'chat123' }))).toMatchObject({ yolo: { available: true, enabled: true } });
  f.mode.mockRejectedValue(new Error('bad identity'));
  expect(await commandCatalog(await resolveCommandTarget(principal, { conversationId: 'chat123' }))).toMatchObject({ yolo: { available: false } });
});
it('rejects other user even when admin before remote access', async () => {
  await expect(command('/yolo on', { ...principal, user: { id: 'other' }, isAdmin: true } as Principal)).rejects.toMatchObject({ status: 404 });
  expect(f.target).not.toHaveBeenCalled();
});
it('requires bot owner or admin, not merely shared-bot access', async () => {
  f.bot!.ownerId = 'another';
  await expect(command('/yolo on')).rejects.toMatchObject({ status: 403 });
  expect(f.target).not.toHaveBeenCalled();
  await command('/yolo on', { ...principal, isAdmin: true });
  expect(f.mode).toHaveBeenCalled();
});
it.each(['/yolo yes', '/yolo on now'])('rejects invalid syntax %s before HTTP', async text => {
  await expect(command(text)).rejects.toMatchObject({ status: 400 });
  expect(f.target).not.toHaveBeenCalled();
});
it('rejects active or unconfirmed stopped runs before HTTP mutation', async () => {
  f.idle.mockRejectedValue(Object.assign(new Error('busy'), { status: 409 }));
  await expect(command('/yolo off')).rejects.toMatchObject({ status: 409 });
  expect(f.mode).not.toHaveBeenCalled();
});
it('refuses changed connection before sending stored session ID', async () => {
  f.contexts = [{ targetKey: hermesTargetKey({ ...f.app, baseUrl: 'https://old.test' }) }];
  await expect(command('/yolo on')).rejects.toMatchObject({ status: 409 });
  expect(f.mode).not.toHaveBeenCalled();
});
it.each(['/yolo', '/yolo status', '/yolo on', '/yolo off'])('executes %s for the paired local controller and publishes its verified status', async text => {
  f.app.providerConfig.local = { runtimeId: 'a'.repeat(64), bindingId: 'b'.repeat(32), ownerId: 'owner', botId: 'bot456', model: '', provider: '' };
  const local = { baseUrl: 'http://local-hermes.invalid', profile: 'b'.repeat(32), apiKey: '', local: true };
  f.target.mockResolvedValue({ target: local });
  f.mode.mockResolvedValue({ session_id: 'portal-chat123-bot456', profile: local.profile, enabled: true, scope: 'session' });
  expect((await command(text, { ...principal, isAdmin: true })).title).toBe('Session YOLO');
  expect(f.mode).toHaveBeenCalledWith(local, 'portal-chat123-bot456', text.endsWith(' on') ? true : text.endsWith(' off') ? false : undefined);
  const catalog = await commandCatalog(await resolveCommandTarget({ ...principal, isAdmin: true }, { conversationId: 'chat123' }));
  expect(catalog).toMatchObject({ yolo: { available: true, enabled: true, verifier: 'local-controller' } });
  expect(catalog.backend === 'hermes' && catalog.commands.some(c => c.name === 'yolo')).toBe(true);
});
it('does not offer or execute Runs YOLO on docker transport', async () => {
  f.app.providerConfig.docker = {};
  await expect(command('/yolo on')).rejects.toMatchObject({ status: 400 });
  const catalog = await commandCatalog(await resolveCommandTarget(principal, { conversationId: 'chat123' }));
  expect(catalog.backend === 'hermes' && catalog.commands.some(c => c.name === 'yolo')).toBe(false);
  expect(f.mode).not.toHaveBeenCalled();
});
it('orders admission lock and idle check before backend mutation and reports uncertain writes as errors', async () => {
  await command('/yolo on');
  expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.idle.mock.invocationCallOrder[0]);
  expect(f.idle.mock.invocationCallOrder[0]).toBeLessThan(f.mode.mock.invocationCallOrder[0]);
  f.mode.mockRejectedValue(new Error('readback lost'));
  await expect(command('/yolo off')).rejects.toThrow('readback lost');
});
it('pins managed profile resolution to the recorded provision and rejects ambiguous bindings', async () => {
  f.contexts = [{ targetKey: hermesTargetKey(f.app), provisionId: 'original-provision' }];
  await command('/yolo');
  expect(f.target).toHaveBeenCalledWith(f.app, { userId: 'owner', botId: 'bot456', provisionId: 'original-provision', verify: true });
  f.target.mockClear(); f.mode.mockClear();
  f.contexts.push({ targetKey: hermesTargetKey(f.app), provisionId: 'another-provision' });
  await expect(command('/yolo on')).rejects.toMatchObject({ status: 409 });
  expect(f.target).not.toHaveBeenCalled(); expect(f.mode).not.toHaveBeenCalled();
});
it.each(['/model default', '/model allowed-model'])('rejects %s after a first-run YOLO pin is retargeted without overwriting it', async text => {
  await command('/yolo on');
  const pinned = { ...f.hermesSettings! };
  f.app.providerConfig.profile = 'bob';
  f.target.mockClear(); f.mode.mockClear();
  await expect(command(text, principal, pinned.revision)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/fresh chat/i) });
  expect(f.update).not.toHaveBeenCalled();
  expect(f.hermesSettings).toEqual(pinned);
  await expect(command('/yolo')).rejects.toMatchObject({ status: 409 });
  expect(f.mode).not.toHaveBeenCalled();
});
it('preserves normal model changes and idempotent retries on the pinned target', async () => {
  await command('/yolo on');
  const targetKey = f.hermesSettings!.targetKey;
  expect(await command('/model default')).toMatchObject({ revision: 0 });
  expect(f.update).not.toHaveBeenCalled();
  expect(await command('/model allowed-model', principal, 0)).toMatchObject({ revision: 1 });
  expect(await command('/model allowed-model', principal, 0)).toMatchObject({ revision: 1 });
  expect(f.update).toHaveBeenCalledTimes(1);
  await expect(command('/model default', principal, 0)).rejects.toMatchObject({ status: 409 });
  expect(f.update).toHaveBeenCalledTimes(1);
  expect(await command('/model default', principal, 1)).toMatchObject({ revision: 2 });
  expect(await command('/model default', principal, 1)).toMatchObject({ revision: 2 });
  expect(f.update).toHaveBeenCalledTimes(2);
  expect(f.hermesSettings).toEqual({ conversationId: 'chat123', targetKey, model: null, revision: 2 });
});
it('refuses direct non-bot Hermes conversation', async () => {
  f.bot = null;
  await expect(command('/yolo on')).rejects.toMatchObject({ status: 400 });
  expect(f.target).not.toHaveBeenCalled();
});
