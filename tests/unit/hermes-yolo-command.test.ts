import { beforeEach, expect, it, vi } from 'vitest';
import type { AiApp, Bot, Conversation } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
const f = vi.hoisted(() => ({ conv: null as Conversation | null, app: {} as AiApp, bot: null as Bot | null, contexts: [] as unknown[], idle: vi.fn(), lock: vi.fn(), mode: vi.fn(), target: vi.fn(), insert: vi.fn() }));
vi.mock('@/db', async () => {
  const schema = await import('@/db/schema');
  const connection = {
    select: () => ({ from: (table: unknown) => {
      const rows = table === schema.conversations ? (f.conv ? [f.conv] : []) : table === schema.hermesRunContexts ? f.contexts : [];
      const chain = { where: () => chain, innerJoin: () => chain, orderBy: () => chain, limit: async () => rows, then: (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
      return chain;
    } }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => { f.insert(); f.conv ??= { id: 'chat123', userId: 'owner', appId: null, botId: 'bot456', isGroup: false, source: 'chat' } as Conversation; } }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(connection),
  };
  return { db: connection };
});
vi.mock('@/lib/agent/target', () => ({ resolveTurnTarget: async () => ({ app: f.app, bot: f.bot }) }));
vi.mock('@/lib/llm/resolve', () => ({ hermesTargetFor: f.target }));
vi.mock('@/lib/llm/providers/hermes/client', () => ({ sessionApprovalMode: f.mode, discoverHermes: async () => ({ models: { available: true, items: [] }, skills: { available: true, items: [] }, tools: { available: true, items: [] }, canStopRemotely: true }) }));
vi.mock('@/lib/runs/hermes-context', () => ({ assertHermesIdle: f.idle, hermesSettings: async () => null }));
vi.mock('@/lib/runs/lock', () => ({ lockUserRuns: f.lock }));
vi.mock('@/lib/runs/hermes-stop', () => ({}));
vi.mock('@/lib/runs/store', () => ({}));
vi.mock('@/lib/chat/fresh', () => ({}));
import { commandCatalog, executeHermesCommand, resolveCommandTarget } from '@/lib/chat/hermes-command-service';
import { hermesTargetKey } from '@/lib/llm/providers/hermes/scope';
const principal = { user: { id: 'owner' }, isAdmin: false } as Principal;
const remote = { baseUrl: 'https://hermes.test', profile: 'alice', apiKey: 'synthetic' };
const command = (text: string, p = principal) => executeHermesCommand(p, { conversationId: 'chat123', botId: 'bot456', text });
beforeEach(() => {
  vi.clearAllMocks();
  f.app = { id: 'app789', name: 'Fixture', model: 'default', provider: 'hermes', baseUrl: remote.baseUrl, apiKeyEnc: 'synthetic', providerConfig: { profile: 'alice' } } as unknown as AiApp;
  f.bot = { id: 'bot456', ownerId: 'owner' } as Bot;
  f.conv = { id: 'chat123', userId: 'owner', botId: 'bot456', appId: null, source: 'chat', isGroup: false } as Conversation;
  f.contexts = []; f.idle.mockResolvedValue(undefined);
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
it.each(['local', 'docker'])('does not offer or execute Runs YOLO on %s transport', async kind => {
  f.app.providerConfig[kind] = {};
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
it('refuses direct non-bot Hermes conversation', async () => {
  f.bot = null;
  await expect(command('/yolo on')).rejects.toMatchObject({ status: 400 });
  expect(f.target).not.toHaveBeenCalled();
});
