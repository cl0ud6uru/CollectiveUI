import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/authz';

const f = vi.hoisted(() => ({ admin: vi.fn(), perform: vi.fn(), read: vi.fn(), revalidate: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: f.revalidate }));
vi.mock('@/lib/session', () => ({ requireAdmin: f.admin }));
vi.mock('@/lib/docker-sandboxes/admin', () => ({ performDockerSandboxAction: f.perform, readDockerSandboxes: f.read }));
import { performDockerSandboxAction } from '@/app/admin/docker-sandboxes/actions';

beforeEach(() => {
  vi.resetAllMocks();
  f.admin.mockResolvedValue({ isAdmin: true });
  f.perform.mockResolvedValue({ result: { message: 'Sanitized result.' }, data: { available: false } });
});

describe('Docker Sandboxes Server Action feedback', () => {
  it.each(['diagnose', 'network-read', 'network-check'])('returns %s data without re-rendering the server page', async action => {
    expect(await performDockerSandboxAction({ action })).toMatchObject({ ok: true, result: { message: 'Sanitized result.' } });
    expect(f.revalidate).not.toHaveBeenCalled();
  });
  it('revalidates after a successful mutation', async () => {
    expect(await performDockerSandboxAction({ action: 'settings' })).toMatchObject({ ok: true });
    expect(f.revalidate).toHaveBeenCalledExactlyOnceWith('/admin/docker-sandboxes');
  });
  it('serializes expected diagnostics failures instead of throwing an opaque production React error', async () => {
    f.perform.mockRejectedValue(new HttpError(503, 'SBX administration is unavailable or needs operator reconciliation.'));
    expect(await performDockerSandboxAction({ action: 'diagnose' })).toEqual({ ok: false, error: 'SBX administration is unavailable or needs operator reconciliation.' });
    expect(f.revalidate).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected exceptions', async () => {
    f.perform.mockRejectedValue(new Error('private host path and token'));
    expect(await performDockerSandboxAction({ action: 'diagnose' })).toEqual({ ok: false, error: 'The SBX administration request could not be completed. Refresh before retrying.' });
  });
  it('returns an authorization error without dispatching or revalidating', async () => {
    f.admin.mockRejectedValue(new HttpError(403, 'Admin only'));
    expect(await performDockerSandboxAction({ action: 'diagnose' })).toEqual({ ok: false, error: 'Admin only' });
    expect(f.perform).not.toHaveBeenCalled(); expect(f.revalidate).not.toHaveBeenCalled();
  });
});
