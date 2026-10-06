import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Principal } from '@/lib/auth/groups';
const f = vi.hoisted(() => ({ owner: 'owner', botOwner: 'owner', docker: false, canCreate: true, status: 'running', cancelled: false, group: false, local: true, changedAtDispatch: '' as '' | 'profile' | 'endpoint' | 'credential', boundKey: '', resolutions: 0, row: true, queryParams: [] as unknown[], target: vi.fn(), control: vi.fn(), view: vi.fn(), lease: vi.fn() }));
vi.mock('@/lib/authz', () => {
  class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { HttpError, getOwnedConversation: async (p: Principal, id: string) => { if (p.user.id !== f.owner || id !== 'conversation') throw new HttpError(404, 'Conversation not found'); return { id, isGroup: f.group }; } };
});
vi.mock('@/lib/agent/target', () => ({ resolveTurnTarget: async () => { f.resolutions++; return { app: { id: 'app', baseUrl: f.changedAtDispatch === 'endpoint' && f.resolutions > 1 ? 'https://other.example.test' : 'https://example.test', apiKeyEnc: f.changedAtDispatch === 'credential' && f.resolutions > 1 ? 'synthetic-other-cipher' : 'synthetic-cipher', providerConfig: { profile: f.changedAtDispatch === 'profile' && f.resolutions > 1 ? 'other' : 'default' } }, bot: { id: 'bot', ownerId: f.botOwner } }; } }));
vi.mock('@/lib/local-hermes/config', () => ({ isLocalHermes: () => f.local }));
vi.mock('@/lib/docker-hermes/policy', async () => {
  const { HttpError } = await import('@/lib/authz');
  return { isDockerHermes: () => f.docker, assertDockerCreate: async () => { if (!f.canCreate) throw new HttpError(403, 'Docker work disabled'); } };
});
vi.mock('@/lib/docker-hermes/store', () => ({ withDockerAccess: async (p: Principal, _admit: boolean, work: (p: Principal, tx: unknown) => unknown) => work(p, undefined) }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({}) }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: f.lease }));
vi.mock('@/lib/llm/resolve', () => ({ hermesTargetFor: f.target }));
vi.mock('@/lib/llm/providers/hermes/client', () => ({ managedRunView: f.view, controlManagedRun: f.control }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: (condition: unknown) => {
  f.queryParams = new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]).params;
  return { orderBy: () => ({ limit: async () => f.row ? [{ run: { id: 'run', status: f.status, cancelRequestedAt: f.cancelled ? new Date() : null }, context: { upstreamRunId: 'upstream', targetKey: f.boundKey } }] : [] }) };
} }) }) }) } }));
// The real service is under active implementation in the root worktree.
import { hermesTargetKey } from '@/lib/llm/providers/hermes/scope';
import { mutateManagedNative, viewManagedNative } from '@/lib/hermes-native/managed';
const principal = (id = 'owner') => ({ user: { id } }) as Principal;
const answer = { operation: 'answer', requestId: 'a'.repeat(32), answer: { value: 'synthetic-protected-value' } };
const steer = { operation: 'steer', requestId: '4f9d4967-bcad-40ed-990c-1b9eeb99bec5', text: 'Synthetic correction' };
describe('managed/local native ownership and active-turn boundaries', () => {
  beforeEach(() => { vi.clearAllMocks(); Object.assign(f, { owner: 'owner', botOwner: 'owner', docker: false, canCreate: true, status: 'running', cancelled: false, group: false, local: true, changedAtDispatch: '', resolutions: 0, row: true, queryParams: [] }); f.boundKey = hermesTargetKey({ id: 'app', baseUrl: 'https://example.test', apiKeyEnc: 'synthetic-cipher', providerConfig: { profile: 'default' } }); f.target.mockResolvedValue({ target: { baseUrl: 'https://example.test' } }); f.control.mockResolvedValue({ accepted: true }); f.view.mockResolvedValue({ running: true }); });
  it('rejects foreign conversation owners before retrieving an upstream target', async () => {
    await expect(viewManagedNative(principal('intruder'), 'conversation')).rejects.toThrow('not found');
    await expect(mutateManagedNative(principal('intruder'), 'conversation', answer)).rejects.toThrow('not found');
    expect(f.target).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
  });
  it('rejects group conversations and bots owned by another user', async () => {
    f.group = true; await expect(mutateManagedNative(principal(), 'conversation', answer)).rejects.toThrow('private bot');
    f.group = false; f.botOwner = 'someone-else'; await expect(viewManagedNative(principal(), 'conversation')).rejects.toThrow('private bot'); expect(f.target).not.toHaveBeenCalled();
  });
  it('queries the recorded run by user, conversation, bot and app and verifies the selected target', async () => {
    expect(await mutateManagedNative(principal(), 'conversation', answer)).toEqual({ accepted: true });
    expect(f.queryParams).toEqual(['conversation', 'owner', 'bot', 'app']);
    expect(f.target).toHaveBeenCalledWith(expect.objectContaining({ id: 'app' }), { userId: 'owner', botId: 'bot', verify: true });
    expect(f.control).toHaveBeenCalledWith({ baseUrl: 'https://example.test' }, 'upstream', answer);
  });
  it.each(['profile', 'endpoint', 'credential'] as const)('rechecks the %s binding before dispatch when it changes during admission', async changed => {
    f.changedAtDispatch = changed;
    await expect(mutateManagedNative(principal(), 'conversation', answer)).rejects.toThrow('connection changed'); expect(f.control).not.toHaveBeenCalled(); expect(f.target).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed', 'cancelled'])('rejects %s turns without dispatching an answer or new work', async status => {
    f.status = status; await expect(mutateManagedNative(principal(), 'conversation', answer)).rejects.toThrow('already ended'); await expect(mutateManagedNative(principal(), 'conversation', steer)).rejects.toThrow('already ended'); expect(f.control).not.toHaveBeenCalled();
  });
  it('blocks control after cancellation was requested, even while the run still says running', async () => {
    f.cancelled = true; await expect(mutateManagedNative(principal(), 'conversation', answer)).rejects.toThrow('cancellation'); expect(f.control).not.toHaveBeenCalled();
  });
  it('permits pending answers under Docker disablement and transmits a disabled creation lease', async () => {
    f.docker = true; f.canCreate = false; f.status = 'waiting';
    await mutateManagedNative(principal(), 'conversation', answer);
    expect(f.lease).toHaveBeenCalledWith('owner', '/control/lease', { canCreate: false }, 3000); expect(f.control).toHaveBeenCalledOnce();
  });
  it.each(['steer', 'queue'])('blocks %s when Docker admission is disabled, before lease or controller dispatch', async operation => {
    f.docker = true; f.canCreate = false;
    await expect(mutateManagedNative(principal(), 'conversation', { ...steer, operation })).rejects.toThrow('New native work is disabled'); expect(f.lease).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
  });
  it('never fabricates a native run for an ordinary app or missing upstream receipt', async () => {
    f.local = false; expect(await viewManagedNative(principal(), 'conversation')).toEqual({ available: false });
    f.local = true; f.row = false; expect(await viewManagedNative(principal(), 'conversation')).toEqual({ available: true, view: null }); await expect(mutateManagedNative(principal(), 'conversation', answer)).rejects.toThrow('already ended'); expect(f.control).not.toHaveBeenCalled();
  });
});
