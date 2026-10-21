import { beforeEach, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/authz';
const f = vi.hoisted(() => ({ principal: true, origin: true, execute: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => { if (!f.principal) throw new HttpError(401, 'Sign in'); return { user: { id: 'owner' } }; } }));
vi.mock('@/lib/auth/origin', () => ({ assertAuthOrigin: () => { if (!f.origin) throw new HttpError(403, 'Untrusted origin'); } }));
vi.mock('@/lib/remote-hermes/recovery', () => ({ nativeRecovery: f.execute }));
import { POST } from '@/app/api/hermes/[connectionId]/recovery/route';
const request = (body: unknown, contentType = 'application/json') => POST(new Request('https://synthetic.invalid/api', {
  method: 'POST', headers: { 'Content-Type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
}), { params: Promise.resolve({ connectionId: 'connection' }) });
const valid = { operation: 'prepare', sessionId: 'session' };
beforeEach(() => { vi.clearAllMocks(); f.principal = f.origin = true; f.execute.mockResolvedValue({ state: 'prepared' }); });
it.each(['principal', 'origin'] as const)('requires %s before parsing/dispatch', async guard => {
  f[guard] = false; expect((await request(valid)).status).toBe(guard === 'principal' ? 401 : 403); expect(f.execute).not.toHaveBeenCalled();
});
it('binds authenticated owner/path connection and disables caching', async () => {
  const result = await request(valid); expect(result.status).toBe(200); expect(f.execute).toHaveBeenCalledExactlyOnceWith('owner', 'connection', valid);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
});
it.each([{ ...valid, runtimeId: 'foreign' }, { ...valid, ownerId: 'other' }, { operation: 'confirm', sessionId: 'session', intentId: '20a6efe8-3e54-48f2-ad89-d281fef683a4' }, 'invalid', 'x'.repeat(2049)])('rejects browser scope, unconfirmed and malformed input', async input => {
  expect((await request(input)).status).toBe(typeof input === 'string' && input.length > 2048 ? 413 : 400); expect(f.execute).not.toHaveBeenCalled();
});
it('requires JSON content type', async () => { expect((await request(valid, 'text/plain')).status).toBe(415); expect(f.execute).not.toHaveBeenCalled(); });
it('does not log or return unexpected native credentials/diagnostics', async () => {
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { f.execute.mockRejectedValue(new Error('synthetic protected diagnostic')); const response = await request(valid);
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('protected'); expect(logger).not.toHaveBeenCalled();
  } finally { logger.mockRestore(); }
});
