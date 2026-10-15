import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/authz';

const f = vi.hoisted(() => ({ enabled: true, privateAllowed: true, revokeAfterReceipt: false, afterAccess: null as null | (() => Promise<void>), epoch: 1, status: 'idle', profile: 'default', storedId: 'stored', base: 'https://native.example.invalid/hermes', receipt: null as null | { digest: string }, inventory: [] as Record<string, unknown>[], locks: 0, disableAt: 0, busyAt: 0, start: vi.fn(), poll: vi.fn(), cancel: vi.fn(), profiles: vi.fn(), http: vi.fn(), refresh: vi.fn(), rpc: vi.fn(), transport: vi.fn() }));
vi.mock('@/lib/remote-hermes/sessions', () => ({ ownedNativeSession: async (owner: string, connection: string, session: string) => {
  if (owner !== 'owner' || connection !== 'connection' || session !== 'session') throw new HttpError(404, 'not found');
  return { id: session, connectionId: connection, profile: f.profile, storedId: f.storedId, runtimeId: 'runtime', status: f.status };
} }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: f.enabled }) }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardAddress: async () => {
  if (!f.privateAllowed) throw new HttpError(403, 'destination revoked');
  return { address: '127.0.0.1', family: 4 };
}, dashboardFetchPinned: vi.fn(() => fetch) }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: async (_owner: string, _connection: string, mode: string) => {
  if (!f.enabled && mode === 'admission') throw new HttpError(403, 'disabled');
  await f.afterAccess?.();
  return { client: { base: f.base, profiles: f.profiles, withTransport: f.transport } };
} }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({
  refresh: f.refresh,
  lockBoundary: async () => { if (++f.locks === f.disableAt) f.enabled = false; if (f.locks === f.busyAt) f.status = 'running'; return { baseUrl: f.base }; },
  socket: { get connectionEpoch() { return f.epoch; }, callConnected: f.rpc },
  sessions: new Map([['session', { row: { runtimeId: 'runtime', storedId: f.storedId, profile: f.profile }, view: { profile: f.profile, nativeProfile: f.profile, running: f.status === 'running' } }]]),
}) }));
vi.mock('@/db', () => ({ db: { transaction: async (run: (tx: unknown) => unknown) => run({
  select: () => ({ from: (table: { [key: symbol]: unknown }) => ({ where: () => {
    const rows = table[Symbol.for('drizzle:Name')] === 'remote_hermes_turns' ? f.receipt ? [f.receipt] : [] : [{ profile: f.profile, storedId: f.storedId, runtimeId: 'runtime', connectionId: 'connection', status: f.status }];
    return Object.assign(Promise.resolve(rows), { for: async () => rows });
  } }) }),
  insert: () => ({ values: async (value: { digest: string }) => { f.receipt = value; if (f.revokeAfterReceipt) f.privateAllowed = false; } }),
}) } }));
import { nativeMcpAuthorizationURL, nativeMcpOAuth } from '@/lib/remote-hermes/mcp-oauth';

const requestId = 'f1eeac5a-c19f-4b5b-97ef-a1cd7b02e658';
const input = { operation: 'start', requestId, name: 'team-api', confirmed: true };
const nativeId = 'synthetic-native-flow-12345678';
const callback = 'https://native.example.invalid/hermes/api/mcp/oauth/callback/team-api';
const authorization = () => `https://auth.example.invalid/authorize?state=synthetic-state&redirect_uri=${encodeURIComponent(callback)}`;
const start = () => nativeMcpOAuth('owner', 'connection', 'session', input);
const follow = (operation: 'poll' | 'cancel', flow: string) => nativeMcpOAuth('owner', 'connection', 'session', { operation, flow });
async function pending() { return await start() as { flow: string; authorizationUrl: string; status: string }; }

