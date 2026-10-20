import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/crypto';
import { NativeConnectionChanged, NativeRpcError } from '@/lib/remote-hermes/socket';

const f = vi.hoisted(() => ({ enabled: true, epoch: 1, locks: 0, runAt: 0, beforeSend: false, profiles: vi.fn(), refresh: vi.fn(), rpc: vi.fn(), row: {} as Record<string, unknown>, cached: {} as { row: Record<string, unknown>; view: Record<string, unknown>; pending: Map<string, unknown>; socketEpoch: number }, receipt: null as null | { digest: string } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/policy', () => ({ assertRemoteHermesAdmission: (setting: { enabled: boolean }) => { if (!setting.enabled) throw new Error('disabled'); } }));
vi.mock('@/lib/remote-hermes/sessions', () => ({ ownedNativeSession: async (owner: string, connection: string, session: string) => { if (owner !== 'owner' || connection !== 'connection' || session !== 'session') throw new Error('not found'); return f.row; } }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => ({ client: { profiles: f.profiles } }) }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ lockBoundary: async (tx: unknown) => { void tx; }, socket: {
  get connectionEpoch() { return f.epoch; }, state: 'connected',
  callConnected: async (method: string, params: unknown) => { if (f.beforeSend) throw new NativeConnectionChanged(); return f.rpc(method, params); },
  dispatchConnected: async (method: string, params: unknown, epoch: number) => { if (f.beforeSend || epoch !== f.epoch) throw new NativeConnectionChanged(); return { reply: f.rpc(method, params) }; },
}, refresh: f.refresh, sessions: new Map([['session', f.cached]]) }) }));
vi.mock('@/lib/ids', () => ({ newId: () => 'receipt-id' }));
vi.mock('@/db', () => {
  const update = (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => { f.row = { ...f.row, ...values, revision: Number(f.row.revision) + 1 }; return [f.row]; } }) });
  return { db: { update: () => ({ set: update }), transaction: async (run: (tx: unknown) => unknown) => run({
    select: () => ({ from: (table: { [key: symbol]: unknown }) => {
      const name = table[Symbol.for('drizzle:Name')];
      return { where: () => {
        const rows = () => name === 'remote_hermes_turns' ? f.receipt ? [f.receipt] : [] : [f.row];
        return Object.assign(Promise.resolve().then(rows), { for: async () => { if (name !== 'remote_hermes_turns') { ++f.locks; if (f.locks === f.runAt) f.cached.view.running = true; } return rows(); } });
      } };
    } }), insert: () => ({ values: async (value: { digest: string }) => { f.receipt = { digest: value.digest }; } }), update: () => ({ set: update }),
  }) } };
});
import { nativeSessionModel, modelInput } from '@/lib/remote-hermes/model';

const choices = { providers: [{ slug: 'openai', name: 'OpenAI', authenticated: true, models: ['gpt-test'] }, { slug: 'unconfigured', authenticated: false, models: ['hidden'] }] };
const binding = JSON.stringify(['remote-hermes-session-model:v1', 'owner', 'connection', 'session']);
type PreparedModelChange = { confirmation: string; expiresAt: number; model: string; provider: string; profile: string; title: string; currentModel: string; currentProvider: string };
const prepare = async (): Promise<PreparedModelChange> => {
  const result = await nativeSessionModel('owner', 'connection', 'session', { operation: 'prepare', model: 'gpt-test', provider: 'openai' });
  if (!('confirmation' in result) || typeof result.confirmation !== 'string') throw new Error('Expected a model confirmation.');
  return result;
};

