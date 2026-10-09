import { beforeEach, expect, it, vi } from 'vitest';
import * as client from '@/lib/llm/providers/hermes/client';

const target = { baseUrl: 'https://hermes.test', profile: 'alice', apiKey: 'synthetic-key', fetch: vi.fn<typeof fetch>() };
const sessionId = 'portal-chat123-bot456';
let enabled = false;
let capability: unknown = true;
let identity: Record<string, unknown>;
let readback = true;
beforeEach(() => {
  enabled = false; capability = true; identity = {}; readback = true;
  target.fetch.mockReset().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/v1/capabilities')) return Response.json({ features: { session_approval_control: capability } });
    if (init?.method === 'PUT') {
      if (readback) enabled = JSON.parse(String(init.body)).enabled;
    }
    return Response.json({ session_id: sessionId, profile: 'alice', enabled, scope: 'session', ...identity });
  });
});
it('reads exact profile/session and verifies on and off after PUT, never config', async () => {
  expect(await client.sessionApprovalMode(target, sessionId)).toMatchObject({ enabled: false, scope: 'session' });
  expect(await client.sessionApprovalMode(target, sessionId, true)).toMatchObject({ enabled: true });
  expect(await client.sessionApprovalMode(target, sessionId, false)).toMatchObject({ enabled: false });
  const calls = target.fetch.mock.calls;
  expect(calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ enabled: true }, { enabled: false }]);
  for (const [url, init] of calls) {
    expect(String(url)).toMatch(/^https:\/\/hermes.test\/p\/alice\/v1\/(capabilities|sessions\/portal-chat123-bot456\/approval-mode)$/);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer synthetic-key' } });
  }
});
it.each([false, undefined, 'true', 1])('fails closed capability %s before session read or mutation', async value => {
  capability = value;
  await expect(client.sessionApprovalMode(target, sessionId, true)).rejects.toThrow();
  expect(target.fetch).toHaveBeenCalledTimes(1);
});
it.each([{ session_id: 'other' }, { profile: 'bob' }, { scope: 'profile' }, { enabled: 'false' }])('rejects bad identity/state before PUT: %j', async value => {
  identity = value;
  await expect(client.sessionApprovalMode(target, sessionId, true)).rejects.toThrow();
  expect(target.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
it('does not claim enabled after noncommitting PUT', async () => {
  readback = false;
  await expect(client.sessionApprovalMode(target, sessionId, true)).rejects.toThrow();
});
it('checks PUT identity as well as readback', async () => {
  target.fetch.mockImplementation(async (url, init) => String(url).endsWith('capabilities')
    ? Response.json({ features: { session_approval_control: true } })
    : Response.json({ session_id: sessionId, profile: init?.method === 'PUT' ? 'bob' : 'alice', scope: 'session', enabled: init?.method === 'PUT' }));
  await expect(client.sessionApprovalMode(target, sessionId, true)).rejects.toThrow();
});
it.each([{ ...target, profile: '' }, { ...target, local: true }])('refuses default/native transport without HTTP', async value => {
  await expect(client.sessionApprovalMode(value, sessionId, true)).rejects.toThrow();
  expect(target.fetch).not.toHaveBeenCalled();
});
it('keeps state remote across client recreation and separate sessions', async () => {
  const sessions = new Map<string, boolean>();
  const remoteFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('capabilities')) return Response.json({ features: { session_approval_control: true } });
    const id = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-2)!);
    if (init?.method === 'PUT') sessions.set(id, JSON.parse(String(init.body)).enabled);
    return Response.json({ session_id: id, profile: 'alice', enabled: sessions.get(id) ?? false, scope: 'session' });
  });
  await client.sessionApprovalMode({ ...target, fetch: remoteFetch }, sessionId, true);
  expect((await client.sessionApprovalMode({ ...target, fetch: remoteFetch }, sessionId)).enabled).toBe(true);
  expect((await client.sessionApprovalMode({ ...target, fetch: remoteFetch }, 'portal-fresh-bot456')).enabled).toBe(false);
  expect((await client.sessionApprovalMode({ ...target, fetch: remoteFetch }, 'portal-other-bot456')).enabled).toBe(false);
});
it('fails closed when GET readback becomes unreachable after a committed PUT', async () => {
  let committed = false;
  target.fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('capabilities')) return Response.json({ features: { session_approval_control: true } });
    if (committed) throw new Error('lost connection');
    if (init?.method === 'PUT') committed = true;
    return Response.json({ session_id: sessionId, profile: 'alice', enabled: committed, scope: 'session' });
  });
  await expect(client.sessionApprovalMode(target, sessionId, true)).rejects.toMatchObject({ code: 'unreachable' });
  expect(committed).toBe(true);
});
it('propagates active backend refusal and does not claim success', async () => {
  const original = target.fetch.getMockImplementation()!;
  target.fetch.mockImplementation((url, init) => init?.method === 'PUT' ? Promise.resolve(Response.json({ error: 'Active run' }, { status: 409 })) : original(url, init));
  await expect(client.sessionApprovalMode(target, sessionId, true)).rejects.toMatchObject({ status: 409 });
});
