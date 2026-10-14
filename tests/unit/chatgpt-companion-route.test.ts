import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ redeem: vi.fn(), challenge: vi.fn(), receive: vi.fn(), recover: vi.fn(), status: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/llm/chatgpt/companion', () => ({ redeemCompanion: f.redeem, challengeCompanion: f.challenge,
  receiveCompanion: f.receive, recoverCompanion: f.recover, companionNativeStatus: f.status, cancelNativeCompanion: f.cancel }));
import { POST } from '@/app/api/chatgpt/companion/route';
const attemptId = '123e4567-e89b-42d3-a456-426614174000';
const request = (body: unknown, extra: Record<string, string> = {}) => new Request('https://portal.invalid/api/chatgpt/companion', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Companion ${'r'.repeat(43)}`, ...extra }, body: JSON.stringify(body),
});
beforeEach(() => { Object.values(f).forEach(mock => mock.mockReset().mockResolvedValue({ state: 'paired' })); });
describe('native companion transport boundary', () => {
  it('passes only attempt identity and native capability and returns private responses', async () => {
    const r = await POST(request({ action: 'status', attemptId }));
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(f.status).toHaveBeenCalledWith(attemptId, `Companion ${'r'.repeat(43)}`);
  });
  it.each<Record<string, string>>([{ origin: 'https://portal.invalid' }, { origin: 'null' }, { cookie: 'session=synthetic' }, { 'sec-fetch-site': 'same-origin' }])('rejects browser and cookie transport before service access', async headers => {
    expect((await POST(request({ action: 'status', attemptId }, headers))).status).toBe(403); expect(f.status).not.toHaveBeenCalled();
  });
  it.each([{ action: 'status', attemptId, userId: 'bob' }, { action: 'status', attemptId, accessToken: 'secret' },
    { action: 'cancel', attemptId, input: {} }, { action: 'status', attemptId: 'not-uuid' }])('rejects unexpected browser authority and raw credentials', async body => {
    expect((await POST(request(body))).status).toBe(400); Object.values(f).forEach(mock => expect(mock).not.toHaveBeenCalled());
  });
  it('bounds request bytes and does not reflect private error text', async () => {
    expect((await POST(request({ action: 'receive', attemptId, input: 'x'.repeat(129000) }))).status).toBe(413);
    f.status.mockRejectedValue(new Error('synthetic-token-sensitive-text'));
    const response = await POST(request({ action: 'status', attemptId }));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('synthetic-token');
  });
  it('supports scoped pre-custody cancellation without browser cookies', async () => {
    f.cancel.mockResolvedValue({ cancelled: true });
    expect((await POST(request({ action: 'cancel', attemptId }))).status).toBe(200);
    expect(f.cancel).toHaveBeenCalledWith(attemptId, `Companion ${'r'.repeat(43)}`);
  });
});
