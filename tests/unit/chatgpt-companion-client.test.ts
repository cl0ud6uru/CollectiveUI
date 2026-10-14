import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { parseLaunch, exactOrigin, CompanionTransport, runCompanion } from '@/chatgpt-companion/client';
import type { LocalCompanionStore } from '@/lib/hermes-team/official-plan-local-companion';
const origin = 'https://collective.example', attempt = randomUUID(), token = 't'.repeat(43);
const launch = (o = origin) => `collectiveui-chatgpt://connect?origin=${encodeURIComponent(o)}&attempt=${attempt}&ticket=${token}`;
class MemoryStore implements LocalCompanionStore { values = new Map<string, unknown>(); writes: string[] = []; async read(n: string) { return this.values.get(n) ?? null; } async write(n: string, v: unknown) { this.writes.push(n); this.values.set(n, v); } async locked<T>(op: () => Promise<T>) { return op(); } async isLocked() { return false; } }
const keys = (kind: 'ed25519' | 'x25519') => (kind === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('x25519')).publicKey.export({ format: 'pem', type: 'spki' }).toString();
describe('native companion launch and transport', () => {
  it('requires exact packaged HTTPS origins and a fixed launch shape', () => {
    expect(parseLaunch(launch(), [origin])).toEqual({ origin, attemptId: attempt, launchToken: token });
    for (const value of ['http://collective.example','https://user@collective.example','https://collective.example/path','https://collective.example/','https://collective.example?return=evil']) expect(() => exactOrigin(value)).toThrow();
    for (const value of [launch('https://evil.example'), `${launch()}&origin=${encodeURIComponent(origin)}`, `${launch()}&return=https://evil.example`, launch().replace('connect?', 'connect/path?'), launch().replace(token, 'short')]) expect(() => parseLaunch(value, [origin])).toThrow();
  });
  it('sends companion capabilities only in Authorization, omits cookies/origin, refuses redirects and oversized JSON', async () => {
    const fetcher = vi.fn(async () => Response.json({ state: 'paired' }));
    const t = new CompanionTransport(origin, fetcher as typeof fetch); await t.request({ action: 'status', attemptId: attempt }, token);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${origin}/api/chatgpt/companion`); expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(options.headers).toMatchObject({ authorization: `Companion ${token}` }); expect(options.headers).not.toHaveProperty('origin'); expect(options.body).not.toContain(token);
    await expect(new CompanionTransport(origin, (async () => new Response('x'.repeat(128001), { headers: { 'content-type': 'application/json' } })) as typeof fetch).request({})).rejects.toThrow();
    await expect(new CompanionTransport(origin, (async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } })) as typeof fetch).request({})).rejects.toThrow();
  });
  it('persists stable host and source key before redemption and does not sign in before native confirmation', async () => {
    const globalStore = new MemoryStore(), store = new MemoryStore(), seen: unknown[] = [];
    const openBrowser = vi.fn(), returnToApp = vi.fn(), confirm = vi.fn(async () => false); let cancelled = false;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); seen.push(body);
      if (body.action === 'status') return Response.json({ state: cancelled ? 'cancelled' : 'paired' });
      if (body.action === 'cancel') { cancelled = true; return Response.json({ cancelled: true }); }
      expect(store.values.has('source.json')).toBe(true); expect(globalStore.values.has('host.json')).toBe(true);
      return Response.json({ returnToken: 'r'.repeat(43), origin, ownerId: 'alice', email: 'alice@example.test', expiresAt: Date.now() + 600000,
        pairing: { version: 1, pairingId: attempt, appOwnerId: 'alice', sourceHostId: body.sourceHostId, sourceSigningPublicKey: body.sourceSigningPublicKey,
          receiverHostId: `urn:uuid:${randomUUID()}`, receiverSigningPublicKey: keys('ed25519'), receiverEncryptionPublicKey: keys('x25519'), approvedUntil: Date.now() + 86400000 } });
    });
    const options = { approvedOrigins: [origin], globalStore, attemptStore: () => store, confirm, openBrowser, returnToApp, fetcher: fetcher as typeof fetch };
    expect(await runCompanion(launch(), options)).toEqual({ connected: false }); expect(confirm).toHaveBeenCalledWith(origin, 'alice@example.test');
    expect(openBrowser).not.toHaveBeenCalled(); expect(returnToApp).not.toHaveBeenCalled(); expect(seen.map(v => (v as {action:string}).action)).toEqual(['redeem','status','cancel']);
    await expect(runCompanion(launch(), options)).rejects.toThrow(); expect(confirm).toHaveBeenCalledTimes(1); expect(store.writes.filter(n => n === 'source.json')).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: 'redeem', attemptId: attempt, launchToken: token, signature: expect.any(String) });
  });
  it('failed redemption retry keeps exactly the same persisted key', async () => {
    const globalStore = new MemoryStore(), store = new MemoryStore(), bodies: unknown[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); throw new Error('synthetic failure'); });
    const options = { approvedOrigins: [origin], globalStore, attemptStore: () => store, confirm: async () => false, openBrowser: async () => {}, returnToApp: async () => {}, fetcher: fetcher as typeof fetch };
    await expect(runCompanion(launch(), options)).rejects.toThrow(); await expect(runCompanion(launch(), options)).rejects.toThrow(); expect(bodies[1]).toEqual(bodies[0]);
  });
});
