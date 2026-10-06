import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ authorize: vi.fn(), control: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/hermes-team/store', () => ({ authorizeTeam: f.authorize }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: f.control, dockerFetch: () => f.fetch }));
import { captureTeamResources, ensureTeamRuntime, inventoryTeamResources } from '@/lib/hermes-team/transport';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
const p = { user: { id: 'alice' } } as Principal;
const grantId = '11111111-1111-4111-8111-111111111111';
describe('trusted Team broker adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.authorize.mockResolvedValue({ bot: { name: 'Support' }, definition: { modelPolicy: { mode: 'personal_required' } } });
    f.control.mockResolvedValue({ grantId, expiresAt: Date.now() + 60000 }); f.fetch.mockResolvedValue(Response.json({ accepted: true }));
  });
  it('builds a private scope from authenticated actor/bot/mode with a server-only grant', async () => {
    expect(await ensureTeamRuntime(p, 'team', 'member')).toEqual({ accepted: true });
    expect(f.control).toHaveBeenCalledWith('alice', '/team/authorize', { teamBotId: 'team', mode: 'member', modelPolicy: 'personal_required' });
    const [url, request] = f.fetch.mock.calls[0];
    expect(url).toMatch(/\/team\/ensure$/); expect(request.headers['x-collective-team-grant']).toBe(grantId);
    expect(JSON.parse(request.body)).toEqual({ teamBotId: 'team', mode: 'member', name: 'Support' }); expect(f.authorize).toHaveBeenCalledTimes(3);
  });
  it('captures only Admin scope and validates bounded safe inventory keys', async () => {
    await captureTeamResources(p, 'team', { skillPackages: ['support'] });
    expect(f.control).toHaveBeenCalledWith('alice', '/team/authorize', { teamBotId: 'team', mode: 'admin', modelPolicy: 'personal_required' });
    f.fetch.mockResolvedValueOnce(Response.json({ skillPackages: ['support'], includeRole: true, documents: ['guide.md'] }));
    expect(await inventoryTeamResources(p, 'team')).toEqual({ available: true, selection: { skillPackages: ['support'], includeRole: true, documents: ['guide.md'] } });
    f.fetch.mockResolvedValueOnce(Response.json({ skillPackages: ['../../auth'], profile: 'foreign' }));
    await expect(inventoryTeamResources(p, 'team')).rejects.toBeDefined();
  });
  it('checks authorization before broker I/O and revokes a grant when authority changes during I/O', async () => {
    f.authorize.mockRejectedValueOnce(new HttpError(403, 'Revoked'));
    await expect(ensureTeamRuntime(p, 'team', 'member')).rejects.toMatchObject({ status: 403 }); expect(f.control).not.toHaveBeenCalled();
    f.authorize.mockResolvedValueOnce({ bot: { name: 'Support' }, definition: { modelPolicy: { mode: 'personal_required' } } }).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError(403, 'Revoked'));
    await expect(ensureTeamRuntime(p, 'team', 'member')).rejects.toMatchObject({ status: 403 });
    expect(f.control).toHaveBeenCalledWith('alice', '/team/revoke', { teamBotId: 'team', mode: 'member' }, 3000);
  });
  it('cleans up authority denied immediately after grant issuance, before native dispatch', async () => {
    f.authorize.mockResolvedValueOnce({ bot: { name: 'Support' }, definition: { modelPolicy: { mode: 'personal_required' } } }).mockRejectedValueOnce(new HttpError(403, 'Revoked'));
    await expect(ensureTeamRuntime(p, 'team', 'member')).rejects.toMatchObject({ status: 403 }); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.control).toHaveBeenCalledWith('alice', '/team/revoke', { teamBotId: 'team', mode: 'member' }, 3000);
  });
  it('treats an older broker without inventory as unavailable and preserves authorized working profiles', async () => {
    f.fetch.mockResolvedValueOnce(Response.json({ error: 'Unknown operation' }, { status: 404 }));
    await expect(inventoryTeamResources(p, 'team')).rejects.toMatchObject({ status: 503 });
    expect(f.control).toHaveBeenCalledTimes(1);
    expect(f.control.mock.calls[0][1]).toBe('/team/authorize');
  });
  it('rejects expired grants and hides upstream response/exception contents', async () => {
    f.control.mockResolvedValueOnce({ grantId, expiresAt: Date.now() - 1 });
    await expect(ensureTeamRuntime(p, 'team', 'member')).rejects.toMatchObject({ status: 503 }); expect(f.fetch).not.toHaveBeenCalled();
    f.fetch.mockResolvedValueOnce(Response.json({ secret: 'fixture-secret' }, { status: 500 }));
    await expect(ensureTeamRuntime(p, 'team', 'member')).rejects.toThrow(/runtime needs attention/);
    f.fetch.mockRejectedValueOnce(new Error('fixture-secret'));
    await expect(ensureTeamRuntime(p, 'team', 'member')).rejects.toThrow('The Team runtime broker is unavailable. Ask an admin to check setup.');
  });
});
