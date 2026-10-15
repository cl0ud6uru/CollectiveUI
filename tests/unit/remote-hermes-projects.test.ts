import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeConnectionChanged, NativeRpcError } from '@/lib/remote-hermes/socket';

const f = vi.hoisted(() => ({ enabled: true, profiles: vi.fn(), list: [] as Record<string, unknown>[], activeId: '', calls: vi.fn(), beforeSend: false, locks: 0, runAt: 0,
  row: {} as Record<string, unknown>, receipt: null as null | { requestId: string; digest: string }, cached: {} as { row: Record<string, unknown>; view: Record<string, unknown>; pending: Map<string, unknown>; socketEpoch: number } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled }) }));
vi.mock('@/lib/remote-hermes/policy', () => ({ assertRemoteHermesAdmission: (value: { enabled: boolean }) => { if (!value.enabled) throw new Error('Personal remote Hermes is disabled'); } }));
vi.mock('@/lib/remote-hermes/sessions', async () => ({
  ownedNativeSession: async (owner: string, connection: string, session: string) => { if (owner !== 'owner' || connection !== 'connection' || session !== 'session') throw new Error('not found'); return f.row; },
  profileName: (await import('zod')).z.string().regex(/^[a-zA-Z0-9_.-]+$/),
}));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => ({ client: { profiles: f.profiles } }) }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({
  lockBoundary: async () => { ++f.locks; if (f.locks === f.runAt) f.cached.view.running = true; }, refresh: async () => f.cached.view, sessions: new Map([['session', f.cached]]),
  socket: { state: 'connected', get connectionEpoch() { return f.cached.socketEpoch; },
    callConnected: async (method: string) => { expect(method).toBe('projects.list'); return { active_id: f.activeId || null, projects: f.list }; },
    dispatchConnected: async (method: string, params: Record<string, unknown>, epoch: number) => {
      if (f.beforeSend || epoch !== f.cached.socketEpoch) throw new NativeConnectionChanged();
      return { reply: f.calls(method, params) };
    },
  },
}) }));
vi.mock('@/lib/remote-hermes/socket', async () => {
  const original = await vi.importActual<typeof import('@/lib/remote-hermes/socket')>('@/lib/remote-hermes/socket');
  return { ...original };
});
vi.mock('@/lib/crypto', async () => {
  const original = await vi.importActual<typeof import('@/lib/crypto')>('@/lib/crypto');
  return { ...original, toolApprovalSecret: () => 'synthetic-receipt-key' };
});
vi.mock('@/lib/ids', () => ({ newId: () => 'synthetic-receipt' }));
vi.mock('@/db', async () => {
  const schema = await import('@/db/schema');
  const tableName = (table: { [key: symbol]: unknown }) => table[Symbol.for('drizzle:Name')];
  const getRows = (table: { [key: symbol]: unknown }) => tableName(table) === 'remote_hermes_turns' ? f.receipt ? [{ ...f.receipt }] : [] : [f.row];
  const query = (table: { [key: symbol]: unknown }) => {
    const promise = Promise.resolve(getRows(table));
    return Object.assign(promise, { for: async () => getRows(table) });
  };
  const update = (table: { [key: symbol]: unknown }, values: Record<string, unknown>) => ({ where: () => ({ returning: async () => {
    if (tableName(table) === 'remote_hermes_sessions') f.row = { ...f.row, ...values, revision: Number(f.row.revision) + 1 };
    return [f.row];
  } }) });
  const tx = {
    select: () => ({ from: (table: { [key: symbol]: unknown }) => ({ where: () => query(table) }) }),
    insert: () => ({ values: async (value: { requestId: string; digest: string }) => { f.receipt = value; } }),
    update: (table: { [key: symbol]: unknown }) => ({ set: (values: Record<string, unknown>) => update(table, values) }),
  };
  void schema;
  return { db: { ...tx, transaction: async (run: (value: typeof tx) => unknown) => run(tx) } };
});
import { nativeProjectOperation, projectOperationInput } from '@/lib/remote-hermes/projects';

const prepareCreate = async () => nativeProjectOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'create', name: 'Example' });
const confirm = (confirmation: string) => nativeProjectOperation('owner', 'connection', 'session', { operation: 'confirm', confirmation });

