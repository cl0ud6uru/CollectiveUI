import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const f = vi.hoisted(() => ({ access: vi.fn(), fetch: vi.fn(), call: vi.fn(), refresh: vi.fn(), owned: vi.fn() }));
vi.mock('@/lib/remote-hermes/store', () => ({ remoteAccess: f.access }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardFetch: () => f.fetch }));
vi.mock('@/lib/remote-hermes/hub', () => ({ nativeHub: () => ({ socket: { call: f.call }, refresh: f.refresh, sessions: new Map([['native-row', { row: { runtimeId: 'runtime-session' } }]]) }) }));
vi.mock('@/lib/remote-hermes/sessions', async () => { const { z } = await import('zod'); return { profileName: z.string().regex(/^[a-zA-Z0-9_.-]+$/), ownedNativeSession: f.owned }; });
import { inspectNative, pluginProjection, projectProjection, scheduleProjection, systemProjection, workspaceFilesProjection } from '@/lib/remote-hermes/operations';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';

describe('native workspace inspection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.access.mockResolvedValue({ baseUrl: 'https://example.com/hermes', policy: { enabled: true, privateGateways: [] }, secrets: { mode: 'password', accessToken: 'synthetic-access' }, client: { profiles: async () => [{ name: 'default' }] } });
    f.call.mockResolvedValue({ projects: [] });
    f.owned.mockResolvedValue({ id: 'native-row', profile: 'default' });
    f.refresh.mockResolvedValue({});
    f.fetch.mockImplementation(async () => new Response(JSON.stringify({})));
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
  it('uses only the selected owned native session and never dashboard filesystem endpoints', async () => {
    const sessionId = newId();
    f.call.mockResolvedValueOnce({ protocol: 'collective.workspace-files.v1', available: true, workspace_id: 'a'.repeat(32), project_name: 'Synthetic', action: 'list', path: '.', entries: [{ name: 'src', path: 'src', kind: 'directory' }, { name: '.env', path: '.env', kind: 'file' }, { name: 'escape', path: '../escape', kind: 'file' }] });
    expect(await inspectNative('owner', 'connection', { panel: 'files', profile: 'default', sessionId })).toEqual({ available: true, workspaceId: 'a'.repeat(32), projectName: 'Synthetic', action: 'list', path: '.', entries: [{ name: 'src', path: 'src', directory: true }], truncated: false });
    expect(f.owned).toHaveBeenCalledWith('owner', 'connection', sessionId);
    expect(f.call).toHaveBeenCalledExactlyOnceWith('collective.workspace.files', { profile: 'default', session_id: 'runtime-session', action: 'list' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects missing/mismatched chats and never falls back when the native method is unsupported', async () => {
    await expect(inspectNative('owner', 'connection', { panel: 'files', profile: 'default' })).rejects.toThrow('Open a saved native Hermes chat');
    f.owned.mockResolvedValueOnce({ id: 'native-row', profile: 'other' });
    await expect(inspectNative('owner', 'connection', { panel: 'files', profile: 'default', sessionId: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow('profile of the selected');
    f.call.mockRejectedValueOnce(new HttpError(501, 'Unsupported'));
    await expect(inspectNative('owner', 'connection', { panel: 'files', profile: 'default', sessionId: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow('Unsupported');
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('projects only safe root-relative names and bounds text reads', () => {
    expect(workspaceFilesProjection({ protocol: 'collective.workspace-files.v1', available: true, workspace_id: 'b'.repeat(32), project_name: 'Example', action: 'list', path: 'src', entries: [{ name: 'main.ts', path: 'src/main.ts', kind: 'file' }, { name: '.env', path: 'src/.env', kind: 'file' }, { name: 'traversal', path: 'src/../secret', kind: 'file' }, { name: 'wrong', path: 'elsewhere/wrong', kind: 'directory' }] })).toEqual({ available: true, workspaceId: 'b'.repeat(32), projectName: 'Example', action: 'list', path: 'src', entries: [{ name: 'main.ts', path: 'src/main.ts', directory: false }], truncated: false });
    const content = 'synthetic', sha256 = createHash('sha256').update(content).digest('hex');
    expect(workspaceFilesProjection({ protocol: 'collective.workspace-files.v1', available: true, workspace_id: 'b'.repeat(32), project_name: 'Example', action: 'read', path: 'README.md', content, sha256 })).toMatchObject({ content, sha256 });
    expect(() => workspaceFilesProjection({ protocol: 'collective.workspace-files.v1', available: true, workspace_id: 'b'.repeat(32), project_name: 'Example', action: 'read', path: 'README.md', content, sha256: 'a'.repeat(64) })).toThrow('invalid workspace file revision');
    expect(() => workspaceFilesProjection({ protocol: 'collective.workspace-files.v1', available: true, workspace_id: 'b'.repeat(32), project_name: 'Example', action: 'read', path: 'README.md', content: 'x'.repeat(256 * 1024 + 1) })).toThrow('oversized');
    expect(() => workspaceFilesProjection({ protocol: 'collective.workspace-files.v1', available: true, workspace_id: 'b'.repeat(32), project_name: 'Example', action: 'read', path: '/etc/passwd', content: 'secret' })).toThrow('invalid workspace path');
  });
  it('reports unavailable versions and bounds response bodies without reflecting native error text', async () => {
    f.fetch.mockResolvedValueOnce(new Response('private upstream details', { status: 404 }));
    await expect(inspectNative('owner', 'connection', { panel: 'system', profile: 'default' })).rejects.toThrow('does not support');
    f.fetch.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(inspectNative('owner', 'connection', { panel: 'system', profile: 'default' })).rejects.toThrow('too large');
    f.fetch.mockResolvedValueOnce(new Response('<html>private</html>'));
    await expect(inspectNative('owner', 'connection', { panel: 'system', profile: 'default' })).rejects.toThrow('invalid panel');
  });
  it('falls back to legacy plugin discovery only for unsupported methods, never auth or uncertain failures', async () => {
    f.call.mockRejectedValueOnce(new HttpError(501, 'Unsupported')).mockResolvedValueOnce({ plugins: [{ name: 'Example', version: '1', enabled: true }] });
    expect(await inspectNative('owner', 'connection', { panel: 'plugins', profile: 'default' })).toEqual({ plugins: [{ key: '', name: 'Example', version: '1', status: 'enabled', source: '' }] });
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['plugins.manage', 'plugins.list']);
    f.call.mockClear(); f.call.mockRejectedValueOnce(new HttpError(401, 'Sign in again'));
    await expect(inspectNative('owner', 'connection', { panel: 'plugins', profile: 'default' })).rejects.toThrow('Sign in again'); expect(f.call).toHaveBeenCalledOnce();
  });
  it('lists schedules only from a profile-proven native cron RPC and projects out prompts and delivery data', async () => {
    f.call.mockResolvedValueOnce({ scoped: 'default', jobs: [{ job_id: 'j', name: 'Example', enabled: false, state: 'paused', schedule: '0 7 * * *', next_run_at: '2026-10-06T07:00:00Z', prompt: 'synthetic-hidden-prompt', deliver: 'synthetic-secret' }] });
    const view = await inspectNative('owner', 'connection', { panel: 'schedules', profile: 'default' });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('cron.manage', { profile: 'default', action: 'list', include_disabled: true });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toContain('synthetic'); expect(view).toEqual({ schedules: [{ id: 'j', name: 'Example', enabled: false, state: 'paused', schedule: '0 7 * * *', nextRun: '2026-10-06T07:00:00Z', lastStatus: '' }] });
  });
  it('fails closed when a native gateway cannot prove cron profile scoping', async () => {
    f.call.mockResolvedValueOnce({ jobs: [{ job_id: 'j', name: 'Other profile' }] });
    await expect(inspectNative('owner', 'connection', { panel: 'schedules', profile: 'default' })).rejects.toThrow('cannot confirm profile-scoped');
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
