import { describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextFetchEvent } from 'next/server';
import { HttpError } from '@/lib/authz';
vi.mock('@/auth', () => ({ auth: (handler: unknown) => handler, guardedHttpLogout: () => false, authSessionCookieName: () => 'session' }));
vi.mock('@/lib/auth/web-sessions', () => ({ webSessionRegistryEnabled: () => false }));
vi.mock('@/lib/llm/chatgpt/companion', () => ({ companionNativeStatus: async (_id: string, auth: string | null) => {
  if (auth !== `Companion ${'r'.repeat(43)}`) throw new HttpError(409, 'Invalid capability'); return { state: 'paired' };
} }));
import { proxy } from '@/proxy';
import { POST } from '@/app/api/chatgpt/companion/route';
const event = {} as NextFetchEvent;
const request = (headers: Record<string, string> = {}) => new NextRequest('https://portal.invalid/api/chatgpt/companion', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action: 'status', attemptId: '123e4567-e89b-42d3-a456-426614174000' }),
});
describe('native capability transport through the real web proxy', () => {
  it('passes the exact native route without a web session, then authorizes the native capability', async () => {
    const req = request({ authorization: `Companion ${'r'.repeat(43)}` });
    const result = await proxy(req, event); expect(result?.headers.get('x-middleware-next')).toBe('1');
    expect((await POST(req)).status).toBe(200);
  });
  it('does not bypass capability authentication or allow browser cookie authority', async () => {
    const anonymous = request(); expect((await proxy(anonymous, event))?.headers.get('x-middleware-next')).toBe('1');
    expect((await POST(anonymous)).status).toBe(409);
    expect((await POST(request({ authorization: `Companion ${'r'.repeat(43)}`, cookie: 'session=synthetic' }))).status).toBe(403);
  });
  it.each(['/api/chatgpt/companion/other', '/api/me/chatgpt'])('keeps adjacent %s paths behind the web session boundary', async path => {
    expect((await proxy(new NextRequest(`https://portal.invalid${path}`, { headers: { authorization: `Companion ${'r'.repeat(43)}` } }), event))?.status).toBe(401);
  });
});
