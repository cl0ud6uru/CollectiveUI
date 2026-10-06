import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { DashboardClient } from '@/lib/remote-hermes/client';
import { assertRemoteHermesAdmission, assertRemoteHermesOperation, dashboardBase, remoteHermesSettingsSchema } from '@/lib/remote-hermes/policy';
import { dashboardFetch } from '@/lib/remote-hermes/transport';

const disabled = { enabled: false, privateGateways: [] };
describe('personal remote Hermes admission', () => {
  it('blocks new work while allowing the owner to answer and stop admitted runs', () => {
    const binding = { ownerId: 'u1', userId: 'u1', status: 'waiting' as const };
    expect(() => assertRemoteHermesAdmission(disabled)).toThrow('disabled');
    expect(() => assertRemoteHermesOperation(disabled, 'start', binding)).toThrow('disabled');
    expect(() => assertRemoteHermesOperation(disabled, 'continue', binding)).not.toThrow();
    expect(() => assertRemoteHermesOperation(disabled, 'stop', binding)).not.toThrow();
    expect(() => assertRemoteHermesOperation(disabled, 'continue', { ...binding, userId: 'u2' })).toThrow('not found');
    expect(() => assertRemoteHermesOperation(disabled, 'continue', { ...binding, status: 'completed' })).toThrow('finished');
  });
  it('preserves path prefixes and rejects URLs with embedded credentials or query strings', () => {
    expect(dashboardBase('https://example.com/hermes/api/status/')).toBe('https://example.com/hermes');
    expect(() => dashboardBase('https://user:password@example.com')).toThrow();
    expect(() => dashboardBase('https://example.com?token=secret')).toThrow();
    expect(() => dashboardBase('file:///etc/passwd')).toThrow();
    expect(remoteHermesSettingsSchema.parse({ enabled: true, privateGateways: ['http://hermes:9119/', 'http://hermes:9119'] }).privateGateways).toEqual(['http://hermes:9119']);
  });
});

describe('remote dashboard transport', () => {
  it('blocks private destinations until explicitly approved, public HTTP and metadata even when approved', async () => {
    await expect(dashboardFetch('http://127.0.0.1:9119', disabled)('http://127.0.0.1:9119/api/status')).rejects.toThrow('approve');
    await expect(dashboardFetch('http://8.8.8.8', disabled)('http://8.8.8.8/api/status')).rejects.toThrow('HTTPS');
    for (const base of ['http://169.254.169.254', 'http://[::ffff:a9fe:a9fe]']) {
      await expect(dashboardFetch(base, { enabled: true, privateGateways: [base] })(base + '/api/status')).rejects.toThrow('blocked');
    }
  });
  it('pins an approved loopback connection, carries auth and does not follow redirects', async () => {
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer scoped-token');
      res.writeHead(302, { Location: 'http://169.254.169.254/secret' }); res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/hermes`;
    try {
      const transport = dashboardFetch(base, { enabled: true, privateGateways: [base] });
      const res = await transport(base + '/api/status', { headers: { Authorization: 'Bearer scoped-token' } });
      expect(res.status).toBe(302); await res.body?.cancel();
      await expect(transport(`http://127.0.0.1:${address.port}/outside`)).rejects.toThrow('outside');
      await expect(transport('http://169.254.169.254/secret')).rejects.toThrow('outside');
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});

function passwordGateway(mismatch = false) {
  let challenge = ''; let state = '';
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push({ url: String(input), init });
    switch (url.pathname) {
      case '/hermes/api/auth/providers': return Response.json({ providers: [{ name: 'basic', supports_password: true }] });
      case '/hermes/auth/native/authorize':
        challenge = url.searchParams.get('code_challenge')!; state = url.searchParams.get('state')!;
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(init.redirect).toBe('manual');
        return new Response(null, { status: 302, headers: { 'Set-Cookie': 'hermes_native=attempt; HttpOnly; Path=/', Location: '/login' } });
      case '/hermes/auth/password-login':
        expect(new Headers(init.headers).get('Cookie')).toBe('hermes_native=attempt');
        expect(JSON.parse(String(init.body))).toEqual({ provider: 'basic', username: 'alice', password: 'temporary-password' });
        return Response.json({ ok: true, next: `http://127.0.0.1:1/callback?code=one-use&state=${mismatch ? 'wrong' : state}` });
      case '/hermes/auth/native/token': {
        const body = JSON.parse(String(init.body));
        expect(body.code).toBe('one-use');
        expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
        expect(new Headers(init.headers).has('Cookie')).toBe(false);
        return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: 2000000000 });
      }
      default: throw new Error('Unexpected endpoint');
    }
  }) as unknown as typeof fetch;
  return { transport, calls };
}