describe('confirmed native session model selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.clearAllMocks(); f.enabled = true; f.epoch = 1; f.locks = f.runAt = 0; f.beforeSend = false; f.receipt = null;
    f.row = { id: 'session', connectionId: 'connection', profile: 'default', storedId: 'stored', runtimeId: 'runtime', status: 'idle', revision: 1, queueRequestId: null };
    f.cached = { row: f.row, view: { title: 'Fixture chat', profile: 'default', nativeProfile: 'default', runtimeVersion: '0.21.5', desktopContract: 8, model: 'old-model', provider: 'old-provider', running: false, uncertain: false, queuePending: false, queued: '', prompts: [] }, pending: new Map(), socketEpoch: 1 };
    f.profiles.mockResolvedValue([{ name: 'default' }]); f.refresh.mockImplementation(async () => f.cached.view);
    f.rpc.mockImplementation(async (method: string) => {
      if (method === 'model.options') return { ...choices, model: f.cached.view.model, provider: f.cached.view.provider };
      if (method === 'config.set') { f.cached.view.model = 'gpt-test'; f.cached.view.provider = 'openai'; return { key: 'model', value: 'gpt-test', scope: 'session', confirm_required: false }; }
      throw new Error(`Unexpected RPC ${method}`);
    });
  });
  it('reads only authenticated model options and confirms an explicit session setter with canonical readback', async () => {
    expect(await nativeSessionModel('owner', 'connection', 'session', { operation: 'options' })).toMatchObject({ model: 'old-model', provider: 'old-provider' });
    const p = await prepare(); expect(p).toMatchObject({ model: 'gpt-test', provider: 'openai', currentModel: 'old-model' });
    expect(f.rpc).toHaveBeenCalledWith('model.options', { profile: 'default', session_id: 'runtime', explicit_only: true, include_unconfigured: false, refresh: false });
    const result = await nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: p.confirmation });
    expect(result).toMatchObject({ accepted: true, model: 'gpt-test', provider: 'openai' });
    expect(f.rpc).toHaveBeenCalledWith('config.set', { profile: 'default', session_id: 'runtime', scope: 'session', key: 'model', value: 'gpt-test --session --provider openai', confirm_expensive_model: false });
    expect(f.row.status).toBe('idle');
    expect(await nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: p.confirmation })).toMatchObject({ duplicate: true });
    expect(f.rpc.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(1);
  });
  it('rejects free-form IDs, missing inventory entries, cross-owner calls and extra flags before dispatch', async () => {
    await expect(nativeSessionModel('intruder', 'connection', 'session', { operation: 'options' })).rejects.toThrow('not found');
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'prepare', model: 'gpt-test --global', provider: 'openai' })).rejects.toThrow();
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'prepare', model: 'unlisted', provider: 'openai' })).rejects.toThrow('authenticated Hermes inventory');
    for (const input of [{ operation: 'prepare', model: 'gpt-test', provider: 'openai', scope: 'global' }, { operation: 'confirm', confirmation: 'x', model: 'other' }]) expect(modelInput.safeParse(input).success).toBe(false);
    expect(f.rpc).not.toHaveBeenCalledWith('config.set', expect.anything());
  });
  it('preserves Hermes model warnings and requires a second one-shot confirmation before bypassing them', async () => {
    const warning = 'Large cached context will be sent to an expensive model.\nThis may incur higher costs.';
    f.rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'model.options') return { ...choices, model: f.cached.view.model, provider: f.cached.view.provider };
      if (method === 'config.set' && params.confirm_expensive_model === false)
        return { key: 'model', value: 'gpt-test', scope: 'session', confirm_required: true, confirm_message: warning };
      if (method === 'config.set' && params.confirm_expensive_model === true) {
        f.cached.view.model = 'gpt-test'; f.cached.view.provider = 'openai';
        return { key: 'model', value: 'gpt-test', scope: 'session', confirm_required: false };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const prepared = await prepare();
    const firstClaim = JSON.parse((await import('@/lib/crypto')).decrypt(prepared.confirmation, binding));
    const warningResult = await nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: prepared.confirmation });
    expect(warningResult).toMatchObject({ confirmRequired: true, warning, currentModel: 'old-model', currentProvider: 'old-provider' });
    if (!('confirmation' in warningResult) || typeof warningResult.confirmation !== 'string') throw new Error('Expected a second confirmation token.');
    expect(f.row.status).toBe('idle');
    const warningClaim = JSON.parse((await import('@/lib/crypto')).decrypt(warningResult.confirmation, binding));
    expect(warningClaim.requestId).not.toBe(firstClaim.requestId);
    expect(warningClaim.confirmExpensiveModel).toBe(true);
    expect(f.rpc.mock.calls.filter(([method]) => method === 'config.set').map(([, params]) => (params as Record<string, unknown>).confirm_expensive_model)).toEqual([false]);

    // The fixture has a single-receipt slot; the follow-up has a distinct requestId and gets a distinct DB row.
    f.receipt = null;
    const applied = await nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: warningResult.confirmation });
    expect(applied).toMatchObject({ accepted: true, model: 'gpt-test', provider: 'openai' });
    expect(f.rpc.mock.calls.filter(([method]) => method === 'config.set').map(([, params]) => (params as Record<string, unknown>).confirm_expensive_model)).toEqual([false, true]);
    expect(f.row.status).toBe('idle');
  });
  it('does not issue a second confirmation for a Hermes warning that cannot be shown in full', async () => {
    f.rpc.mockImplementation(async (method: string) => {
      if (method === 'model.options') return { ...choices, model: f.cached.view.model, provider: f.cached.view.provider };
      if (method === 'config.set') return { key: 'model', value: 'gpt-test', scope: 'session', confirm_required: true, confirm_message: 'w'.repeat(4_001) };
      throw new Error(`Unexpected RPC ${method}`);
    });
    const prepared = await prepare();
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: prepared.confirmation })).rejects.toThrow('too long to display safely');
    expect(f.row.status).toBe('idle');
    expect(f.rpc.mock.calls.filter(([method]) => method === 'config.set').map(([, params]) => (params as Record<string, unknown>).confirm_expensive_model)).toEqual([false]);
  });
  it.each(['0.21.6', 'profile', 'running', 'pending', 'queued', 'queue-request', 'uncertain', 'prompt', 'busy-status'])('withholds setter for unverified or non-idle session state: %s', async state => {
    if (state === 'profile') f.cached.view.nativeProfile = 'other';
    else if (state === 'running') f.cached.view.running = true;
    else if (state === 'pending') f.cached.pending.set('p', {});
    else if (state === 'queued') f.cached.view.queued = 'work';
    else if (state === 'queue-request') f.row.queueRequestId = 'queued-request';
    else if (state === 'uncertain') f.cached.view.uncertain = true;
    else if (state === 'prompt') f.cached.view.prompts = [{ id: 'approval' }];
    else if (state === 'busy-status') f.row.status = 'running';
    else f.cached.view.runtimeVersion = state;
    await expect(prepare()).rejects.toThrow(['running', 'pending', 'queued', 'queue-request', 'uncertain', 'prompt', 'busy-status'].includes(state) ? 'Finish pending' : 'verified Hermes');
    expect(f.rpc).not.toHaveBeenCalledWith('config.set', expect.anything());
  });
  it('binds confirmation to target identity and keeps ambiguous setter/readback outcomes from replaying', async () => {
    const p = await prepare();
    const claim = JSON.parse((await import('@/lib/crypto')).decrypt(p.confirmation, binding));
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: encrypt(JSON.stringify({ ...claim, runtimeId: 'other' }), binding) })).rejects.toThrow('changed after you reviewed');
    const next = await prepare(); f.rpc.mockImplementation(async method => { if (method === 'model.options') return choices; throw new Error('lost reply'); });
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: next.confirmation })).rejects.toThrow('lost reply');
    expect(f.row.status).toBe('uncertain');
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: next.confirmation })).resolves.toMatchObject({ duplicate: true });
  });
  it('keeps a successful setter with mismatched authoritative readback uncertain', async () => {
    const p = await prepare();
    f.rpc.mockImplementation(async (method: string) => {
      if (method === 'config.set') return { key: 'model', value: 'gpt-test', scope: 'session' };
      if (method === 'model.options') return { ...choices, model: 'old-model', provider: 'old-provider' };
      throw new Error('Unexpected RPC');
    });
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: p.confirmation })).rejects.toThrow('did not report the selected model/provider');
    expect(f.row.status).toBe('uncertain');
    expect(f.rpc.mock.calls.filter(([method]) => method === 'config.set')).toHaveLength(1);
  });
  it('does not send when the socket changes before dispatch and releases only definitive method rejection', async () => {
    const p = await prepare(); f.beforeSend = true;
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: p.confirmation })).rejects.toThrow(NativeConnectionChanged);
    expect(f.row.status).toBe('idle'); expect(f.rpc).not.toHaveBeenCalledWith('config.set', expect.anything());
    f.beforeSend = false; const q = await prepare(); f.rpc.mockImplementation(async method => { if (method === 'model.options') return choices; throw new NativeRpcError(-32601); });
    await expect(nativeSessionModel('owner', 'connection', 'session', { operation: 'confirm', confirmation: q.confirmation })).rejects.toThrow();
    expect(f.row.status).toBe('idle');
  });
});
