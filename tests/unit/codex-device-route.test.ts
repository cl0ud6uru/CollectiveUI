import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ principal: { user: { id: 'local-user' } }, requirePrincipal: vi.fn(), view: vi.fn(), change: vi.fn(), prepare: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: fixture.requirePrincipal }));
vi.mock('@/personal-codex/accounts', () => ({ connectionView: fixture.view, changeConnection: fixture.change }));
vi.mock('@/lib/llm/chatgpt/onboarding', () => ({ prepareDeviceAccountRuntime: fixture.prepare }));
import { GET, POST } from '@/app/api/me/codex/route';
import { HttpError } from '@/lib/authz';
const request = (body: unknown, origin = 'https://portal.example.test', contentType = 'application/json') => new Request('https://portal.example.test/api/me/codex', {
  method: 'POST', headers: { origin, 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
beforeEach(() => {
  vi.stubEnv('AUTH_URL', 'https://portal.example.test');
  fixture.requirePrincipal.mockReset().mockResolvedValue(fixture.principal);
  fixture.view.mockReset().mockResolvedValue({ state: 'confirm', email: 'different@example.test', workspaceId: 'account-123' });
  fixture.change.mockReset().mockResolvedValue({ state: 'pending', login: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } });
  fixture.prepare.mockReset().mockResolvedValue({ prepared: true });
});
describe('browser stock Codex device sign-in routes', () => {
  it('gets a browser-safe status only for the authenticated owner', async () => {
    const response = await GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ state: 'confirm', email: 'different@example.test', workspaceId: 'account-123' });
    expect(fixture.view).toHaveBeenCalledWith(fixture.principal);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it('prepares resources with consent before beginning device authorization', async () => {
    const response = await POST(request({ action: 'connect', accepted: true, consentVersion: 1 }));
    expect(response.status).toBe(200);
    expect(fixture.prepare).toHaveBeenCalledWith(fixture.principal, { accepted: true, consentVersion: 1 });
    expect(fixture.change).toHaveBeenCalledWith(fixture.principal, 'connect');
    expect(fixture.prepare.mock.invocationCallOrder[0]).toBeLessThan(fixture.change.mock.invocationCallOrder[0]);
    expect(await response.json()).toEqual({ state: 'pending', login: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } });
  });
  it('passes an explicit reviewed identity snapshot to server verification', async () => {
    const expected = { email: 'different@example.test', workspaceId: 'account-123' };
    expect((await POST(request({ action: 'confirm', accepted: true, consentVersion: 1, expected }))).status).toBe(200);
    expect(fixture.change).toHaveBeenCalledWith(fixture.principal, 'confirm', expected);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'disconnect', 'start', 'refresh'])('handles owner-scoped %s without requesting new consent', async action => {
    expect((await POST(request({ action }))).status).toBe(200);
    expect(fixture.change).toHaveBeenCalledWith(fixture.principal, action);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it.each([
    { action: 'connect' }, { action: 'connect', accepted: false, consentVersion: 1 }, { action: 'connect', accepted: true, consentVersion: 2 },
    { action: 'connect', accepted: true, consentVersion: 1, userId: 'other' },
    { action: 'connect', accepted: true, consentVersion: 1, accessToken: 'secret' },
    { action: 'confirm' }, { action: 'confirm', accepted: true, consentVersion: 1 },
    { action: 'confirm', accepted: true, consentVersion: 1, expected: { email: 'reviewed@example.test', workspaceId: '123', userId: 'other' } },
    { action: 'cancel', loginId: 'other' }, '{malformed',
  ])('rejects missing consent, claimed authority, credential uploads and malformed bodies', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(fixture.change).not.toHaveBeenCalled(); expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it('rejects an untrusted origin before preparing or changing any connection', async () => {
    expect((await POST(request({ action: 'connect', accepted: true, consentVersion: 1 }, 'https://evil.example.test'))).status).toBe(403);
    expect(fixture.change).not.toHaveBeenCalled(); expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/jsonp'])('rejects content type %s', async contentType => {
    expect((await POST(request({ action: 'cancel' }, undefined, contentType))).status).toBe(415);
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it('limits the actual streamed body size', async () => {
    expect((await POST(request(' '.repeat(1025)))).status).toBe(413);
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it('does not begin login when resource preparation fails', async () => {
    fixture.prepare.mockRejectedValue(new HttpError(409, 'An operator must verify the stock sandbox before enrollment.'));
    const response = await POST(request({ action: 'connect', accepted: true, consentVersion: 1 }));
    expect(response.status).toBe(409); expect(fixture.change).not.toHaveBeenCalled();
  });
  it('keeps internal failures and credential material out of browser errors', async () => {
    fixture.change.mockRejectedValue(new Error('Bearer secret-token'));
    const response = await POST(request({ action: 'cancel' }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret-token');
  });
  it('does not read another owner when the browser has no session', async () => {
    fixture.requirePrincipal.mockRejectedValue(new HttpError(401, 'Sign in first.'));
    expect((await GET()).status).toBe(401);
    expect((await POST(request({ action: 'cancel' }))).status).toBe(401);
    expect(fixture.view).not.toHaveBeenCalled(); expect(fixture.change).not.toHaveBeenCalled();
  });
});
