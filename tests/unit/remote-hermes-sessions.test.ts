import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const f = vi.hoisted(() => ({ enabled: true, owner: 'owner', status: 'idle', receipt: null as null | { digest: string }, updates: [] as Record<string, unknown>[], call: vi.fn(), answer: vi.fn(), refresh: vi.fn(), admissions: 0, disableAtLock: false }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: vi.fn() }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ socket: { call: f.call }, refresh: f.refresh, view: f.refresh, answer: f.answer, sessions: new Map([['session', { row: { id: 'session', status: f.status, runtimeId: 'runtime' }, view: { running: f.status === 'running', uncertain: false }, pending: new Map() }]]) }) }));
vi.mock('@/db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }), innerJoin: () => ({ where: (condition: unknown) => {
    const { params } = new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
    return Promise.resolve(params.includes(f.owner) ? [{ session: { id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored', runtimeId: 'runtime', status: f.status } }] : []);
  } }) }) }),
  update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => Object.assign(Promise.resolve().then(() => { f.updates.push(values); }), { returning: async () => { f.updates.push(values); f.status = String(values.status ?? f.status); return [{ id: 'session', status: f.status, runtimeId: 'runtime' }]; } }) }) }),
  transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
    select: () => ({ from: (table: { [key: symbol]: unknown }) => {
      const tableName = table[Symbol.for('drizzle:Name')];
      const rows = tableName === 'settings' ? [] : tableName === 'remote_hermes_turns' ? f.receipt ? [f.receipt] : [] : [{ id: 'session', status: f.status }];
      return { where: () => Object.assign(Promise.resolve(rows), { for: async () => { if (tableName === 'settings' && f.disableAtLock) f.enabled = false; return rows; } }) };
    } }),
    insert: () => ({ values: async (value: Record<string, unknown>) => { f.admissions++; f.receipt = { digest: String(value.digest) }; } }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => { const result = Promise.resolve().then(() => { f.status = String(values.status ?? f.status); return [{ id: 'session', status: f.status, runtimeId: 'runtime', ...values }]; }); return Object.assign(result, { returning: () => result }); } }) }),
  }),
} }));
import { remoteAccess } from '@/lib/remote-hermes/store';
import { browseNativeSessions, nativeHistory, nativeControl, nativeSnapshot, openNativeSession, submitNativePrompt } from '@/lib/remote-hermes/sessions';
import { NativeRpcError } from '@/lib/remote-hermes/socket';
import contract from '../fixtures/remote-hermes-command-contract.json';
const receipt = '9fd64d53-084f-4898-96e0-59ea8fdc623f';
describe('remote native session admission and continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.enabled = true; f.owner = 'owner'; f.status = 'idle'; f.receipt = null; f.updates = []; f.admissions = 0; f.disableAtLock = false;
    f.refresh.mockResolvedValue({ running: false }); f.call.mockResolvedValue({ status: 'streaming' }); f.answer.mockResolvedValue({ answered: true });
  });
  it('preserves native page metadata and opens a listed pin using its recorded offset', async () => {
    const page = { sessions: Array.from({ length: 100 }, (_, i) => ({ id: `chat-${100 + i}` })).concat({ id: 'older-pin' }), nextOffset: 200, hasMore: true };
    const sessionPage = vi.fn().mockResolvedValue(page), sessions = vi.fn().mockResolvedValue(page.sessions);
    vi.mocked(remoteAccess).mockResolvedValue({ client: { profiles: async () => [{ name: 'default' }], sessionPage, sessions } } as unknown as Awaited<ReturnType<typeof remoteAccess>>);
    expect(await browseNativeSessions('owner', 'connection', 'default', 100)).toEqual({ ...page, linked: [] });
    expect(sessionPage).toHaveBeenCalledWith('default', 100);
    await openNativeSession('owner', 'connection', 'default', 'older-pin', 100);
    expect(sessions).toHaveBeenCalledWith('default', 100);
    await expect(openNativeSession('owner', 'connection', 'default', 'invented', 100)).rejects.toThrow('listed');
    await expect(browseNativeSessions('owner', 'connection', 'not-owned', 100)).rejects.toThrow('not found');
    expect(sessionPage).toHaveBeenCalledOnce();
  });
  it('authorizes history before contacting Hermes and permits only active continuation after disablement', async () => {
    const history = vi.fn().mockResolvedValue({ messages: [], nextOffset: 200, hasMore: false });
    vi.mocked(remoteAccess).mockResolvedValue({ client: { history } } as unknown as Awaited<ReturnType<typeof remoteAccess>>);
    await expect(nativeHistory('intruder', 'connection', 'session', 0)).rejects.toThrow('not found');
    expect(remoteAccess).not.toHaveBeenCalled();
    f.enabled = false;
    await expect(nativeHistory('owner', 'connection', 'session', 0)).rejects.toThrow('disabled');
    expect(remoteAccess).not.toHaveBeenCalled();
    f.status = 'running';
    await nativeHistory('owner', 'connection', 'session', 200);
    expect(history).toHaveBeenCalledWith('default', 'stored', 200);
  });
  it('rejects another owner before connecting or answering a native request', async () => {
    await expect(nativeControl('intruder', 'connection', 'session', 'answer', { requestId: 'ask', answer: { value: 'secret' } })).rejects.toThrow('not found');
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.answer).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
  });
  it('blocks new messages when remote access is disabled but permits stopping and answering admitted work', async () => {
    f.enabled = false; f.status = 'running';
    await expect(submitNativePrompt('owner', 'connection', 'session', receipt, 'New work')).rejects.toThrow('disabled');
    await nativeControl('owner', 'connection', 'session', 'stop');
    await nativeControl('owner', 'connection', 'session', 'answer', { requestId: 'ask', answer: { choice: 'deny' } });
    expect(f.call).toHaveBeenCalledWith('session.interrupt', { session_id: 'runtime', profile: 'default' }); expect(f.answer).toHaveBeenCalledOnce();
  });
  it('does not cold-resume an idle chat after access is disabled', async () => {
    f.enabled = false;
    const view = await nativeSnapshot('owner', 'connection', 'session'); expect(view.admissionAllowed).toBe(false); expect(f.refresh).not.toHaveBeenCalled();
    await expect(nativeControl('owner', 'connection', 'session', 'stop')).rejects.toThrow('already finished');
  });
  it('rechecks disablement under the admission lock before any prompt or attachment RPC', async () => {
    f.disableAtLock = true;
    await expect(submitNativePrompt('owner', 'connection', 'session', receipt, 'New work')).rejects.toThrow('disabled');
    expect(f.call).not.toHaveBeenCalled(); expect(f.admissions).toBe(0);
  });
  it('retains a write-ahead receipt after a lost acknowledgement, so retry cannot repeat the prompt', async () => {
    f.call.mockRejectedValueOnce(new Error('Synthetic disconnect after admission'));
    await expect(submitNativePrompt('owner', 'connection', 'session', receipt, 'Only once')).rejects.toThrow('disconnect');
    expect(f.admissions).toBe(1); expect(f.updates).toContainEqual(expect.objectContaining({ status: 'uncertain' }));
    expect(await submitNativePrompt('owner', 'connection', 'session', receipt, 'Only once')).toEqual({ accepted: true, duplicate: true });
    expect(f.call).toHaveBeenCalledOnce();
    await expect(submitNativePrompt('owner', 'connection', 'session', receipt, 'Different message')).rejects.toThrow('different content');
  });
  function commandRuntime(result: Record<string, unknown> = { output: 'Native help', warning: 'Review warning' }) {
    f.call.mockImplementation(async (method: string) => method === 'commands.catalog'
      ? { ...contract.catalog, pairs: [...contract.catalog.pairs, ['/fixture-skill', 'Synthetic skill']], skills: { '/fixture-skill': { usage: 0, origin: 'local' } } }
      : result);
  }
  it('authorizes command discovery and execution before making any RPC', async () => {
    commandRuntime();
    await expect(nativeControl('intruder', 'connection', 'session', 'catalog')).rejects.toThrow('not found');
    await expect(nativeControl('intruder', 'connection', 'session', 'command', { text: '/help', requestId: receipt })).rejects.toThrow('not found');
    expect(f.call).not.toHaveBeenCalled();
  });
  it('dispatches advertised skills directly to the upstream skill protocol and returns an unsent prefill', async () => {
    commandRuntime({ type: 'skill', message: 'Human-reviewed skill task', display: 'Skill loaded', notice: 'Check draft' });
    expect(await nativeControl('owner', 'connection', 'session', 'command', { text: '/fixture-skill do work', requestId: receipt }))
      .toMatchObject({ prefill: 'Human-reviewed skill task', output: 'Skill loaded\nCheck draft' });
    expect(f.call).toHaveBeenCalledWith('command.dispatch', { session_id: 'runtime', profile: 'default', name: 'fixture-skill', arg: 'do work' }, 60000);
    expect(f.call.mock.calls.some(c => ['slash.exec', 'prompt.submit'].includes(c[0]))).toBe(false);
  });
  it('runs native commands with server-owned identities and repeats receipts without dispatching twice', async () => {
    commandRuntime();
    const input = { text: '/help', requestId: receipt };
    expect(await nativeControl('owner', 'connection', 'session', 'command', input)).toMatchObject({ output: 'Native help\nReview warning' });
    expect(await nativeControl('owner', 'connection', 'session', 'command', input)).toMatchObject({ output: expect.stringContaining('already submitted') });
    expect(f.call.mock.calls.filter(c => c[0] === 'slash.exec')).toHaveLength(1);
    expect(f.call).toHaveBeenCalledWith('slash.exec', { session_id: 'runtime', profile: 'default', command: 'help' }, 60000);
  });
  it('falls back only on method-not-found, never on ambiguous 4018 or transport errors', async () => {
    commandRuntime();
    f.call.mockImplementation(async (method: string) => {
      if (method === 'commands.catalog') return contract.catalog;
      if (method === 'slash.exec') throw new NativeRpcError(-32601);
      return { type: 'exec', output: 'Compatible fallback' };
    });
    expect(await nativeControl('owner', 'connection', 'session', 'command', { text: '/help', requestId: receipt })).toMatchObject({ output: 'Compatible fallback' });
    expect(f.call).toHaveBeenCalledWith('command.dispatch', { session_id: 'runtime', profile: 'default', name: 'help', arg: '' }, 60000);
  });
  it.each([new NativeRpcError(4018), new Error('Acknowledgement lost')])('does not retry a potentially executed command (%s)', async error => {
    commandRuntime();
    f.call.mockImplementation(async (method: string) => { if (method === 'commands.catalog') return contract.catalog; throw error; });
    const input = { text: '/compress', requestId: receipt };
    await expect(nativeControl('owner', 'connection', 'session', 'command', input)).rejects.toThrow();
    expect(f.updates).toContainEqual(expect.objectContaining({ status: 'uncertain' }));
    expect(await nativeControl('owner', 'connection', 'session', 'command', input)).toMatchObject({ output: expect.stringContaining('already submitted') });
    expect(f.call.mock.calls.filter(c => c[0] === 'slash.exec')).toHaveLength(1);
    expect(f.call.mock.calls.some(c => c[0] === 'command.dispatch')).toBe(false);
  });
  it('explains an unsupported catalog version and leaves the session unreserved', async () => {
    f.call.mockRejectedValue(new NativeRpcError(-32601));
    const catalog = await nativeControl('owner', 'connection', 'session', 'catalog');
    expect(catalog.warning).toContain('compatible command catalog');
    await expect(nativeControl('owner', 'connection', 'session', 'command', { text: '/compress', requestId: receipt })).rejects.toThrow('not advertised');
    expect(f.admissions).toBe(0);
  });
  it.each(['/yolo on', '/approvals off', '/skills approval off', '/config', '/plugins', '/unknown'])('refuses unsupported command %s before dispatch', async text => {
    commandRuntime();
    await expect(nativeControl('owner', 'connection', 'session', 'command', { text, requestId: receipt })).rejects.toThrow();
    expect(f.admissions).toBe(0); expect(f.call.mock.calls.every(c => c[0] === 'commands.catalog')).toBe(true);
  });
  it('allows typed stop while active, blocks native session mutations while active, and reads approval status without changing it', async () => {
    commandRuntime(); f.status = 'running';
    await expect(nativeControl('owner', 'connection', 'session', 'command', { text: '/compress', requestId: receipt })).rejects.toThrow('unfinished work');
    expect(f.admissions).toBe(0);
    await nativeControl('owner', 'connection', 'session', 'command', { text: '/stop', requestId: receipt });
    expect(f.call).toHaveBeenCalledWith('session.interrupt', { session_id: 'runtime', profile: 'default' });
    expect(await nativeControl('owner', 'connection', 'session', 'command', { text: '/yolo', requestId: receipt })).toMatchObject({ output: expect.stringContaining('effective approval bypass') });
    expect(f.call.mock.calls.some(c => c[0] === 'config.set')).toBe(false);
  });
  it('rechecks policy under the lock before a native command dispatch', async () => {
    commandRuntime(); f.disableAtLock = true;
    await expect(nativeControl('owner', 'connection', 'session', 'command', { text: '/help', requestId: receipt })).rejects.toThrow('disabled');
    expect(f.admissions).toBe(0); expect(f.call.mock.calls.every(c => c[0] === 'commands.catalog')).toBe(true);
  });
  it.each(['/help', '!yolo'])('never sends raw command syntax %s through prompt admission', async text => {
    await expect(submitNativePrompt('owner', 'connection', 'session', receipt, text)).rejects.toThrow();
    expect(f.call).not.toHaveBeenCalled(); expect(f.admissions).toBe(0);
  });
  it('permits explicit literal slash text through the ordinary prompt path', async () => {
    await submitNativePrompt('owner', 'connection', 'session', receipt, '//help');
    expect(f.call).toHaveBeenCalledWith('prompt.submit', { session_id: 'runtime', profile: 'default', text: '/help' });
  });
});
