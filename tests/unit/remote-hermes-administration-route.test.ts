import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/authz';
const f = vi.hoisted(() => ({ originAllowed: true, administration: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => ({ user: { id: 'owner' } }) }));
vi.mock('@/lib/auth/origin', () => ({ assertAuthOrigin: () => { if (!f.originAllowed) throw new HttpError(403, 'Untrusted origin'); } }));
vi.mock('@/lib/remote-hermes/administration', () => ({ nativeAdministration: f.administration }));
import { GET, POST } from '@/app/api/hermes/[connectionId]/administration/route';
const ctx = { params: Promise.resolve({ connectionId: 'connection' }) };
describe('native administration HTTP boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); f.originAllowed = true; f.administration.mockResolvedValue({ accepted: true }); });
  it('requires a trusted origin before accepting protected values', async () => {
    f.originAllowed = false;
    const response = await POST(new Request('https://example.invalid/api', { method: 'POST', body: JSON.stringify({ sessionId: 'session', input: { operation: 'credential', value: 'synthetic-secret' } }) }), ctx);
    expect(response.status).toBe(403); expect(f.administration).not.toHaveBeenCalled();
  });
  it('bounds the request body before parsing or dispatching', async () => {
    const response = await POST(new Request('https://example.invalid/api', { method: 'POST', body: 'x'.repeat(32001) }), ctx);
    expect(response.status).toBe(413); expect(f.administration).not.toHaveBeenCalled();
  });
  it('does not log or return unexpected errors containing protected values', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      f.administration.mockRejectedValue(new Error('synthetic-secret native diagnostic'));
      const response = await POST(new Request('https://example.invalid/api', { method: 'POST', body: JSON.stringify({ sessionId: 'session', input: { operation: 'inspect' } }) }), ctx);
      expect(response.status).toBe(502); expect(await response.text()).not.toContain('synthetic-secret'); expect(logger).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });
  it('binds authenticated identity and disables caching on inspection', async () => {
    const response = await GET(new Request('https://example.invalid/api?sessionId=session'), ctx);
    expect(f.administration).toHaveBeenCalledExactlyOnceWith('owner', 'connection', 'session', { operation: 'inspect' }); expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
