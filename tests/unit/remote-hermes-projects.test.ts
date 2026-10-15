import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeConnectionChanged } from '@/lib/remote-hermes/socket';

const f = vi.hoisted(() => ({ enabled: true, profiles: vi.fn(), list: [] as Record<string, unknown>[], rawProjects: [] as Record<string, unknown>[], schedules: [] as Record<string, unknown>[], plugins: [] as Record<string, unknown>[], pluginReads: 0, pluginReadFlipAt: 0, activeId: '', calls: vi.fn(), beforeSend: false, unscoped: false, concurrentReceipt: null as null | { requestId: string; digest: string; project: Record<string, unknown> }, locks: 0, runAt: 0,
  row: {} as Record<string, unknown>, receipt: null as null | { requestId: string; digest: string }, cached: {} as { row: Record<string, unknown>; view: Record<string, unknown>; pending: Map<string, unknown>; socketEpoch: number } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled }) }));
vi.mock('@/lib/remote-hermes/policy', () => ({ assertRemoteHermesAdmission: (value: { enabled: boolean }) => { if (!value.enabled) throw new Error('Personal remote Hermes is disabled'); } }));
vi.mock('@/lib/remote-hermes/sessions', async () => ({
  ownedNativeSession: async (owner: string, connection: string, session: string) => { if (owner !== 'owner' || connection !== 'connection' || session !== 'session') throw new Error('not found'); return f.row; },
  profileName: (await import('zod')).z.string().regex(/^[a-zA-Z0-9_.-]+$/),
}));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => ({ client: { profiles: f.profiles } }) }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({
  lockBoundary: async () => { ++f.locks; if (f.concurrentReceipt) { f.receipt = { requestId: f.concurrentReceipt.requestId, digest: f.concurrentReceipt.digest }; f.list.push(f.concurrentReceipt.project); f.rawProjects.push(f.concurrentReceipt.project); f.concurrentReceipt = null; } if (f.locks === f.runAt) f.cached.view.running = true; }, refresh: async () => f.cached.view, sessions: new Map([['session', f.cached]]),
  socket: { state: 'connected', get connectionEpoch() { return f.cached.socketEpoch; },
    callConnected: async (method: string, params: Record<string, unknown>) => {
      if (method === 'projects.list') return { active_id: f.activeId || null, projects: f.list };
      if (method === 'projects.get') {
        const project = f.rawProjects.find(value => value.id === params.id || value.slug === params.id);
        if (!project) { const { NativeRpcError } = await import('@/lib/remote-hermes/socket'); throw new NativeRpcError(5062); }
        return { project };
      }
      if (method === 'cron.manage') return { scoped: f.unscoped ? 'other' : 'default', jobs: f.schedules };
      expect(method).toBe('plugins.manage');
      ++f.pluginReads;
      if (f.pluginReadFlipAt === f.pluginReads) f.plugins[0].source = 'bundled';
      return { plugins: f.plugins };
    },
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
import { nativeWorkspaceOperation, workspaceOperationInput } from '@/lib/remote-hermes/operations-mutations';
import { decrypt, hmacSha256Hex } from '@/lib/crypto';

const prepareCreate = async () => nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'create', name: 'Example' });
const confirm = (confirmation: string) => nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'confirm', confirmation });

