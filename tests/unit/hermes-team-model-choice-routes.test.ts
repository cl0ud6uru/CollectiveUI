import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ principal: vi.fn(), view: vi.fn(), choice: vi.fn() }));
vi.mock('@/lib/session', async () => {
  const { HttpError } = await import('@/lib/authz');
  return { requirePrincipal: f.principal, errorResponse: (error: unknown) => Response.json({ error: error instanceof HttpError ? error.message : 'Unavailable' }, { status: error instanceof HttpError ? error.status : 500 }) };
});
vi.mock('@/lib/hermes-team/candidate-availability', () => ({ teamConversationModelView: f.view, setTeamConversationModelChoice: f.choice }));
import { GET, PUT } from '@/app/api/conversations/[id]/team/model/route';
import { HttpError } from '@/lib/authz';
const ctx = { params: Promise.resolve({ id: 'own-admin-conversation' }) };
const body = { modelChoice: 'personal', expectedChoice: 'default', expectedDefinitionVersion: 7 };
const request = (input: unknown = body, origin: string | null = 'https://example.test', type = 'application/json') => new Request('https://example.test/api/conversations/own-admin-conversation/team/model', {
  method: 'PUT', headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': type }, body: typeof input === 'string' ? input : JSON.stringify(input),
});
describe('private conversation model choice API', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('AUTH_URL', 'https://example.test'); f.principal.mockResolvedValue({ user: { id: 'alice' } }); f.view.mockResolvedValue({ modelChoice: 'default', connectAvailable: false }); f.choice.mockResolvedValue({ modelChoice: 'personal' }); });
  afterEach(() => vi.unstubAllEnvs());
  it('derives actor/conversation from the current request and disables caching', async () => {
    const result = await GET(new Request('https://example.test/api/conversations/own-admin-conversation/team/model'), ctx);
    expect(await result.json()).toEqual({ modelChoice: 'default', connectAvailable: false });
    expect(f.view).toHaveBeenCalledWith({ user: { id: 'alice' } }, 'own-admin-conversation');
    expect(result.headers.get('cache-control')).toContain('no-store');
    const saved = await PUT(request(), ctx);
    expect(await saved.json()).toEqual({ modelChoice: 'personal' });
    expect(f.choice).toHaveBeenCalledWith({ user: { id: 'alice' } }, 'own-admin-conversation', 'personal', { expectedChoice: 'default', expectedDefinitionVersion: 7 });
    expect(saved.headers.get('cache-control')).toContain('no-store');
  });
  it.each([null, 'https://attacker.test', 'https://example.test.attacker.test'])('rejects origin %s before reading the body', async origin => {
    const req = request(body, origin), reader = vi.spyOn(req.body!, 'getReader');
    expect((await PUT(req, ctx)).status).toBe(403); expect(reader).not.toHaveBeenCalled(); expect(f.principal).not.toHaveBeenCalled(); expect(f.choice).not.toHaveBeenCalled();
  });
  it('requires a live sign-in before read or mutation', async () => {
    f.principal.mockRejectedValue(new HttpError(401, 'Unauthorized'));
    expect((await GET(new Request('https://example.test/api/conversations/own-admin-conversation/team/model'), ctx)).status).toBe(401);
    const req = request(), reader = vi.spyOn(req.body!, 'getReader');
    expect((await PUT(req, ctx)).status).toBe(401); expect(reader).not.toHaveBeenCalled(); expect(f.view).not.toHaveBeenCalled(); expect(f.choice).not.toHaveBeenCalled();
  });
  it.each([{ ...body, profileId: '../../admin' }, { ...body, mode: 'admin' }, { ...body, routeId: 'paid-route' }, { ...body, userId: 'bob' }, { ...body, expectedChoice: undefined }, { ...body, expectedDefinitionVersion: 0 }, { ...body, modelChoice: 'provider-name' }])('accepts only an exact CAS choice body %j', async input => {
    expect((await PUT(request(input), ctx)).status).toBe(400); expect(f.choice).not.toHaveBeenCalled();
  });
  it('rejects query scope overrides, oversized streaming JSON, wrong type and malformed JSON', async () => {
    expect((await GET(new Request('https://example.test/api/conversations/own-admin-conversation/team/model?mode=admin'), ctx)).status).toBe(400);
    const huge = request({ padding: 'x'.repeat(33 * 1024) }); huge.headers.set('Content-Length', '1');
    expect((await PUT(huge, ctx)).status).toBe(413);
    expect((await PUT(request(body, 'https://example.test', 'text/plain'), ctx)).status).toBe(415);
    expect((await PUT(request('{'), ctx)).status).toBe(400);
    expect(f.view).not.toHaveBeenCalled(); expect(f.choice).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409])('preserves owner/mode/idle or stale rejection %s from the authoritative helper', async status => {
    f.choice.mockRejectedValue(new HttpError(status, 'Model choice needs a fresh authorized context.'));
    const result = await PUT(request(), ctx);
    expect(result.status).toBe(status); expect(await result.json()).toEqual({ error: 'Model choice needs a fresh authorized context.' });
  });
});
