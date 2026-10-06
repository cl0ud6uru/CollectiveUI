import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
const f = vi.hoisted(() => ({ principal: vi.fn(), view: vi.fn(), mutate: vi.fn() }));
vi.mock('@/lib/session', () => ({ requirePrincipal: f.principal }));
vi.mock('@/lib/authz', () => { class HttpError extends Error { constructor(public status: number, message: string) { super(message); } } return { HttpError }; });
vi.mock('@/lib/hermes-native/managed', () => ({ viewManagedNative: f.view, mutateManagedNative: f.mutate }));
// Exercise the real API body reader and origin helper, not a copy of their logic.
import { GET, POST } from '@/app/api/chat/[id]/native/route';
import { HttpError } from '@/lib/authz';
import { HermesError } from '@/lib/llm/providers/hermes/client';
const context = { params: Promise.resolve({ id: 'conversation' }) } as Parameters<typeof POST>[1];
const request = (body: string, origin: string | null = 'https://example.test', contentType = 'application/json') => new Request('https://example.test/api/chat/conversation/native', { method: 'POST', headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': contentType }, body });
const protectedValue = 'synthetic-protected-value-must-not-appear';
describe('managed native API boundaries', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('AUTH_URL', 'https://example.test'); f.principal.mockResolvedValue({ user: { id: 'owner' } }); f.mutate.mockResolvedValue({ accepted: true }); f.view.mockResolvedValue({ available: true, view: null }); });
  afterEach(() => vi.unstubAllEnvs());
  it('authenticates GET and POST and sets private no-store response headers', async () => {
    const get = await GET(new Request('https://example.test/api/chat/conversation/native'), context); expect(get.status).toBe(200); expect(get.headers.get('cache-control')).toBe('private, no-store');
    const post = await POST(request(JSON.stringify({ operation: 'answer', answer: { value: protectedValue } })), context); expect(post.status).toBe(200); expect(post.headers.get('cache-control')).toBe('private, no-store'); expect(f.principal).toHaveBeenCalledTimes(2);
    expect(f.mutate).toHaveBeenCalledWith({ user: { id: 'owner' } }, 'conversation', { operation: 'answer', answer: { value: protectedValue } });
  });
  it.each([null, 'https://attacker.example', 'https://example.test.attacker.example'])('rejects missing/foreign Origin %s before reading or dispatching protected values', async origin => {
    const response = await POST(request(JSON.stringify({ answer: { value: protectedValue } }), origin), context); expect(response.status).toBe(403); expect(await response.text()).not.toContain(protectedValue); expect(f.mutate).not.toHaveBeenCalled();
  });
  it('blocks both routes before dispatch for an unauthenticated principal', async () => {
    f.principal.mockRejectedValue(new HttpError(401, 'Unauthorized'));
    expect((await GET(new Request('https://example.test/api/chat/conversation/native'), context)).status).toBe(401); expect((await POST(request('{}'), context)).status).toBe(401); expect(f.view).not.toHaveBeenCalled(); expect(f.mutate).not.toHaveBeenCalled();
  });
  it('requires JSON, rejects malformed JSON and bounds bodies independently of Content-Length', async () => {
    expect((await POST(request('{}', 'https://example.test', 'text/plain'), context)).status).toBe(415);
    expect((await POST(request(`{"value":"${protectedValue}"`), context)).status).toBe(400);
    const oversized = request(JSON.stringify({ value: protectedValue, padding: 'x'.repeat(33 * 1024) })); oversized.headers.set('Content-Length', '1');
    const response = await POST(oversized, context); expect(response.status).toBe(413); expect(await response.text()).not.toContain(protectedValue); expect(f.mutate).not.toHaveBeenCalled();
  });
  it('cancels an oversized streamed body rather than reading the rest', async () => {
    const cancelled = vi.fn(); let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(40 * 1024)); }, cancel: cancelled });
    const streamed = new Request('https://example.test/api/chat/conversation/native', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect((await POST(streamed, context)).status).toBe(413); expect(cancelled).toHaveBeenCalledOnce(); expect(pulls).toBeLessThanOrEqual(2); expect(f.mutate).not.toHaveBeenCalled();
  });
  it('does not log or return arbitrary upstream exceptions that contain protected values', async () => {
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { f.mutate.mockRejectedValue(new Error(`upstream rejected ${protectedValue}`)); const response = await POST(request(JSON.stringify({ value: protectedValue })), context); expect(response.status).toBe(503); expect(await response.text()).not.toContain(protectedValue); expect(logging).not.toHaveBeenCalled(); }
    finally { logging.mockRestore(); }
  });
  it('does not reflect upstream HttpError subclasses carrying a protected value', async () => {
    f.mutate.mockRejectedValue(new HermesError('rejected', 409, protectedValue));
    const response = await POST(request(JSON.stringify({ value: protectedValue })), context);
    expect(response.status).toBe(409); expect(await response.text()).not.toContain(protectedValue);
  });
  it('sanitizes schema errors containing protected input without logging them', async () => {
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { f.mutate.mockRejectedValue(new z.ZodError([{ code: 'custom', path: ['answer'], message: protectedValue }])); const response = await POST(request(JSON.stringify({ value: protectedValue })), context); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Invalid native request.' }); expect(logging).not.toHaveBeenCalled(); }
    finally { logging.mockRestore(); }
  });
});