describe('confirmed native Hermes workspace operations', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.enabled = true; f.beforeSend = false; f.unscoped = false; f.concurrentReceipt = null; f.locks = f.runAt = 0; f.list = []; f.rawProjects = []; f.schedules = []; f.plugins = []; f.pluginReads = f.pluginReadFlipAt = 0; f.activeId = ''; f.receipt = null;
    f.row = { id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored', runtimeId: 'runtime', status: 'idle', revision: 1, queueRequestId: null };
    f.cached = { row: f.row, view: { title: 'Synthetic chat', profile: 'default', nativeProfile: 'default', running: false, uncertain: false, queuePending: false, queued: '', prompts: [] }, pending: new Map(), socketEpoch: 1 };
    f.profiles.mockResolvedValue([{ name: 'default' }]);
    f.calls.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'projects.create') {
        const project = { id: 'native-project-id', slug: params.slug, name: params.name, folders: [], archived: false };
        f.list.push(project); f.rawProjects.push(project); return { project };
      }
      if (method === 'projects.set_active') { f.activeId = String(params.id); return { active_id: f.activeId }; }
      if (method === 'cron.manage') {
        const schedule = f.schedules.find(value => value.id === params.name);
        if (!schedule) throw new Error('schedule not found');
        schedule.enabled = params.action === 'resume';
        schedule.state = params.action === 'resume' ? 'scheduled' : 'paused';
        return { success: true, job: { job_id: schedule.id, enabled: schedule.enabled, state: schedule.state } };
      }
      expect(method).toBe('plugins.manage');
      const plugin = f.plugins.find(value => value.key === params.key);
      if (!plugin) throw new Error('plugin not found');
      plugin.status = params.enable ? 'enabled' : 'disabled';
      return { ok: true, name: plugin.key, plugin, gateway_reloaded: params.enable, restart_required: !params.enable };
    });
  });

  it('accepts only bounded create/select requests; browser-supplied paths are rejected', () => {
    expect(workspaceOperationInput.safeParse({ operation: 'prepare', action: 'create', name: 'Example', path: '/etc' }).success).toBe(false);
    expect(workspaceOperationInput.safeParse({ operation: 'prepare', action: 'select', projectId: 'native-id', profile: 'another' }).success).toBe(false);
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

  it('reconciles project identities beyond the display cap through exact projects.get readback', async () => {
    f.list = Array.from({ length: 500 }, (_, index) => ({ id: `existing-${index}`, slug: `existing-${index}`, name: `Existing ${index}`, folders: [], archived: false }));
    f.rawProjects = [...f.list];
    const prepared = await prepareCreate();
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: true, activeId: '' });
    expect(f.list).toHaveLength(501);
    expect(f.calls).toHaveBeenCalledExactlyOnceWith('projects.create', expect.anything());
  });

  it('rejects hidden folder data during exact empty-project readback without returning its path', async () => {
    const prepared = await prepareCreate();
    f.calls.mockImplementationOnce(() => {
      const project = { id: 'native-project-id', slug: JSON.parse(decrypt(prepared.confirmation!, JSON.stringify(['remote-hermes-workspace:v1', 'owner', 'connection', 'session']))).slug, name: 'Example', folders: [], archived: false };
      f.rawProjects.push({ ...project, folders: [{ path: '/workspace/.private' }] }); f.list.push(project);
      return { project };
    });
    await expect(confirm(prepared.confirmation!)).rejects.toThrow('readback did not match');
    expect(JSON.stringify(f.list)).not.toContain('/workspace/.private');
    expect(f.row.status).toBe('uncertain');
  });

  it('does not accept a duplicate receipt when projects.get reveals a hidden folder', async () => {
    const prepared = await prepareCreate();
    const claim = JSON.parse(decrypt(prepared.confirmation!, JSON.stringify(['remote-hermes-workspace:v1', 'owner', 'connection', 'session'])));
    f.receipt = { requestId: claim.requestId, digest: hmacSha256Hex('synthetic-receipt-key', JSON.stringify(claim)) };
    f.rawProjects = [{ id: 'native-project-id', slug: claim.slug, name: claim.name, folders: [{ path: '/workspace/.private' }], archived: false }];
    f.list = [{ id: 'native-project-id', slug: claim.slug, name: claim.name, folders: [], archived: false }];
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: false, duplicate: true });
    expect(JSON.stringify(result)).not.toContain('/workspace/.private');
    expect(f.calls).not.toHaveBeenCalled();
  });

  it('does not accept a concurrent duplicate when projects.get reveals a hidden folder', async () => {
    const prepared = await prepareCreate();
    const claim = JSON.parse(decrypt(prepared.confirmation!, JSON.stringify(['remote-hermes-workspace:v1', 'owner', 'connection', 'session'])));
    f.concurrentReceipt = { requestId: claim.requestId, digest: hmacSha256Hex('synthetic-receipt-key', JSON.stringify(claim)),
      project: { id: 'native-project-id', slug: claim.slug, name: claim.name, folders: [{ path: '/workspace/.private' }], archived: false } };
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: false, duplicate: true });
    expect(JSON.stringify(result)).not.toContain('/workspace/.private');
    expect(f.calls).not.toHaveBeenCalled();
  });

  it('does not report a concurrent create complete when readback has the slug but wrong project content', async () => {
    const prepared = await prepareCreate();
    const claim = JSON.parse(decrypt(prepared.confirmation!, JSON.stringify(['remote-hermes-workspace:v1', 'owner', 'connection', 'session'])));
    f.concurrentReceipt = { requestId: claim.requestId, digest: hmacSha256Hex('synthetic-receipt-key', JSON.stringify(claim)),
      project: { id: 'wrong-project', slug: claim.slug, name: 'Wrong name', folders: [{ path: '/unexpected' }], archived: false } };
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: false, duplicate: true });
    expect(f.calls).not.toHaveBeenCalled();
  });

  it('selects only a refreshed, active, server-listed id after a separate profile-wide confirmation', async () => {
    f.list = [{ id: 'native-id', slug: 'repo', name: 'Repo', folders: [], archived: false }];
    const prepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'select', projectId: 'native-id' });
    expect(prepared).toMatchObject({ action: 'select', profile: 'default', name: 'Repo' });
    expect(f.calls).not.toHaveBeenCalled();
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: true, activeId: 'native-id' });
    expect(f.calls).toHaveBeenCalledExactlyOnceWith('projects.set_active', { profile: 'default', id: 'native-id' });
    expect(await confirm(prepared.confirmation!)).toMatchObject({ duplicate: true, accepted: true });
    f.list = [];
    expect(await confirm(prepared.confirmation!)).toMatchObject({ duplicate: true, accepted: false });
    expect(f.calls).toHaveBeenCalledOnce();
  });

  it('pauses and resumes only a profile-scoped listed schedule after separate confirmation and readback', async () => {
    f.schedules = [{ id: 'schedule-id', name: 'Nightly', enabled: true, state: 'scheduled' }];
    const prepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'pause', scheduleId: 'schedule-id' });
    expect(prepared).toMatchObject({ action: 'schedule', name: 'Nightly', profile: 'default' });
    expect(f.calls).not.toHaveBeenCalled();
    const paused = await confirm(prepared.confirmation!);
    expect(paused).toMatchObject({ accepted: true, schedules: [{ id: 'schedule-id', enabled: false }] });
    expect(f.calls).toHaveBeenCalledExactlyOnceWith('cron.manage', { profile: 'default', action: 'pause', name: 'schedule-id' });
    f.receipt = null; // The mock stores one receipt; production queries by each unique request id.
    const resumedPrepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'resume', scheduleId: 'schedule-id' });
    const resumed = await confirm(resumedPrepared.confirmation!);
    expect(resumed).toMatchObject({ accepted: true, schedules: [{ id: 'schedule-id', enabled: true }] });
    expect('output' in resumed && resumed.output).toContain('may run soon and use model usage');
    expect(f.calls).toHaveBeenCalledTimes(2);
  });

  it('refuses to resume a completed schedule without reserving a receipt or dispatching', async () => {
    f.schedules = [{ id: 'completed-id', name: 'Finished once', enabled: false, state: 'completed' }];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'resume', scheduleId: 'completed-id' })).rejects.toThrow('Only a scheduled job can be paused');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).toBeNull(); expect(f.row.status).toBe('idle');
  });

  it('fails closed for invented schedules and unscoped schedule results', async () => {
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'pause', scheduleId: 'invented' })).rejects.toThrow('Only a scheduled job can be paused');
    f.schedules = [{ id: 'schedule-id', name: 'Nightly', enabled: true, state: 'scheduled' }]; f.unscoped = true;
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'pause', scheduleId: 'schedule-id' })).rejects.toThrow('profile-scoped schedules');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });

  it('toggles only a listed non-bundled plugin with profile scope, confirmation, and fresh readback', async () => {
    f.plugins = [{ key: 'category:helper', name: 'Helper', source: 'user', status: 'not enabled' }];
    const prepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'category:helper' });
    expect(prepared).toMatchObject({ action: 'plugin', name: 'Helper', profile: 'default', enabled: true });
    expect(f.calls).not.toHaveBeenCalled();
    const result = await confirm(prepared.confirmation!);
    expect(result).toMatchObject({ accepted: true, plugins: [{ key: 'category:helper', status: 'enabled' }] });
    expect('output' in result && result.output).toContain('Hermes confirms the running gateway reloaded');
    expect(f.calls).toHaveBeenCalledExactlyOnceWith('plugins.manage', { profile: 'default', action: 'toggle', key: 'category:helper', enable: true });
    expect(await confirm(prepared.confirmation!)).toMatchObject({ duplicate: true, accepted: true });
    expect(f.calls).toHaveBeenCalledOnce();
    f.receipt = null;
    const disabling = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'disable-plugin', pluginKey: 'category:helper' });
    const disabled = await confirm(disabling.confirmation!);
    expect(disabled).toMatchObject({ accepted: true, plugins: [{ key: 'category:helper', status: 'disabled' }] });
    expect('output' in disabled && disabled.output).toContain('may keep its handlers until restarted');
    expect(f.calls).toHaveBeenCalledTimes(2);
  });

  it('requires an exact unique canonical plugin key and rejects identity changes before dispatch', async () => {
    f.plugins = [{ key: 'category:helper', name: 'Helper', source: 'user', status: 'not enabled' }];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'Helper' }))
      .rejects.toThrow('unambiguous user-installed');
    f.plugins.push({ ...f.plugins[0] });
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'category:helper' }))
      .rejects.toThrow('unambiguous user-installed');
    f.plugins = [{ key: 'category:helper', name: 'Helper', source: 'user', status: 'not enabled' }];
    const prepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'category:helper' });
    f.plugins[0].source = 'bundled';
    await expect(confirm(prepared.confirmation!)).rejects.toThrow('plugin changed after confirmation');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });

  it('refuses a canonical key that aliases an earlier bundled manifest name before any toggle RPC', async () => {
    // The pinned resolver scans discovery order and accepts either manifest name
    // or canonical key. Passing "probe" would therefore resolve the bundled row
    // before the user-installed plugin whose canonical key is "probe".
    f.plugins = [
      { key: 'tools/probe', name: 'probe', source: 'bundled', status: 'enabled' },
      { key: 'probe', name: 'probe', source: 'user', status: 'disabled' },
    ];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', {
      operation: 'prepare', action: 'enable-plugin', pluginKey: 'probe',
    })).rejects.toThrow('supported, unambiguous user-installed');
    expect(f.calls.mock.calls.some(([method, params]) => method === 'plugins.manage' && (params as Record<string, unknown>)?.action === 'toggle')).toBe(false);
    expect(f.receipt).toBeNull();
  });

  it.each(['probe ', '\u001cprobe', '\u0085probe'])('rejects canonical key %j when Python strip aliases it to a bundled manifest name', async pluginKey => {
    f.plugins = [
      { key: 'tools/probe', name: 'probe', source: 'bundled', status: 'enabled' },
      { key: pluginKey, name: pluginKey, source: 'user', status: 'disabled' },
    ];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', {
      operation: 'prepare', action: 'enable-plugin', pluginKey,
    })).rejects.toThrow('supported, unambiguous user-installed');
    expect(f.calls.mock.calls.some(([method, params]) => method === 'plugins.manage' && (params as Record<string, unknown>)?.action === 'toggle')).toBe(false);
    expect(f.receipt).toBeNull();
  });

  it('does not accept duplicate reconciliation after a plugin name collision appears', async () => {
    f.plugins = [{ key: 'probe', name: 'probe', source: 'user', status: 'disabled' }];
    const prepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'probe' });
    const applied = await confirm(prepared.confirmation!);
    expect(applied.accepted).toBe(true);
    f.plugins.unshift({ key: 'tools/probe', name: 'probe', source: 'bundled', status: 'enabled' });
    const duplicate = await confirm(prepared.confirmation!);
    expect(duplicate).toMatchObject({ accepted: false, duplicate: true });
    expect(f.calls.mock.calls.filter(([method, params]) => method === 'plugins.manage' && (params as Record<string, unknown>)?.action === 'toggle')).toHaveLength(1);
  });

  it('refuses plugin mutations when the native inventory exceeds the complete verification bound', async () => {
    f.plugins = Array.from({ length: 501 }, (_, index) => ({ key: `category:${index}`, name: `Plugin ${index}`, source: 'user', status: 'disabled' }));
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'category:500' }))
      .rejects.toThrow('incomplete plugin inventory');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });

  it('leaves the receipt uncertain if plugin provenance changes during native readback', async () => {
    f.plugins = [{ key: 'category:helper', name: 'Helper', source: 'user', status: 'not enabled' }];
    const prepared = await nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'category:helper' });
    f.pluginReadFlipAt = 3; // prepare list, confirm preflight, then post-dispatch readback
    await expect(confirm(prepared.confirmation!)).rejects.toThrow('plugin readback did not match');
    expect(f.calls).toHaveBeenCalledOnce(); expect(f.row.status).toBe('uncertain');
  });

  it('rejects invented, bundled, and indeterminate plugin states', async () => {
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'invented' })).rejects.toThrow('supported, unambiguous user-installed');
    f.plugins = [{ key: 'core:helper', name: 'Helper', source: 'bundled', status: 'disabled' }];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'enable-plugin', pluginKey: 'core:helper' })).rejects.toThrow('supported, unambiguous user-installed');
    f.plugins = [{ key: 'user:helper', name: 'Helper', source: 'user', status: 'unknown' }];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'disable-plugin', pluginKey: 'user:helper' })).rejects.toThrow('supported, unambiguous user-installed');
    expect(f.calls).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });

  it('refuses archived or invented ids, foreign owners, and a mismatched authenticated profile', async () => {
    f.list = [{ id: 'archived', slug: 'old', name: 'Old', folders: [], archived: true }];
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'select', projectId: 'archived' })).rejects.toThrow('active project');
    await expect(nativeWorkspaceOperation('owner', 'connection', 'session', { operation: 'prepare', action: 'select', projectId: 'invented' })).rejects.toThrow('active project');
    await expect(nativeWorkspaceOperation('intruder', 'connection', 'session', { operation: 'prepare', action: 'create', name: 'X' })).rejects.toThrow('not found');
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