describe('owner-bound native-dashboard MCP OAuth', () => {
  beforeEach(() => {
    vi.resetAllMocks(); f.enabled = f.privateAllowed = true; f.revokeAfterReceipt = false; f.afterAccess = null; f.epoch = 1; f.status = 'idle'; f.profile = 'default'; f.storedId = 'stored'; f.base = 'https://native.example.invalid/hermes'; f.receipt = null; f.locks = f.disableAt = f.busyAt = 0;
    f.inventory = [{ name: 'team-api', source: 'config', transport: 'http', url: 'https://mcp.example.invalid/mcp', auth: 'oauth', oauth_tokens_present: false }];
    f.rpc.mockImplementation(async () => ({ servers: f.inventory }));
    f.refresh.mockResolvedValue(undefined);
    f.start.mockResolvedValue({ flow_id: nativeId, server_name: 'team-api', status: 'authorization_required', authorization_url: authorization() });
    f.poll.mockResolvedValue({ flow_id: nativeId, server_name: 'team-api', status: 'authorization_required', authorization_url: authorization() });
    f.cancel.mockResolvedValue({ ok: true, status: 'error' });
    f.profiles.mockImplementation(async () => { f.http('GET', '/api/profiles'); return [{ name: f.profile }]; });
    f.transport.mockImplementation(() => ({ profiles: f.profiles, startMcpOAuth: f.start, mcpOAuthFlow: f.poll, cancelMcpOAuth: f.cancel }));
  });
  it('requires explicit consent and server-owned identity/profile inputs', async () => {
    await expect(nativeMcpOAuth('owner', 'connection', 'session', { ...input, confirmed: false })).rejects.toThrow();
    await expect(nativeMcpOAuth('owner', 'connection', 'session', { ...input, profile: 'other' })).rejects.toThrow();
    await expect(nativeMcpOAuth('owner', 'connection', 'session', { ...input, client_redirect_uri: 'https://portal.invalid/callback' })).rejects.toThrow();
    await expect(nativeMcpOAuth('other', 'connection', 'session', input)).rejects.toThrow('not found');
    expect(f.start).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });
  it('reserves a digest before start and binds the distinct native flow to owner/chat/profile', async () => {
    f.start.mockImplementationOnce(async () => {
      expect(f.receipt).not.toBeNull();
      return { flow_id: nativeId, server_name: 'team-api', status: 'authorization_required', authorization_url: authorization() };
    });
    const result = await pending();
    expect(result).toMatchObject({ status: 'pending', authorizationUrl: authorization() });
    expect(result.flow).not.toContain(nativeId); expect(result.flow).not.toContain('synthetic-state');
    expect(f.start).toHaveBeenCalledExactlyOnceWith('default', 'team-api');
    expect(f.start.mock.calls[0]).not.toContain('runtime');
    expect(JSON.stringify(f.receipt)).not.toContain('synthetic-state');
    expect(await follow('poll', result.flow)).toMatchObject({ status: 'pending' });
    expect(f.poll).toHaveBeenCalledExactlyOnceWith(nativeId);
  });
  it('does not replay start after native acceptance loses its acknowledgement', async () => {
    f.start.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
    await expect(start()).rejects.toThrow('lost acknowledgement');
    f.rpc.mockRejectedValue(new Error('Inventory now changed'));
    await expect(start()).resolves.toMatchObject({ duplicate: true, status: 'uncertain' });
    await expect(nativeMcpOAuth('owner', 'connection', 'session', { ...input, name: 'changed' })).rejects.toThrow('different content');
    expect(f.start).toHaveBeenCalledOnce(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('rechecks admission and destination policy after reserving the receipt', async () => {
    f.revokeAfterReceipt = true;
    await expect(start()).rejects.toThrow('destination revoked');
    expect(f.receipt).not.toBeNull(); expect(f.start).not.toHaveBeenCalled();
  });
  it.each(['privateAllowed', 'enabled'] as const)('sends zero HTTP requests if %s is revoked after access policy capture', async flag => {
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.afterAccess = async () => { reached(); await barrier; };
    const operation = start();
    const rejected = expect(operation).rejects.toThrow(/revoked|disabled/);
    await ready;
    f[flag] = false;
    release();
    await rejected;
    expect(f.http).not.toHaveBeenCalled(); expect(f.profiles).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
    expect(f.receipt).toBeNull();
  });
  it('rechecks native activity at final start dispatch', async () => {
    f.busyAt = 4;
    await expect(start()).rejects.toThrow('Finish');
    expect(f.receipt).not.toBeNull(); expect(f.start).not.toHaveBeenCalled();
  });
  it.each([
    { source: 'plugin' }, { auth: 'header' }, { transport: 'stdio' }, { url: undefined },
  ])('refuses unsupported or protected native targets (%o)', async changed => {
    f.inventory = [{ ...f.inventory[0], ...changed }];
    await expect(start()).rejects.toThrow('configured HTTP');
    expect(f.start).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });
  it('refuses ambiguous native names and changed targets before POST', async () => {
    f.inventory.push({ ...f.inventory[0] });
    await expect(start()).rejects.toThrow('configured HTTP');
    expect(f.start).not.toHaveBeenCalled();
    f.inventory.pop();
    f.rpc.mockResolvedValueOnce({ servers: [{ ...f.inventory[0] }] }).mockResolvedValueOnce({ servers: [{ ...f.inventory[0], url: 'https://changed.invalid/mcp' }] });
    await expect(start()).rejects.toThrow('changed before');
    expect(f.start).not.toHaveBeenCalled(); expect(f.receipt).not.toBeNull();
  });
  it.each(['team_api', '_team_api', 'TEAM_API'])('protects native OAuth token filename aliases (%s)', async alias => {
    f.inventory = [{ ...f.inventory[0], name: 'team.api' }, { name: alias, source: 'plugin', transport: 'http', url: 'https://other.invalid/mcp' }];
    await expect(nativeMcpOAuth('owner', 'connection', 'session', { ...input, name: 'team.api' })).rejects.toThrow('protected OAuth credential slot');
    expect(f.start).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });
  it('fails closed when an inventory name cannot be safely normalized for native OAuth storage', async () => {
    f.inventory.push({ name: 'legacy—name', source: 'config', transport: 'stdio' });
    await expect(start()).rejects.toThrow('slots could not be verified safely');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects unsupported HTTP dashboards before starting a native grant', async () => {
    f.base = 'http://127.0.0.1:8123';
    await expect(start()).rejects.toThrow('HTTPS callback');
    expect(f.start).not.toHaveBeenCalled(); expect(f.receipt).toBeNull();
  });
  it.each([
    'https://portal.example.invalid/api/callback',
    'http://127.0.0.1:8123/callback',
    'https://native.example.invalid/hermes/api/mcp/oauth/callback/other',
    'https://native.example.invalid/hermes/api/mcp/oauth/callback/team-api?extra=1',
  ])('cancels a safely identified start with an unsupported callback (%s)', async redirect => {
    f.start.mockResolvedValue({ flow_id: nativeId, server_name: 'team-api', status: 'authorization_required', authorization_url: `https://auth.example.invalid/authorize?state=synthetic-state&redirect_uri=${encodeURIComponent(redirect)}` });
    await expect(start()).rejects.toThrow('HTTPS callback');
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(nativeId);
  });
  it('reports success only after approved native polling and fresh credential readback', async () => {
    const result = await pending();
    f.poll.mockResolvedValue({ flow_id: nativeId, server_name: 'team-api', status: 'approved', authorization_url: authorization() });
    await expect(follow('poll', result.flow)).rejects.toThrow('not confirmed the saved');
    f.inventory[0].oauth_tokens_present = true;
    await expect(follow('poll', result.flow)).resolves.toMatchObject({ status: 'approved' });
  });
  it.each(['profile', 'storedId', 'base'] as const)('rejects a flow when its %s binding changes', async field => {
    const result = await pending();
    f[field] = field === 'base' ? 'https://changed.example.invalid' : 'changed';
    await expect(follow('poll', result.flow)).rejects.toThrow(/invalid|destination changed/);
    expect(f.poll).not.toHaveBeenCalled();
  });
  it('rejects changed native flow identity, target and authorization URL', async () => {
    const result = await pending();
    f.poll.mockResolvedValueOnce({ flow_id: 'different-native-flow-12345678', server_name: 'team-api', status: 'approved', authorization_url: authorization() });
    await expect(follow('poll', result.flow)).rejects.toThrow('different OAuth flow');
    f.inventory[0].url = 'https://changed.invalid/mcp';
    await expect(follow('poll', result.flow)).rejects.toThrow('server changed during');
    f.inventory[0].url = 'https://mcp.example.invalid/mcp';
    f.poll.mockResolvedValue({ flow_id: nativeId, server_name: 'team-api', status: 'authorization_required', authorization_url: authorization().replace('synthetic-state', 'different-state') });
    await expect(follow('poll', result.flow)).rejects.toThrow('authorization changed');
  });
  it('permits cleanup after a chat becomes busy and never equates cancellation with revocation', async () => {
    const result = await pending(); f.status = 'running';
    await expect(follow('cancel', result.flow)).resolves.toMatchObject({ status: 'cancelled', message: expect.stringContaining('does not revoke') });
    f.cancel.mockResolvedValue({ ok: true, status: 'approved' });
    await expect(follow('cancel', result.flow)).resolves.toMatchObject({ status: 'uncertain', message: expect.stringContaining('already approved') });
    expect(f.cancel).toHaveBeenCalledTimes(2);
  });
  it('allows only flow-bound cancellation after admission is disabled and still fences revoked destinations', async () => {
    const result = await pending(); f.enabled = false;
    await expect(follow('poll', result.flow)).rejects.toThrow('disabled');
    await expect(follow('cancel', result.flow)).resolves.toMatchObject({ status: 'cancelled' });
    f.privateAllowed = false;
    await expect(follow('cancel', result.flow)).rejects.toThrow('destination revoked');
    expect(f.cancel).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce();
  });
  it('rejects a tampered or expired encrypted claim before native status/cancel', async () => {
    const result = await pending();
    await expect(follow('cancel', result.flow.slice(0, -3) + 'bad')).rejects.toThrow('invalid');
    vi.useFakeTimers();
    try { vi.setSystemTime(Date.now() + 601_000); await expect(follow('poll', result.flow)).rejects.toThrow('expired'); }
    finally { vi.useRealTimers(); }
    expect(f.poll).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
  });
  it('requires one HTTPS native callback and one state before exposing an authorization link', () => {
    expect(nativeMcpAuthorizationURL(f.base, 'team-api', authorization())).toBe(authorization());
    for (const url of ['javascript:alert(1)', authorization() + '&state=extra', authorization().replace('https://auth.', 'http://auth.'), authorization() + '&redirect_uri=' + encodeURIComponent(callback)])
      expect(() => nativeMcpAuthorizationURL(f.base, 'team-api', url)).toThrow('HTTPS callback');
  });
});
