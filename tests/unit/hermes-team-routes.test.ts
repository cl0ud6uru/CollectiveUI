import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ principal: vi.fn(), configure: vi.fn(), status: vi.fn(), open: vi.fn(), ensure: vi.fn() }));
vi.mock('@/lib/session', async () => {
  const { HttpError } = await import('@/lib/authz');
  return { requirePrincipal: f.principal, errorResponse: (e: unknown) => Response.json({ error: e instanceof HttpError ? e.message : 'Unavailable' }, { status: e instanceof HttpError ? e.status : 500 }) };
});
vi.mock('@/lib/hermes-team/store', () => ({ configureTeam: f.configure }));
vi.mock('@/lib/hermes-team/conversations', () => ({ teamChatStatus: f.status, openTeamConversation: f.open }));
vi.mock('@/lib/hermes-team/provisioning', () => ({ ensureTeamPrivateInstance: f.ensure }));
import { GET, PUT } from '@/app/api/bots/[id]/team/route';
import { POST } from '@/app/api/bots/[id]/team/open/route';
import { HttpError } from '@/lib/authz';
const ctx = { params: Promise.resolve({ id: 'team' }) };
const req = (body: string, origin: string | null = 'https://example.test', type = 'application/json') => new Request('https://example.test/api/bots/team/team', { method: 'POST', headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': type }, body });
describe('Team configuration and mode API boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('AUTH_URL', 'https://example.test'); f.principal.mockResolvedValue({ user: { id: 'alice' } }); f.configure.mockResolvedValue({ version: 2 }); f.status.mockResolvedValue({ mode: 'member' }); f.open.mockResolvedValue({ conversationId: 'separate' }); f.ensure.mockResolvedValue({ state: 'connection_needed' }); });
  afterEach(() => vi.unstubAllEnvs());
  it.each([null, 'https://attacker.example', 'https://example.test.attacker.example'])('rejects foreign/missing origin %s before dispatch or body read', async origin => {
    for (const handler of [PUT, POST]) {
      const request = req('{"mode":"admin"}', origin), body = vi.spyOn(request.body!, 'getReader');
      expect((await handler(request, ctx)).status).toBe(403); expect(body).not.toHaveBeenCalled();
    }
    expect(f.principal).not.toHaveBeenCalled(); expect(f.configure).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it('requires the signed-in principal for reads and writes', async () => {
    f.principal.mockRejectedValue(new HttpError(401, 'Unauthorized'));
    expect((await GET(req('{}'), ctx)).status).toBe(401);
    expect((await PUT(req('{}'), ctx)).status).toBe(401);
    expect((await POST(req('{"mode":"admin"}'), ctx)).status).toBe(401);
    expect(f.status).not.toHaveBeenCalled(); expect(f.configure).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it('derives actor/bot and allows only a strict mode body', async () => {
    expect((await POST(req('{"mode":"admin","profile":"../../default"}'), ctx)).status).toBe(400);
    expect(f.open).not.toHaveBeenCalled();
    const result = await POST(req('{"mode":"admin"}'), ctx);
    expect(await result.json()).toEqual({ conversationId: 'separate', state: 'connection_needed' });
    expect(f.open).toHaveBeenCalledWith({ user: { id: 'alice' } }, 'team', 'admin');
    expect(f.ensure).toHaveBeenCalledWith({ user: { id: 'alice' } }, 'team', 'admin');
    expect(result.headers.get('cache-control')).toContain('no-store');
  });
  it('bounds streamed JSON independently of Content-Length and checks type/parse errors', async () => {
    for (const handler of [PUT, POST]) {
      const huge = req(JSON.stringify({ padding: 'x'.repeat(33 * 1024) })); huge.headers.set('Content-Length', '1');
      expect((await handler(huge, ctx)).status).toBe(413);
      expect((await handler(req('{}', 'https://example.test', 'text/plain'), ctx)).status).toBe(415);
      expect((await handler(req('{'), ctx)).status).toBe(400);
    }
    expect(f.configure).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it('returns authorization rejection before native provisioning', async () => {
    f.open.mockRejectedValue(new HttpError(403, 'Admin only'));
    expect((await POST(req('{"mode":"admin"}'), ctx)).status).toBe(403); expect(f.ensure).not.toHaveBeenCalled();
  });
});
