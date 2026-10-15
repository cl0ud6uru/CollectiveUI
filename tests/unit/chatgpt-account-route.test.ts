import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ change: vi.fn(), begin: vi.fn(), cancel: vi.fn(), prepare: vi.fn(), legacy: vi.fn(), principal: { user: { id: 'alice' } } }));
vi.mock('@/lib/session', () => ({ requirePrincipal: vi.fn(async () => fixture.principal) }));
vi.mock('@/lib/llm/chatgpt/account', () => ({ changeUnifiedAccount: fixture.change, unifiedAccountView: vi.fn() }));
vi.mock('@/lib/llm/chatgpt/onboarding', () => ({ prepareAccountRuntime: fixture.prepare, prepareDeviceAccountRuntime: fixture.prepare }));
vi.mock('@/lib/llm/chatgpt/companion', () => ({ beginCompanionSignIn: fixture.begin, cancelCompanionSignIn: fixture.cancel }));
vi.mock('@/personal-codex/accounts', () => ({ changeConnection: fixture.legacy, connectionView: vi.fn() }));
import { POST as accountPost } from '@/app/api/me/chatgpt/route';
import { POST as legacyPost } from '@/app/api/me/codex/route';

const request = (body: unknown, origin = 'http://localhost') => new Request('http://localhost/api/me/chatgpt', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
beforeEach(() => { vi.stubEnv('AUTH_URL', 'http://localhost'); fixture.change.mockReset().mockResolvedValue({ instructions: 'Local setup', hostId: 'public-host', userId: 'alice' }); fixture.prepare.mockReset().mockResolvedValue({ prepared: true }); fixture.legacy.mockReset(); fixture.begin.mockReset().mockResolvedValue({ launchUrl: 'collectiveui-chatgpt://connect' }); fixture.cancel.mockReset().mockResolvedValue({ cancelled: true }); });
describe('unified account HTTP mutation boundary', () => {
  it('starts and cancels a sign-in for the authenticated owner with explicit consent', async () => {
    const input = { accepted: true, consentVersion: 1, enableCodex: false };
    expect((await accountPost(request({ action: 'begin-sign-in', ...input }))).status).toBe(200);
    expect(fixture.begin).toHaveBeenCalledWith(fixture.principal, input);
    expect((await accountPost(request({ action: 'cancel-sign-in' }))).status).toBe(200);
    expect(fixture.cancel).toHaveBeenCalledWith(fixture.principal);
  });
  it.each([
    { action: 'begin-sign-in', enableCodex: true },
    { action: 'begin-sign-in', accepted: true, consentVersion: 1, enableCodex: true, userId: 'bob' },
    { action: 'begin-sign-in', accepted: true, consentVersion: 1, enableCodex: false, accessToken: 'secret' },
    { action: 'cancel-sign-in', attemptId: 'foreign' },
  ])('rejects extra authority or missing sign-in consent', async body => {
    expect((await accountPost(request(body))).status).toBe(400);
    expect(fixture.begin).not.toHaveBeenCalled(); expect(fixture.cancel).not.toHaveBeenCalled();
  });
  it('disconnects only Native CollectiveUI through its distinct action', async () => {
    expect((await accountPost(request({ action: 'disconnect-native' }))).status).toBe(200);
    expect(fixture.change).toHaveBeenCalledWith(fixture.principal, 'disconnect-native');
    expect(fixture.legacy).not.toHaveBeenCalled();
  });
  it('derives the owner from the signed-in principal and accepts setup without credential material', async () => {
    const response = await accountPost(request({ action: 'start' }));
    expect(response.status).toBe(200);
    expect(fixture.change).toHaveBeenCalledWith(fixture.principal, 'start');
  });
  it.each([{ action: 'start', userId: 'bob' }, { action: 'sync-token', accessToken: 'synthetic-token' }, '{malformed'])('rejects claimed owners, browser token uploads and malformed input', async body => {
    expect((await accountPost(request(body))).status).toBe(400);
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutation before touching the account', async () => {
    expect((await accountPost(request({ action: 'disconnect' }, 'https://other.invalid'))).status).toBe(403);
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it('prepares only the signed-in owner with explicit versioned consent', async () => {
    expect((await accountPost(request({ action: 'prepare-runtime', accepted: true, consentVersion: 1 }))).status).toBe(200);
    expect(fixture.prepare).toHaveBeenCalledWith(fixture.principal, { accepted: true, consentVersion: 1 });
    expect(fixture.change).not.toHaveBeenCalled();
  });
  it.each([
    { action: 'prepare-runtime', consentVersion: 1 },
    { action: 'prepare-runtime', accepted: false, consentVersion: 1 },
    { action: 'prepare-runtime', accepted: true, consentVersion: 2 },
    { action: 'prepare-runtime', accepted: true, consentVersion: 1, userId: 'bob' },
    { action: 'prepare-runtime', accepted: true, consentVersion: 1, accessToken: 'synthetic-token' },
  ])('rejects preparation without exact consent or with extra authority', async body => {
    expect((await accountPost(request(body))).status).toBe(400);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it('rejects cross-origin consent before preparing any resources', async () => {
    expect((await accountPost(request({ action: 'prepare-runtime', accepted: true, consentVersion: 1 }, 'https://other.invalid'))).status).toBe(403);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it.each(['connect', 'confirm'])('rejects %s without explicit consent', async action => {
    expect((await legacyPost(request({ action }))).status).toBe(400);
    expect(fixture.legacy).not.toHaveBeenCalled();
  });
});
