import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ principal: vi.fn(), origin: vi.fn(), preview: vi.fn(), remove: vi.fn(), audit: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ origin: 'https://portal.example.com' }) }));
vi.mock('@/lib/session', () => ({ requirePrincipal: f.principal }));
vi.mock('@/lib/auth/origin', () => ({ assertAuthOrigin: f.origin }));
vi.mock('@/lib/audit', () => ({ audit: f.audit }));
vi.mock('@/lib/remote-hermes/store', () => ({ prepareRemoteRemoval: f.preview, removeRemoteConnection: f.remove, connectRemoteHermes: vi.fn(), remoteProfiles: vi.fn() }));
import { previewRemoteHermesRemoval, removeRemoteHermes } from '@/app/(chat)/settings/remote-hermes-actions';
describe('RemoteHermes removal action boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.principal.mockReset().mockResolvedValue({ user: { id: 'owner' } }); f.origin.mockReset();
    f.preview.mockResolvedValue({ activeSessions: 1 }); f.remove.mockResolvedValue({ removed: true, activeSessions: 1, upstreamRevoked: false });
  });
  it('binds preview/removal to the signed-in principal and checks the mutation origin', async () => {
    await previewRemoteHermesRemoval('connection');
    expect(f.preview).toHaveBeenCalledExactlyOnceWith('owner', 'connection');
    await removeRemoteHermes('connection', { confirmActive: true });
    expect(f.origin).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledExactlyOnceWith('owner', 'connection', { confirmActive: true });
    expect(f.audit).not.toHaveBeenCalled(); // The store audits inside its deletion transaction.
  });
  it('rejects an untrusted origin before deleting or auditing', async () => {
    f.origin.mockImplementation(() => { throw new Error('Untrusted origin'); });
    await expect(removeRemoteHermes('connection', { confirmActive: true })).rejects.toThrow('Untrusted');
    expect(f.remove).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
  });
  it('does not audit a refused active-work removal as removed', async () => {
    f.remove.mockResolvedValue({ removed: false, activeSessions: 1 });
    expect(await removeRemoteHermes('connection', { confirmActive: false })).toEqual({ removed: false, activeSessions: 1 });
    expect(f.audit).not.toHaveBeenCalled();
  });
});