describe('confirmed native Hermes project operations', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.enabled = true; f.beforeSend = false; f.locks = f.runAt = 0; f.list = []; f.activeId = ''; f.receipt = null;
    f.row = { id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored', runtimeId: 'runtime', status: 'idle', revision: 1, queueRequestId: null };
    f.cached = { row: f.row, view: { title: 'Synthetic chat', profile: 'default', nativeProfile: 'default', running: false, uncertain: false, queuePending: false, queued: '', prompts: [] }, pending: new Map(), socketEpoch: 1 };
    f.profiles.mockResolvedValue([{ name: 'default' }]);
    f.calls.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'projects.create') {
        const project = { id: 'native-project-id', slug: params.slug, name: params.name, folders: [], archived: false };
        f.list.push(project); return { project };
      }
      expect(method).toBe('projects.set_active'); f.activeId = String(params.id); return { active_id: f.activeId };
    });
  });

  it('accepts only bounded create/select requests; browser-supplied paths are rejected', () => {
    expect(projectOperationInput.safeParse({ operation: 'prepare', action: 'create', name: 'Example', path: '/etc' }).success).toBe(false);
    expect(projectOperationInput.safeParse({ operation: 'prepare', action: 'select', projectId: 'native-id', profile: 'another' }).success).toBe(false);
  });

  it('creates a confirmed empty inactive project with generated identity and authoritative readback', async () => {
    const prepared = await prepareCreate();
    expect(prepared).toMatchObject({ action: 'create', name: 'Example', profile: 'default' });
    expect(f.calls).not.toHaveBeenCalled();
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: true, activeId: '', projects: [{ id: 'native-project-id', name: 'Example', folders: [] }] });
    expect(f.calls).toHaveBeenCalledExactlyOnceWith('projects.create', expect.objectContaining({ profile: 'default', name: 'Example', folders: [], use: false, slug: expect.stringMatching(/^cu-[0-9a-f]{32}$/) }));
    expect(f.row.status).toBe('idle');
  });

  it('selects only a refreshed, active, server-listed id after a separate profile-wide confirmation', async () => {
    f.list = [{ id: 'native-id', slug: 'repo', name: 'Repo', folders: [], archived: false }];
    const prepared = await nativeProjectOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'select', projectId: 'native-id' });
    expect(prepared).toMatchObject({ action: 'select', profile: 'default', name: 'Repo' });
    expect(f.calls).not.toHaveBeenCalled();
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: true, activeId: 'native-id' });
    expect(f.calls).toHaveBeenCalledExactlyOnceWith('projects.set_active', { profile: 'default', id: 'native-id' });
    expect(await confirm(prepared.confirmation!)).toMatchObject({ duplicate: true, accepted: true });
    expect(f.calls).toHaveBeenCalledOnce();
  });

  it('refuses archived or invented ids, foreign owners, and a mismatched authenticated profile', async () => {
    f.list = [{ id: 'archived', slug: 'old', name: 'Old', folders: [], archived: true }];
    await expect(nativeProjectOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'select', projectId: 'archived' })).rejects.toThrow('active project');
    await expect(nativeProjectOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'select', projectId: 'invented' })).rejects.toThrow('active project');
    await expect(nativeProjectOperation('intruder', 'connection', 'session', { operation: 'prepare', action: 'create', name: 'X' })).rejects.toThrow('not found');
    f.profiles.mockResolvedValueOnce([{ name: 'other' }]);
    await expect(prepareCreate()).rejects.toThrow('profile not found');
    expect(f.calls).not.toHaveBeenCalled();
  });

  it.each(['running', 'uncertain', 'queuePending', 'queued', 'prompts', 'pending', 'status', 'queueRequestId'] as const)('blocks preparation when the native chat is %s', async state => {
    if (state === 'status') f.row.status = 'waiting';
    else if (state === 'queueRequestId') f.row.queueRequestId = 'queued';
    else if (state === 'pending') f.cached.pending.set('prompt', {});
    else if (state === 'prompts') f.cached.view.prompts = [{}];
    else f.cached.view[state] = state === 'queued' ? 'next' : true;
    await expect(prepareCreate()).rejects.toThrow('Finish the native turn');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });

  it('writes a receipt before send, refuses a final race, and leaves an ambiguous result uncertain without replay', async () => {
    const prepared = await prepareCreate();
    f.runAt = 2;
    await expect(confirm(prepared.confirmation!)).rejects.toThrow('no longer ready');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).not.toBeNull(); expect(f.row.status).toBe('idle');
    f.cached.view.running = false; f.receipt = null; f.row.status = 'idle'; f.row.admissionRequestId = null;
    const next = await prepareCreate();
    f.calls.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(confirm(next.confirmation!)).rejects.toThrow();
    expect(f.row.status).toBe('uncertain');
    await expect(confirm(next.confirmation!)).resolves.toMatchObject({ duplicate: true, accepted: false });
    expect(f.calls).toHaveBeenCalledOnce();
  });

  it('rejects a changed native socket before dispatch', async () => {
    const prepared = await prepareCreate(); f.beforeSend = true;
    await expect(confirm(prepared.confirmation!)).rejects.toThrow('verified Hermes connection changed');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.row.status).toBe('idle');
  });
});
