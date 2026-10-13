import { mkdtemp, readFile, stat, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readProtectedSIWCProfile, refreshSIWCTokens, revokeSIWCTokens, signInSIWC, validateSIWCCredential } from '@/lib/llm/chatgpt/siwc';

const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const clientId = 'issued-siwc-client', hostId = 'urn:uuid:8d3fb414-0eb5-4b67-8a54-b3131b198e21', subject = 'verified-subject', email = 'owner@example.test';
let privateKey: CryptoKey, jwk: JWK, directory: string;

async function signed(payload: Record<string, unknown>, aud: string) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'unit-kid', typ: 'JWT' })
    .setIssuer('https://auth.openai.com').setAudience(aud).setSubject(subject).setIssuedAt().setNotBefore('0s').setExpirationTime('1h').sign(privateKey);
}
async function tokenReply(nonce: string) {
  const common = { scope: scopes, client_id: clientId };
  return { token_type: 'Bearer', expires_in: 3600, scope: scopes,
    id_token: await signed({ nonce, email }, clientId),
    access_token: await signed({ ...common, nbf: Math.floor(Date.now() / 1000), scope: scopes }, 'https://api.openai.com/v1'),
    refresh_token: 'synthetic-refresh' };
}
function json(data: unknown, mime = 'application/json') { return new Response(JSON.stringify(data), { headers: { 'content-type': mime } }); }

