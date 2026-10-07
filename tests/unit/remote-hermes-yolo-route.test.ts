import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/authz';
const f = vi.hoisted(() => ({ principal: true, origin: true, execute: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => { if (!f.principal) throw new HttpError(401, 'Sign in'); return { user: { id: 'owner' } }; } }));
vi.mock('@/lib/auth/origin', () => ({ assertAuthOrigin: () => { if (!f.origin) throw new HttpError(403, 'Untrusted origin'); } }));
vi.mock('@/lib/remote-hermes/yolo', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/remote-hermes/yolo')>(), nativeSessionYolo: f.execute }));
import { POST } from '@/app/api/hermes/[connectionId]/yolo/route';
const ctx = { params: Promise.resolve({ connectionId: 'connection' }) };
const request = (body: unknown) => POST(new Request('https://example.invalid/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ctx);
const valid = { sessionId: 'session', input: { operation: 'prepare', value: 'on' } };
describe('session YOLO HTTP authorization boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); f.principal = f.origin = true; f.execute.mockResolvedValue({ confirmation: 'synthetic' }); });
  it.each(['principal', 'origin'] as const)('requires %s before parsing and dispatch', async guard => { f[guard] = false; expect((await request(valid)).status).toBe(guard === 'principal' ? 401 : 403); expect(f.execute).not.toHaveBeenCalled(); });
  it('binds authenticated identity, path connection and owned-session input, with no caching', async () => {
    const response = await request(valid); expect(f.execute).toHaveBeenCalledExactlyOnceWith('owner', 'connection', 'session', valid.input); expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each([{ ...valid, profile: 'other' }, { ...valid, input: { ...valid.input, scope: 'global' } }, { ...valid, input: { operation: 'confirm', value: 'on' } }, 'invalid JSON', 'x'.repeat(8001)])('rejects malformed, oversized and browser-selected scope input', async body => {
    expect((await request(body)).status).toBe(typeof body === 'string' && body.length > 8000 ? 413 : 400); expect(f.execute).not.toHaveBeenCalled();
  });
  it('never logs or projects confirmation/native diagnostics from unexpected errors', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { f.execute.mockRejectedValue(new Error('synthetic secret and confirmation diagnostic')); const response = await request(valid); expect(response.status).toBe(502); expect(await response.text()).not.toContain('synthetic secret'); expect(logger).not.toHaveBeenCalled(); } finally { logger.mockRestore(); }
  });
});
