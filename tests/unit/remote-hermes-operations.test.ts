import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ access: vi.fn(), fetch: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: f.access }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardFetch: () => f.fetch }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ socket: { call: f.call } }) }));
vi.mock('@/lib/remote-hermes/sessions', async () => { const { z } = await import('zod'); return { profileName: z.string().regex(/^[a-zA-Z0-9_.-]+$/) }; });
import { directoryProjection, inspectNative, pluginProjection, projectProjection, scheduleProjection, systemProjection } from '@/lib/remote-hermes/operations';
import { HttpError } from '@/lib/authz';

describe('native workspace inspection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.access.mockResolvedValue({ baseUrl: 'https://example.com/hermes', policy: { enabled: true, privateGateways: [] }, secrets: { mode: 'password', accessToken: 'synthetic-access' }, client: { profiles: async () => [{ name: 'default' }] } });
    f.call.mockResolvedValue({ projects: [] });
    f.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('default-cwd') ? { cwd: '/workspace' } : { entries: [] })));
  });
  it('checks owned connection and admission before native transport', async () => {
    f.access.mockRejectedValueOnce(new Error('Connection not found'));
    await expect(inspectNative('intruder', 'connection', { panel: 'system', profile: 'default' })).rejects.toThrow('not found');
    expect(f.access).toHaveBeenCalledWith('intruder', 'connection', 'admission'); expect(f.fetch).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
    f.access.mockRejectedValueOnce(new Error('Personal remote Hermes is disabled'));
    await expect(inspectNative('owner', 'connection', { panel: 'plugins', profile: 'default' })).rejects.toThrow('disabled'); expect(f.call).not.toHaveBeenCalled();
  });
  it('rejects arbitrary panel paths and profiles outside the authenticated roster', async () => {
    await expect(inspectNative('owner', 'connection', { panel: '/api/env', profile: 'default' })).rejects.toThrow();
    await expect(inspectNative('owner', 'connection', { panel: 'projects', profile: 'another-user' })).rejects.toThrow('not found'); expect(f.call).not.toHaveBeenCalled();
  });
  it('projects out config, prompts, env, hostname and secrets from all panels', () => {
    const secret = 'must-not-appear';
    const values = [projectProjection({ projects: [{ id: 'p', name: 'Example', folders: [], config: secret }] }), pluginProjection({ plugins: [{ name: 'example', version: '1', settings_schema: [{ value: secret }], servers: [{ env: secret }], install_dir: secret }] }), scheduleProjection([{ id: 'j', name: 'Example', prompt: secret, command: secret, deliver: secret }]), systemProjection({ hermes_version: '1', hostname: secret, process: { pid: 1 }, env: secret })];
    expect(JSON.stringify(values)).not.toContain(secret); expect(systemProjection({ cpu_count: -1, cpu_percent: Infinity }).cpuCount).toBeUndefined();
  });
  it('does not list hidden or sensitive entries, fabricated paths or traversal', () => {
    expect(directoryProjection({ entries: [{ name: 'README.md', path: '/workspace/README.md' }, { name: 'src', path: '/workspace/src', isDirectory: true }, { name: '.env', path: '/workspace/.env' }, { name: 'credentials', path: '/workspace/credentials', isDirectory: true }, { name: 'other', path: '/etc/other' }, { name: '..', path: '/workspace/..' }] }, '/workspace')).toEqual([{ name: 'README.md', path: '/workspace/README.md', directory: false }, { name: 'src', path: '/workspace/src', directory: true }]);
  });
  it('only descends into server-listed directories and excludes symlink leaves', async () => {
    f.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('default-cwd') ? { cwd: '/workspace' } : { entries: [{ name: 'link', path: '/workspace/link', isDirectory: false }] })));
    await expect(inspectNative('owner', 'connection', { panel: 'files', profile: 'default', path: '/workspace/link/secret' })).rejects.toThrow('listed');
    await expect(inspectNative('owner', 'connection', { panel: 'files', profile: 'default', path: '/etc' })).rejects.toThrow('inside');
    await expect(inspectNative('owner', 'connection', { panel: 'files', profile: 'default', path: '/workspace/../etc' })).rejects.toThrow('listed');
  });
  it('lists descendants using encoded paths, keeps credentials server-side and never mutates native state', async () => {
    f.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('default-cwd') ? { cwd: '/workspace' } : new URL(url).searchParams.get('path') === '/workspace' ? { entries: [{ name: 'src', path: '/workspace/src', isDirectory: true }] } : { entries: [] })));
    expect(await inspectNative('owner', 'connection', { panel: 'files', profile: 'default', path: '/workspace/src' })).toEqual({ roots: ['/workspace'], directory: '/workspace/src', entries: [] });
    expect(f.fetch.mock.calls.every(([, opts]) => opts.method === undefined && opts.headers.Authorization === 'Bearer synthetic-access')).toBe(true);
    expect(f.call).toHaveBeenCalledWith('projects.list', { profile: 'default' });
  });
  it('reports unavailable versions and bounds response bodies without reflecting native error text', async () => {
    f.fetch.mockResolvedValueOnce(new Response('private upstream details', { status: 404 }));
    await expect(inspectNative('owner', 'connection', { panel: 'system', profile: 'default' })).rejects.toThrow('does not support');
    f.fetch.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(inspectNative('owner', 'connection', { panel: 'schedules', profile: 'default' })).rejects.toThrow('too large');
    f.fetch.mockResolvedValueOnce(new Response('<html>private</html>'));
    await expect(inspectNative('owner', 'connection', { panel: 'system', profile: 'default' })).rejects.toThrow('invalid panel');
  });
  it('falls back to legacy plugin discovery only for unsupported methods, never auth or uncertain failures', async () => {
    f.call.mockRejectedValueOnce(new HttpError(501, 'Unsupported')).mockResolvedValueOnce({ plugins: [{ name: 'Example', version: '1', enabled: true }] });
    expect(await inspectNative('owner', 'connection', { panel: 'plugins', profile: 'default' })).toEqual({ plugins: [{ name: 'Example', version: '1', status: 'enabled', source: '' }] });
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['plugins.manage', 'plugins.list']);
    f.call.mockClear(); f.call.mockRejectedValueOnce(new HttpError(401, 'Sign in again'));
    await expect(inspectNative('owner', 'connection', { panel: 'plugins', profile: 'default' })).rejects.toThrow('Sign in again'); expect(f.call).toHaveBeenCalledOnce();
  });
  it('sends an explicit profile for schedules and authenticates session-token dashboards without exposing the token', async () => {
    f.access.mockResolvedValueOnce({ baseUrl: 'https://example.com/hermes', policy: { enabled: true, privateGateways: [] }, secrets: { mode: 'sessionToken', sessionToken: 'synthetic-session' }, client: { profiles: async () => [{ name: 'default' }] } });
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ job_id: 'j', name: 'Example', enabled: false, schedule: '0 7 * * *', next_run_at: '2026-10-06T07:00:00Z', prompt: 'synthetic-hidden-prompt' }])));
    const view = await inspectNative('owner', 'connection', { panel: 'schedules', profile: 'default' });
    const [url, options] = f.fetch.mock.calls[0]; expect(new URL(url).searchParams.get('profile')).toBe('default'); expect(options.headers).toEqual({ 'X-Hermes-Session-Token': 'synthetic-session' });
    expect(JSON.stringify(view)).not.toContain('synthetic'); expect(view).toEqual({ schedules: [{ id: 'j', name: 'Example', enabled: false, schedule: '0 7 * * *', nextRun: '2026-10-06T07:00:00Z', lastStatus: '' }] });
  });
});