beforeAll(async () => {
  const pair = await generateKeyPair('RS256'); privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'unit-kid', alg: 'RS256', use: 'sig' };
  directory = await mkdtemp(join(tmpdir(), 'siwc-test-'));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('local SIWC credential helper', () => {
  it('uses the documented dynamic registration and saves validated tokens privately', async () => {
    const output = join(directory, 'credential.json'); let authUrl: URL | undefined;
    let nonce = '';
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('client_id')).toBe(clientId); expect(form.get('resource')).toBe('https://api.openai.com/v1');
        expect(form.get('code_verifier')).toBeTruthy(); expect(form.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
        return json(await tokenReply(nonce));
      }
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') return json({ issuer: 'https://auth.openai.com',
        authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
        jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', id_token_signing_alg_values_supported: ['RS256'] });
      if (url === 'https://auth.openai.com/.well-known/jwks.json') return json({ keys: [jwk] }, 'application/jwk-set+json');
      throw new Error('unexpected endpoint');
    };
    const credential = await signInSIWC({ hostId, outputPath: output, fetcher, timeoutMs: 3000, openBrowser: async raw => {
      authUrl = new URL(raw); nonce = authUrl.searchParams.get('nonce')!;
      expect(authUrl.origin).toBe('https://auth.openai.com');
      expect(authUrl.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(authUrl.searchParams.get('ext_agent_host_id')).toBe(hostId);
      expect(authUrl.searchParams.get('agent_name_hint')).toBe('collective_ui');
      expect(authUrl.searchParams.get('scope')).toBe(scopes);
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: authUrl.searchParams.get('state')!, code: 'one-use-code', client_id: clientId }).toString();
      const response = await fetch(callback);
      expect(response.status).toBe(200);
    } });
    expect(authUrl).toBeDefined();
    expect(credential).toMatchObject({ kind: 'siwc', version: 1, clientId, hostId, refreshToken: 'synthetic-refresh' });
    const file = JSON.parse(await readFile(output, 'utf8'));
    expect(file.accessToken).toBe(credential.accessToken);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(await readProtectedSIWCProfile(output)).toEqual(file);
    const identity = await validateSIWCCredential(file, { hostId }, fetcher);
    expect(identity).toEqual({ subject, email, clientId, expiresAt: expect.any(Date) });
    await expect(validateSIWCCredential(file, { hostId: 'different-host' }, fetcher)).rejects.toThrow();
  });

  it('rejects an incomplete scope grant before writing credentials', async () => {
    const output = join(directory, 'bad.json');
    const fetcher: typeof fetch = async input => String(input).endsWith('oauth/token') ? json(await tokenReply('n').then(t => ({ ...t, scope: 'openid profile' })))
      : String(input).endsWith('openid-configuration') ? json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' }) : json({ keys: [jwk] }, 'application/jwk-set+json');
    await expect(signInSIWC({ hostId, outputPath: output, fetcher, timeoutMs: 3000, openBrowser: async raw => {
      const url = new URL(raw), callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'one-use-code', client_id: clientId }).toString();
      await fetch(callback);
    } })).rejects.toThrow();
    await expect(stat(output)).rejects.toThrow();
  });

  it('reauthorizes an existing registration with its retained issued client ID and same subject', async () => {
    const existing = { version: 1 as const, kind: 'siwc' as const, clientId, hostId, accessToken: 'old-access', refreshToken: 'old-refresh',
      idToken: await signed({ email }, clientId), scope: scopes, createdAt: new Date().toISOString() };
    const output = join(directory, 'reconnected.json'); let nonce = '';
    const fetcher: typeof fetch = async input => {
      const url = String(input);
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') return json(await tokenReply(nonce));
      if (url.endsWith('openid-configuration')) return json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', id_token_signing_alg_values_supported: ['RS256'] });
      return json({ keys: [jwk] }, 'application/jwk-set+json');
    };
    const result = await signInSIWC({ hostId, existing, outputPath: output, fetcher, timeoutMs: 3000, openBrowser: async raw => {
      const url = new URL(raw); nonce = url.searchParams.get('nonce')!;
      expect(url.searchParams.get('client_id')).toBe(clientId); expect(url.searchParams.has('agent_name_hint')).toBe(false);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'another-code' }).toString();
      expect((await fetch(callback)).status).toBe(200);
    } });
    expect(result.clientId).toBe(clientId);
    expect(JSON.parse(await readFile(output, 'utf8')).idToken).not.toBe(existing.idToken);
  });

  it('refreshes with the issued client ID and required resource without a scope parameter', async () => {
    let form: URLSearchParams | undefined;
    const accessToken = await signed({ client_id: clientId, scope: scopes, nbf: Math.floor(Date.now() / 1000) }, 'https://api.openai.com/v1');
    const idToken = await signed({ email }, clientId);
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('oauth/token')) { form = new URLSearchParams(String(init?.body)); return json({ access_token: accessToken, refresh_token: 'next-refresh', id_token: idToken, token_type: 'Bearer', expires_in: 1200, scope: scopes }); }
      if (url.endsWith('openid-configuration')) return json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', id_token_signing_alg_values_supported: ['RS256'] });
      return json({ keys: [jwk] }, 'application/jwk-set+json');
    };
    const result = await refreshSIWCTokens('refresh-secret', clientId, fetcher);
    expect(result).toMatchObject({ ok: true, tokens: { accessToken, refreshToken: 'next-refresh', idToken } });
    expect(String(form?.get('client_id'))).toBe(clientId); expect(form?.get('resource')).toBe('https://api.openai.com/v1');
    expect(form?.has('scope')).toBe(false);
  });

  it('classifies terminal refresh errors and preserves a rotated token on malformed success', async () => {
    const expired = await refreshSIWCTokens('old-refresh', clientId, async () => new Response(JSON.stringify({ error: 'refresh_token_reused' }),
      { status: 400, headers: { 'content-type': 'application/json' } }));
    expect(expired).toEqual({ ok: false, permanent: true, reason: 'refresh_token_reused' });
    const rotated = await refreshSIWCTokens('old-refresh', clientId, async () => json({ access_token: '', refresh_token: 'new-rotated' }));
    expect(rotated).toEqual({ ok: false, permanent: false, reason: 'malformed_response', rotatedRefreshToken: 'new-rotated' });
  });

  it('refuses symlinked profile files and revokes through validated official discovery', async () => {
    const target = join(directory, 'profile-target.json'), link = join(directory, 'profile-link.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(target, '{}', { mode: 0o600 }));
    await symlink(target, link);
    await expect(readProtectedSIWCProfile(link)).rejects.toThrow();
    await chmod(target, 0o600);
    const calls: Array<{ url: string; body?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input); calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') return json({ issuer: 'https://auth.openai.com',
        authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
        jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
      return new Response(null, { status: 200 });
    };
    expect(await revokeSIWCTokens({ refreshToken: 'refresh-secret', accessToken: 'access-secret', clientId }, fetcher)).toBe(true);
    expect(calls[1].url).toBe('https://auth.openai.com/api/accounts/oauth/revoke');
    expect(new URLSearchParams(calls[1].body).get('client_id')).toBe(clientId);
    expect(new URLSearchParams(calls[1].body).get('token')).toBe('refresh-secret');
    expect(new URLSearchParams(calls[1].body).get('token_type_hint')).toBe('refresh_token');
  });
});
