import { beforeEach, describe, expect, it, vi } from 'vitest';
import { administrationInput, mcpInventory, nativeMcpBearerEnvSlot, probeSummary } from '@/lib/remote-hermes/administration-contract';
import { HttpError } from '@/lib/authz';

const f = vi.hoisted(() => ({ enabled: true, status: 'idle', profile: 'default', allowed: true, disableAtLock: 0, reserveQueueAtLock: 0, queueRequestId: null as string | null, uncertain: false, queuePending: false, runtimeRunning: false, missingView: false, locks: 0, receipt: null as null | { digest: string }, call: vi.fn(), refresh: vi.fn(), profiles: vi.fn(), setEnabled: vi.fn() }));
vi.mock('@/lib/remote-hermes/sessions', () => ({ ownedNativeSession: async (owner: string) => { if (owner !== 'owner') throw new Error('not found'); return { id: 'session', profile: f.profile, status: f.status, queueRequestId: f.queueRequestId }; } }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled, privateGateways: [] }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async () => { if (!f.enabled) throw new Error('disabled'); return { client: { profiles: f.profiles, setMcpServerEnabled: f.setEnabled } }; } }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ lockBoundary: async (tx: { select: () => { from: (table: unknown) => { where: (condition: unknown) => { for: (mode: string) => Promise<unknown> } } } }) => { const { settings } = await import('@/db/schema'); await tx.select().from(settings).where(null).for('share'); }, socket: { connectionEpoch: 1, call: f.call, callConnected: f.call, dispatchConnected: async (method: string, params: unknown) => ({ reply: f.call(method, params) }) }, refresh: f.refresh, sessions: new Map([['session', { row: { runtimeId: 'runtime' }, view: f.missingView ? undefined : { running: f.status === 'running' || f.runtimeRunning, uncertain: f.uncertain, queuePending: f.queuePending } }]]) }) }));
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
  beforeEach(() => { vi.clearAllMocks(); f.enabled = true; f.status = 'idle'; f.profile = 'default'; f.receipt = null; f.locks = 0; f.disableAtLock = 0; f.reserveQueueAtLock = 0; f.queueRequestId = null; f.uncertain = false; f.queuePending = false; f.runtimeRunning = false; f.missingView = false; f.refresh.mockResolvedValue({ running: false }); f.profiles.mockResolvedValue([{ name: 'default' }]); f.setEnabled.mockResolvedValue({ ok: true }); f.call.mockResolvedValue({ value: 'high', ok: true }); });
  it('rejects unowned sessions before native RPC', async () => {
    await expect(nativeAdministration('other', 'connection', 'session', { operation: 'inspect' })).rejects.toThrow('not found'); expect(f.call).not.toHaveBeenCalled();
  });
  it('rejects browser-selected profiles, scopes and arbitrary keys', () => {
    expect(administrationInput.safeParse({ operation: 'inspect', profile: 'other' }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'setting', requestId, key: 'yolo', value: 'on', scope: 'profile' }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'setting', requestId, key: 'reasoning', value: 'high', scope: 'once' }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'remove', requestId, name: 'example' }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'reload', requestId, confirmed: false }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'customServer', requestId, name: 'demo', url: 'http://mcp.example.test/mcp', confirmed: true }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'customServer', requestId, name: 'demo', url: 'https://user:pass@mcp.example.test/mcp', confirmed: true }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'customServer', requestId, name: 'demo', url: 'https://mcp.example.test/mcp?token=secret', confirmed: true }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'customServer', requestId, name: 'demo', url: 'https://mcp.example.test/mcp', command: 'sh', confirmed: true }).success).toBe(false);
    expect(administrationInput.safeParse({ operation: 'customServer', requestId, name: 'bad name', url: 'https://mcp.example.test/mcp', confirmed: true }).success).toBe(false);
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
  it('creates only a typed HTTPS server, stores bearer material natively, and verifies redacted readback', async () => {
    const input = { operation: 'customServer', requestId, name: 'team-api', url: 'https://mcp.example.test/mcp', bearerToken: 'synthetic-bearer-secret', confirmed: true } as const;
    const configured = { name: 'team-api', source: 'config', transport: 'http', auth: 'header', url: 'https://mcp.example.test/mcp', env: [] };
    f.call.mockImplementation(async (method: string) => {
      if (method === 'mcp.servers.list') return { servers: f.call.mock.calls.filter(([call]) => call === 'mcp.servers.add').length ? [configured] : [] };
      if (method === 'mcp.servers.add') return { ok: true, name: 'team-api', server: configured };
      return { ok: true };
    });
    const result = await nativeAdministration('owner', 'connection', 'session', input);
    expect(result).toEqual({ accepted: true, added: true, name: 'team-api', credentialConfigured: true });
    expect(f.call).toHaveBeenCalledWith('mcp.servers.add', {
      profile: 'default', name: 'team-api', config: { url: 'https://mcp.example.test/mcp' }, bearer_token: 'synthetic-bearer-secret',
    });
    expect(f.call).toHaveBeenCalledWith('mcp.servers.list', { profile: 'default' });
    expect(JSON.stringify([result, f.receipt])).not.toContain('synthetic-bearer-secret');
    expect(f.receipt?.digest).not.toContain('synthetic-bearer-secret');
  });
  it.each([
    { existing: 'team-api', candidate: 'team.api' },
    { existing: 'team.api', candidate: 'team-api' },
  ])('prevents bearer writes when native names normalize to the same credential slot (%o)', async ({ existing, candidate }) => {
    const preserved = 'synthetic-existing-token';
    let persistedToken = preserved;
    f.call.mockImplementation(async (method: string, params: { bearer_token?: string }) => {
      if (method === 'mcp.servers.list') return { servers: [{ name: existing, source: 'config', transport: 'stdio', enabled: true, env: [] }] };
      if (method === 'mcp.servers.add') persistedToken = params.bearer_token ?? '';
      return { ok: true };
    });
    expect(nativeMcpBearerEnvSlot(existing)).toBe('MCP_TEAM_API_API_KEY');
    expect(nativeMcpBearerEnvSlot(candidate)).toBe('MCP_TEAM_API_API_KEY');
    await expect(nativeAdministration('owner', 'connection', 'session', {
      operation: 'customServer', requestId, name: candidate, url: 'https://mcp.example.test/mcp', bearerToken: 'synthetic-new-token', confirmed: true,
    })).rejects.toThrow('shares a protected credential slot');
    expect(f.call).toHaveBeenCalledExactlyOnceWith('mcp.servers.list', { profile: 'default' });
    expect(f.call).not.toHaveBeenCalledWith('mcp.servers.add', expect.anything());
    expect(f.receipt).toBeNull();
    expect(persistedToken).toBe(preserved);
  });
  it('fails closed when an existing native name cannot be normalized safely', async () => {
    f.call.mockResolvedValue({ servers: [{ name: 'mcp-東京', source: 'config', transport: 'stdio', enabled: true, env: [] }] });
    await expect(nativeAdministration('owner', 'connection', 'session', {
      operation: 'customServer', requestId, name: 'new-server', url: 'https://mcp.example.test/mcp', bearerToken: 'synthetic-new-token', confirmed: true,
    })).rejects.toThrow('credential slots could not be verified safely');
    expect(f.call).not.toHaveBeenCalledWith('mcp.servers.add', expect.anything());
    expect(f.receipt).toBeNull();
  });
  it('rejects a normalized bearer slot already declared by another server environment', async () => {
    f.call.mockResolvedValue({ servers: [{ name: 'other-server', source: 'config', transport: 'stdio', enabled: true, env: ['MCP_NEW_SERVER_API_KEY'] }] });
    await expect(nativeAdministration('owner', 'connection', 'session', {
      operation: 'customServer', requestId, name: 'new-server', url: 'https://mcp.example.test/mcp', bearerToken: 'synthetic-new-token', confirmed: true,
    })).rejects.toThrow('shares a protected credential slot');
    expect(f.call).not.toHaveBeenCalledWith('mcp.servers.add', expect.anything());
    expect(f.receipt).toBeNull();
  });
  it('fails closed when an HTTP server hides its header environment references', async () => {
    f.call.mockResolvedValue({ servers: [{ name: 'existing', source: 'config', transport: 'http', enabled: true, auth: 'header', env: [] }] });
    await expect(nativeAdministration('owner', 'connection', 'session', {
      operation: 'customServer', requestId, name: 'new-server', url: 'https://mcp.example.test/mcp', bearerToken: 'synthetic-new-token', confirmed: true,
    })).rejects.toThrow('not expose enough MCP credential metadata');
    expect(f.call).not.toHaveBeenCalledWith('mcp.servers.add', expect.anything());
    expect(f.receipt).toBeNull();
  });
  it('does not replay an uncertain custom-server write when the same receipt is retried', async () => {
    const input = { operation: 'customServer', requestId, name: 'team-api', url: 'https://mcp.example.test/mcp', bearerToken: 'synthetic-bearer-secret', confirmed: true } as const;
    f.call.mockImplementation(async (method: string) => {
      if (method === 'mcp.servers.list') return { servers: [] };
      if (method === 'mcp.servers.add') throw new Error('Synthetic lost acknowledgement');
      return { ok: true };
    });
    await expect(nativeAdministration('owner', 'connection', 'session', input)).rejects.toThrow('lost acknowledgement');
    expect(await nativeAdministration('owner', 'connection', 'session', input)).toEqual({ accepted: true, duplicate: true });
    expect(f.call.mock.calls.filter(([method]) => method === 'mcp.servers.add')).toHaveLength(1);
    expect(JSON.stringify(f.receipt)).not.toContain('synthetic-bearer-secret');
  });
  it('blocks custom-server writes during active or uncertain native work before reserving a receipt', async () => {
    const input = { operation: 'customServer', requestId, name: 'team-api', url: 'https://mcp.example.test/mcp', confirmed: true } as const;
    f.runtimeRunning = true;
    await expect(nativeAdministration('owner', 'connection', 'session', input)).rejects.toThrow('Finish');
    expect(f.receipt).toBeNull(); expect(f.call).not.toHaveBeenCalled();
  });
  it('fails closed if native add or authoritative inventory readback does not confirm the custom server', async () => {
    const input = { operation: 'customServer', requestId, name: 'team-api', url: 'https://mcp.example.test/mcp', confirmed: true } as const;
    f.call.mockImplementation(async (method: string) => {
      if (method === 'mcp.servers.list') return { servers: f.call.mock.calls.filter(([call]) => call === 'mcp.servers.add').length ? [] : [] };
      return { ok: true, name: 'team-api', server: { name: 'team-api', source: 'config', transport: 'http', url: input.url } };
    });
    await expect(nativeAdministration('owner', 'connection', 'session', input)).rejects.toThrow('profile inventory');
    expect(f.receipt).not.toBeNull();
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
  it('removes only an inventoried config server and verifies it disappeared before success', async () => {
    f.call.mockImplementation(async (method: string, params: { profile?: string; name?: string }) => {
      if (method === 'mcp.servers.list') return { servers: params.profile === 'default' && f.call.mock.calls.filter(([m]) => m === 'mcp.servers.list').length === 1 ? [{ name: 'example', source: 'config' }] : [] };
      if (method === 'mcp.servers.remove') return { ok: true, removed: true };
      return {};
    });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'remove', requestId, name: 'example', confirmed: true });
    expect(result).toEqual({ accepted: true, removed: true });
    expect(f.call).toHaveBeenCalledWith('mcp.servers.remove', { profile: 'default', name: 'example' });
    expect(f.call).toHaveBeenCalledTimes(3); // profile ownership read, native removal, authoritative native readback
  });
  it.each([{ name: 'example', source: 'plugin' }, { name: 'example' }])('refuses removal when the server is not authoritatively config-owned (%o)', async server => {
    f.call.mockResolvedValue({ servers: [server] });
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'remove', requestId, name: 'example', confirmed: true })).rejects.toThrow('removed here');
    expect(f.receipt).toBeNull(); expect(f.call).toHaveBeenCalledExactlyOnceWith('mcp.servers.list', { profile: 'default' });
  });
  it('does not report removal complete when authoritative inventory still contains the server', async () => {
    f.call.mockImplementation(async method => method === 'mcp.servers.list' ? { servers: [{ name: 'example', source: 'config' }] } : { ok: true, removed: true });
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'remove', requestId, name: 'example', confirmed: true })).rejects.toThrow('still reports');
    expect(f.receipt).not.toBeNull(); expect(f.call.mock.calls.filter(([method]) => method === 'mcp.servers.remove')).toHaveLength(1);
  });
  it('does not replay a removal when Hermes loses its acknowledgement', async () => {
    f.call.mockImplementation(async (method: string) => {
      if (method === 'mcp.servers.list') return { servers: [{ name: 'example', source: 'config' }] };
      if (method === 'mcp.servers.remove') throw new Error('Synthetic lost acknowledgement');
      return {};
    });
    const input = { operation: 'remove', requestId, name: 'example', confirmed: true } as const;
    await expect(nativeAdministration('owner', 'connection', 'session', input)).rejects.toThrow('lost acknowledgement');
    expect(await nativeAdministration('owner', 'connection', 'session', input)).toEqual({ accepted: true, duplicate: true });
    expect(f.call.mock.calls.filter(([method]) => method === 'mcp.servers.remove')).toHaveLength(1);
  });
  it('reloads MCP only after explicit confirmation and uses the server-owned runtime identity', async () => {
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'reload', requestId, confirmed: false })).rejects.toThrow();
    f.call.mockResolvedValue({ status: 'reloaded' });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'reload', requestId, confirmed: true });
    expect(result).toEqual({ accepted: true, reloaded: true });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('reload.mcp', { session_id: 'runtime', confirm: true });
  });
  it('changes enablement only for an inventoried config server, with profile-bound HTTP operation and native readback', async () => {
    f.call.mockImplementation(async method => method === 'mcp.servers.list'
      ? { servers: [{ name: 'example', source: 'config', enabled: f.call.mock.calls.filter(([m]) => m === 'mcp.servers.list').length > 1 }] }
      : { value: 'high' });
    const result = await nativeAdministration('owner', 'connection', 'session', { operation: 'enabled', requestId, name: 'example', enabled: true, confirmed: true });
    expect(result).toEqual({ accepted: true, enabled: true });
    expect(f.setEnabled).toHaveBeenCalledExactlyOnceWith('default', 'example', true);
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(f.call).toHaveBeenNthCalledWith(1, 'mcp.servers.list', { profile: 'default' });
    expect(f.call.mock.calls[1].slice(0, 2)).toEqual(['mcp.servers.list', { profile: 'default' }]);
    expect(f.receipt).not.toBeNull();
  });
  it.each([{ name: 'example', source: 'plugin', enabled: false }, { name: 'example', enabled: false }])('does not toggle servers without config provenance (%o)', async server => {
    f.call.mockResolvedValue({ servers: [server] });
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'enabled', requestId, name: 'example', enabled: true, confirmed: true })).rejects.toThrow('changed here');
    expect(f.setEnabled).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });
  it('does not report enablement if native authoritative readback disagrees', async () => {
    f.call.mockResolvedValue({ servers: [{ name: 'example', source: 'config', enabled: false }] });
    await expect(nativeAdministration('owner', 'connection', 'session', { operation: 'enabled', requestId, name: 'example', enabled: true, confirmed: true })).rejects.toThrow('did not confirm');
    expect(f.setEnabled).toHaveBeenCalledOnce(); expect(f.receipt).not.toBeNull();
  });
  it('does not replay enablement after an uncertain authenticated HTTP response', async () => {
    f.call.mockResolvedValue({ servers: [{ name: 'example', source: 'config', enabled: false }] });
    f.setEnabled.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
    const input = { operation: 'enabled', requestId, name: 'example', enabled: true, confirmed: true } as const;
    await expect(nativeAdministration('owner', 'connection', 'session', input)).rejects.toThrow('lost acknowledgement');
    expect(await nativeAdministration('owner', 'connection', 'session', input)).toEqual({ accepted: true, duplicate: true });
    expect(f.setEnabled).toHaveBeenCalledOnce();
  });
});
