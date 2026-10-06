import { beforeEach, describe, expect, it, vi } from 'vitest';
import { administrationInput, mcpInventory, probeSummary } from '@/lib/remote-hermes/administration-contract';
import { HttpError } from '@/lib/authz';

const f = vi.hoisted(() => ({ enabled: true, status: 'idle', profile: 'default', allowed: true, disableAtLock: 0, reserveQueueAtLock: 0, queueRequestId: null as string | null, uncertain: false, queuePending: false, runtimeRunning: false, missingView: false, locks: 0, receipt: null as null | { digest: string }, call: vi.fn(), refresh: vi.fn(), profiles: vi.fn() }));
vi.mock('@/lib/remote-hermes/sessions', () => ({ ownedNativeSession: async (owner: string) => { if (owner !== 'owner') throw new Error('not found'); return { id: 'session', profile: f.profile }; } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => { if (!f.enabled) throw new Error('disabled'); return { client: { profiles: f.profiles } }; } }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ socket: { call: f.call }, refresh: f.refresh, sessions: new Map([['session', { row: { runtimeId: 'runtime' }, view: f.missingView ? undefined : { running: f.status === 'running' || f.runtimeRunning, uncertain: f.uncertain, queuePending: f.queuePending } }]]) }) }));
vi.mock('@/db', () => ({ db: { transaction: async (run: (tx: unknown) => unknown) => run({
  select: () => ({ from: (table: { [key: symbol]: unknown }) => {
    const name = table[Symbol.for('drizzle:Name')];
    const rows = name === 'settings' ? [] : name === 'remote_hermes_turns' ? f.receipt ? [f.receipt] : [] : [{ status: f.status, queueRequestId: f.queueRequestId }];
    return { where: () => Object.assign(Promise.resolve(rows), { for: async () => { if (name === 'settings') { ++f.locks; if (f.locks === f.disableAtLock) f.enabled = false; if (f.locks === f.reserveQueueAtLock) f.queueRequestId = 'pending-queue'; } return rows; } }) };
  } }),
  insert: () => ({ values: async (value: { digest: string }) => { f.receipt = { digest: value.digest }; } }),
}) } }));
import { nativeAdministration } from '@/lib/remote-hermes/administration';
const requestId = 'f1eeac5a-c19f-4b5b-97ef-a1cd7b02e658';
describe('native administration protocol and isolation', () => {
  beforeEach(() => { vi.clearAllMocks(); f.enabled = true; f.status = 'idle'; f.profile = 'default'; f.receipt = null; f.locks = 0; f.disableAtLock = 0; f.reserveQueueAtLock = 0; f.queueRequestId = null; f.uncertain = false; f.queuePending = false; f.runtimeRunning = false; f.missingView = false; f.refresh.mockResolvedValue({ running: false }); f.profiles.mockResolvedValue([{ name: 'default' }]); f.call.mockResolvedValue({ value: 'high', ok: true }); });
  it('rejects unowned sessions before native RPC', async () => {
    await expect(nativeAdministration('other', 'connection', 'session', { operation: 'inspect' })).rejects.toThrow('not found'); expect(f.call).not.toHaveBeenCalled();
  });
  it('rejects browser-selected profiles, scopes and arbitrary keys', () => {
    expect(administrationInput.safeParse({ operation: 'inspect', profile: 'other' }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'setting', requestId, key: 'yolo', value: 'on', scope: 'profile' }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'setting', requestId, key: 'reasoning', value: 'high', scope: 'once' }).success).toBe(false);
  });
  it('sends chat settings only with the bound runtime session and explicit session scope', async () => {
    await nativeAdministration('owner', 'connection', 'session', { operation: 'setting', requestId, key: 'reasoning', value: 'high', scope: 'session' });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('config.set', { profile: 'default', session_id: 'runtime', scope: 'session', key: 'reasoning', value: 'high' });
  });
  it('sends profile defaults without a session and with explicit global scope', async () => {
    await nativeAdministration('owner', 'connection', 'session', { operation: 'setting', requestId, key: 'fast', value: 'normal', scope: 'profile' });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('config.set', { profile: 'default', scope: 'global', key: 'fast', value: 'normal' });
  });
  it.each(['auto', 'cold', 'fast', 'ultrafast', 'normal'])('reads the native %s tier in both scopes without the lossy getter', async tier => {
    // 79af3 methods_config.py::_cfg_get_fast reports normal for auto/cold;
    // methods_config_set.py::_set_fast(value=status) returns the actual tier before any write.
    f.call.mockImplementation(async (method, params) => method === 'config.set'
      ? { key: 'fast', value: tier }
      : method === 'config.get' ? { value: params.key === 'fast' ? 'normal' : 'medium' } : { servers: [] });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'inspect' });
    expect(result).toMatchObject({ session: { fast: { supported: true, value: tier } }, profile: { fast: { supported: true, value: tier } } });
    expect(f.call).toHaveBeenCalledWith('config.set', { profile: 'default', session_id: 'runtime', scope: 'session', key: 'fast', value: 'status' });
    expect(f.call).toHaveBeenCalledWith('config.set', { profile: 'default', scope: 'global', key: 'fast', value: 'status' });
    expect(f.call).not.toHaveBeenCalledWith('config.get', expect.objectContaining({ key: 'fast' }));
    expect(f.receipt).toBeNull();
  });
  it('does not expose unexpected native status values or config', async () => {
    f.call.mockResolvedValue({ value: 'synthetic-secret', config: { agent: { service_tier: 'synthetic-secret' } }, servers: [] });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'inspect' });
    expect(result).toMatchObject({ session: { fast: { value: '' } }, profile: { fast: { value: '' } } });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
  it('marks only speed inspection unavailable when its status RPC is missing', async () => {
    f.call.mockImplementation(async method => { if (method === 'config.set') throw new HttpError(501, 'Unavailable'); return { value: 'high', servers: [] }; });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'inspect' });
    expect(result).toMatchObject({ session: { reasoning: { supported: true }, fast: { supported: false, value: '' } }, profile: { fast: { supported: false, value: '' } } });
    expect(f.call.mock.calls.every(([method]) => ['config.get', 'config.set', 'mcp.servers.list', 'mcp.servers.status', 'mcp.catalog'].includes(method))).toBe(true);
  });
  it('rechecks disablement after durable receipt and sends no mutation', async () => {
    f.disableAtLock = 2;
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'setting', requestId, key: 'reasoning', value: 'high', scope: 'session' })).rejects.toThrow('disabled');
    expect(f.receipt).not.toBeNull(); expect(f.call).not.toHaveBeenCalled();
  });
  it('does not repeat an acknowledged or uncertain administration mutation', async () => {
    const input = { operation: 'setting', requestId, key: 'reasoning', value: 'high', scope: 'session' };
    f.call.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
    await expect(nativeAdministration('owner', 'connection', 'session', input)).rejects.toThrow('lost acknowledgement');
    expect(await nativeAdministration('owner', 'connection', 'session', input)).toEqual({ accepted: true, duplicate: true }); expect(f.call).toHaveBeenCalledOnce();
  });
  it('blocks administration during an active turn and disallows unlisted presets', async () => {
    f.status = 'running';
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'setting', requestId, key: 'fast', value: 'normal', scope: 'session' })).rejects.toThrow('Finish');
    f.status = 'idle'; f.call.mockResolvedValue({ servers: [] });
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'install', requestId, preset: 'arbitrary' })).rejects.toThrow('preset');
    expect(f.call).not.toHaveBeenCalledWith('mcp.servers.add', expect.anything());
  });
  it('blocks probes with a durable queue reservation even if the cached snapshot is idle', async () => {
    f.queueRequestId = 'uncertain-queue';
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'test', name: 'example' })).rejects.toThrow('Finish');
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['uncertain', 'queuePending'] as const)('blocks probes when the cached view is %s', async state => {
    f[state] = true;
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'test', name: 'example' })).rejects.toThrow('Finish');
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each(['runtimeRunning', 'missingView'] as const)('blocks administration when the locked idle row has %s', async state => {
    f[state] = true;
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'setting', requestId, key: 'fast', value: 'auto', scope: 'session' })).rejects.toThrow('Finish');
    expect(f.receipt).toBeNull(); expect(f.call).not.toHaveBeenCalled();
  });
  it('rechecks queue reservations after the durable administration receipt', async () => {
    f.reserveQueueAtLock = 2;
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'setting', requestId, key: 'fast', value: 'auto', scope: 'session' })).rejects.toThrow('Finish');
    expect(f.receipt).not.toBeNull(); expect(f.call).not.toHaveBeenCalled();
  });
  it('binds credentials to an existing server key and stores only a digest receipt', async () => {
    f.call.mockResolvedValueOnce({ servers: [{ name: 'example', source: 'config', env: ['EXAMPLE_KEY'] }] }).mockResolvedValueOnce({ ok: true, server: { env: { EXAMPLE_KEY: 'synthetic-secret' } } });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'credential', requestId, name: 'example', envVar: 'EXAMPLE_KEY', value: 'synthetic-secret' });
    expect(f.call).toHaveBeenLastCalledWith('mcp.servers.set_api_key', { profile: 'default', name: 'example', env_var: 'EXAMPLE_KEY', value: 'synthetic-secret' });
    expect(JSON.stringify([result, f.receipt])).not.toContain('synthetic-secret');
  });
  it('redacts native env values, endpoints, command args, config and probe errors', () => {
    const inventory = mcpInventory({ servers: [{ name: 'example', transport: 'stdio', command: 'synthetic-secret', args: ['synthetic-secret'], env: { KEY: 'synthetic-secret' }, headers: { authorization: 'synthetic-secret' }, url: 'synthetic-secret' }] }, { servers: [{ name: 'example', tools: 2, status: 'connected' }] }, {});
    expect(inventory.servers[0]).toMatchObject({ name: 'example', envKeys: [], tools: 2, status: 'connected' });
    expect(JSON.stringify(inventory)).not.toContain('synthetic-secret');
    expect(JSON.stringify(probeSummary({ ok: false, error: 'synthetic-secret', tools: [] }))).not.toContain('synthetic-secret');
  });
  it.each([true, false, null])('preserves OAuth token presence %s without exposing native errors', oauthTokensPresent => {
    // Native mcp.servers.test uses oauth_needed for the server's configured auth,
    // including a network failure with tokens already present.
    const result = probeSummary({ ok: false, oauth_needed: true, oauth_tokens_present: oauthTokensPresent, error: 'synthetic-secret', tools: [] });
    expect(result).toMatchObject({ ok: false, oauthNeeded: true, oauthTokensPresent });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
  it('fails closed on unsupported inspection methods without command fallback', async () => {
    f.call.mockRejectedValue(new HttpError(501, 'Unavailable'));
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'inspect' });
    expect(result).toMatchObject({ session: { reasoning: { supported: false }, fast: { supported: false } }, mcp: null });
    expect(f.call.mock.calls.every(([method]) => ['config.get', 'config.set', 'mcp.servers.list'].includes(method))).toBe(true);
  });
  it('rejects credential writes to unlisted environment keys', async () => {
    f.call.mockResolvedValue({ servers: [{ name: 'example', source: 'config', env: ['EXAMPLE_KEY'] }] });
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'credential', requestId, name: 'example', envVar: 'UNRELATED_KEY', value: 'synthetic-secret' })).rejects.toThrow('existing credential key');
    expect(f.receipt).toBeNull(); expect(f.call).toHaveBeenCalledExactlyOnceWith('mcp.servers.list', { profile: 'default' });
  });
});