describe('Hermes native dashboard authentication', () => {
  it('uses PKCE with attempt-local cookies and returns tokens without retaining passwords', async () => {
    const { transport, calls } = passwordGateway();
    const result = await new DashboardClient('https://example.com/hermes', transport).passwordLogin('alice', 'temporary-password');
    expect(result).toMatchObject({ mode: 'password', accessToken: 'access-secret', refreshToken: 'refresh-secret', provider: 'basic' });
    expect(JSON.stringify(result)).not.toContain('temporary-password');
    expect(calls).toHaveLength(4);
    expect(calls.every(c => c.url.startsWith('https://example.com/hermes/'))).toBe(true);
  });
  it('rejects a substituted callback before exchanging credentials', async () => {
    const { transport, calls } = passwordGateway(true);
    await expect(new DashboardClient('https://example.com/hermes', transport).passwordLogin('alice', 'temporary-password')).rejects.toThrow('invalid sign-in callback');
    expect(calls).toHaveLength(3);
  });
  it('projects profile metadata and discards native paths and unexpected fields', async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-secret');
      return Response.json({ profiles: [{ name: 'alice', model: 'test-model', bot_title: 'Alice bot', path: '/home/secret', env: 'secret' }] });
    }) as unknown as typeof fetch;
    expect(await new DashboardClient('https://example.com', transport, { mode: 'password', accessToken: 'access-secret' }).profiles()).toEqual([{ name: 'alice', model: 'test-model', botTitle: 'Alice bot' }]);
  });
  it('refreshes native tokens without returning the old refresh token when rotation succeeds', async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'old-refresh', provider: 'basic' });
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 2000000000 });
    }) as unknown as typeof fetch;
    const result = await new DashboardClient('https://example.com', transport, { mode: 'password', accessToken: 'old-access', refreshToken: 'old-refresh', provider: 'basic' }).refresh();
    expect(result.refreshToken).toBe('new-refresh');
  });
  it('does not expose upstream error bodies containing credentials', async () => {
    const transport = vi.fn(async () => Response.json({ error: 'access-secret temporary-password' }, { status: 401 })) as unknown as typeof fetch;
    await expect(new DashboardClient('https://example.com', transport).status()).rejects.toThrow('Hermes rejected');
    await expect(new DashboardClient('https://example.com', transport).status()).rejects.not.toThrow('access-secret');
  });
  it('explains login pages returned instead of dashboard JSON', async () => {
    const transport = vi.fn(async () => new Response('<html>Sign in</html>')) as unknown as typeof fetch;
    await expect(new DashboardClient('https://example.com', transport).status()).rejects.toThrow('page instead of JSON');
  });
});


describe('Hermes pinned conversation backfill', () => {
  it('preserves older pinned entries appended beyond the requested recent page', async () => {
    const sessions = Array.from({ length: 101 }, (_, i) => ({ id: `session-${i}`, title: `Synthetic ${i}` }));
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get('limit')).toBe('100');
      return Response.json({ sessions });
    }) as unknown as typeof fetch;
    const result = await new DashboardClient('https://example.com', transport, { mode: 'sessionToken', sessionToken: 'synthetic' }).sessions('default');
    expect(result).toEqual(sessions); expect(result.at(-1)?.id).toBe('session-100');
  });
  it('still bounds oversized session collections', async () => {
    const transport = (async () => Response.json({ sessions: Array.from({ length: 2001 }, (_, i) => ({ id: `session-${i}` })) })) as typeof fetch;
    await expect(new DashboardClient('https://example.com', transport).sessions('default')).rejects.toThrow();
  });
});
