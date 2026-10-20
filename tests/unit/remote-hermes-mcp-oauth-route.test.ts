import { beforeEach, expect, it, vi } from 'vitest';
import { HttpError } from '@/lib/authz';
const f = vi.hoisted(() => ({ trusted: true, run: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => ({ user: { id: 'owner' } }) }));
vi.mock('@/lib/auth/origin', () => ({ assertAuthOrigin: () => { if (!f.trusted) throw new HttpError(403, 'Untrusted origin'); } }));
vi.mock('@/lib/remote-hermes/mcp-oauth', () => ({ nativeMcpOAuth: f.run }));
import { POST } from '@/app/api/hermes/[connectionId]/mcp-oauth/route';
const ctx = { params: Promise.resolve({ connectionId: 'connection' }) };
const request = (body: unknown) => new Request('https://portal.example.invalid/api', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); f.trusted = true; f.run.mockResolvedValue({ status: 'pending' }); });
it('requires a trusted origin before processing protected flow handles', async () => {
  f.trusted = false;
  expect((await POST(request({ sessionId: 'session', input: { operation: 'poll', flow: 'synthetic-protected-flow' } }), ctx)).status).toBe(403);
  expect(f.run).not.toHaveBeenCalled();
});
it('bounds OAuth request bytes before dispatch', async () => {
  expect((await POST(new Request('https://portal.example.invalid/api', { method: 'POST', body: 'x'.repeat(12001) }), ctx)).status).toBe(413);
  expect(f.run).not.toHaveBeenCalled();
});
it('binds owner, connection and chat server-side and disables response caching', async () => {
  const input = { operation: 'start', requestId: 'f1eeac5a-c19f-4b5b-97ef-a1cd7b02e658', name: 'team-api', confirmed: true };
  const result = await POST(request({ sessionId: 'session', input }), ctx);
  expect(f.run).toHaveBeenCalledExactlyOnceWith('owner', 'connection', 'session', input);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
});
it('neither returns nor logs native diagnostics containing protected values', async () => {
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    f.run.mockRejectedValue(new Error('synthetic-secret-code-and-state'));
    const response = await POST(request({ sessionId: 'session', input: { operation: 'poll', flow: 'synthetic-flow' } }), ctx);
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('synthetic-secret');
    expect(logger).not.toHaveBeenCalled();
  } finally { logger.mockRestore(); }
});
