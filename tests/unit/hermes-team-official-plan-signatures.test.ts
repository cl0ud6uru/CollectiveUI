import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createOfficialPlanVerifier } from '@/lib/hermes-team/official-plan-signatures';

const ISSUER = 'https://auth.openai.com', AUDIENCE = 'https://api.openai.com/v1';
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`, JWKS = `${ISSUER}/.well-known/jwks.json`;
const NOW = 1_790_032_532;
const metadata = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
  token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: JWKS,
  id_token_signing_alg_values_supported: ['RS256'], revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke` };
let keys: Awaited<ReturnType<typeof generateKeyPair>>, attacker: Awaited<ReturnType<typeof generateKeyPair>>, jwk: JWK;
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true }); attacker = await generateKeyPair('RS256');
  jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig', key_ops: ['verify'] };
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
  vi.stubGlobal('fetch', () => { throw new Error('Live network is forbidden in signature fixtures'); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const access = (): JWTPayload => ({ iss: ISSUER, aud: AUDIENCE, sub: 'synthetic-subject', client_id: 'synthetic-client',
  scope: 'chatgpt.tokens.use.direct resource.invoke openid offline_access', iat: NOW, nbf: NOW, exp: NOW + 3600,
  'https://api.openai.com/auth': { per_user_salt: 'opaque', encrypted_auth_metadata: 'opaque' } });
const id = (): JWTPayload => ({ iss: ISSUER, aud: 'synthetic-client', sub: 'synthetic-subject',
  iat: NOW, exp: NOW + 3600, nonce: 'synthetic-nonce' });
const sign = (payload: JWTPayload, header: Record<string, unknown> = {}) => new SignJWT(payload)
  .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT', ...header }).sign(keys.privateKey);
function transport(discovery: unknown = metadata, set: unknown = { keys: [jwk] }) {
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(new Headers(init?.headers).get('authorization')).toBeNull(); expect(init?.body).toBeUndefined();
    expect(init?.signal?.aborted).toBe(false);
    if (String(url) === DISCOVERY) return Response.json(discovery);
    if (String(url) === JWKS) return Response.json(set);
    throw new Error('Only fixed public discovery endpoints are permitted');
  });
}

describe('official plan signatures with generated keys and synthetic discovery only', () => {
  it('verifies an access signature and normalizes signed NumericDates without exposing opaque metadata', async () => {
    const fetcher = transport(), verifier = createOfficialPlanVerifier(fetcher);
    expect(await verifier.verifyAccessToken(await sign(access(), { typ: 'at+jwt' }))).toEqual({ issuer: ISSUER, audience: AUDIENCE,
      subject: 'synthetic-subject', clientId: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct', 'resource.invoke', 'openid', 'offline_access'],
      issuedAt: NOW * 1000, notBefore: NOW * 1000, expiresAt: (NOW + 3600) * 1000 });
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([DISCOVERY, JWKS]);
    expect(fetcher.mock.calls.every(call => call[1]?.signal?.aborted)).toBe(true);
  });

  it('rejects a valid-looking forged token and tampered signed claims', async () => {
    const fetcher = transport(), verifier = createOfficialPlanVerifier(fetcher);
    const forged = await new SignJWT(access()).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(attacker.privateKey);
    await expect(verifier.verifyAccessToken(forged)).rejects.toThrow('Official token verification failed.');
    const token = await sign(access()), parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...access(), sub: 'another-person' })).toString('base64url');
    await expect(verifier.verifyAccessToken(parts.join('.'))).rejects.toThrow('Official token verification failed.');
    expect(fetcher).toHaveBeenCalledTimes(4); // No signature fallback or retry.
  });

  it.each(['none', 'HS256', 'ES256', 'RS512'])('rejects unsupported %s before public transport', async alg => {
    const fetcher = transport(), token = `${Buffer.from(JSON.stringify({ alg, kid: 'fixture-key' })).toString('base64url')}.${Buffer.from(JSON.stringify(access())).toString('base64url')}.AAAA`;
    await expect(createOfficialPlanVerifier(fetcher).verifyAccessToken(token)).rejects.toThrow('Official token verification failed.');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['jku', 'jwk', 'x5u', 'crit'])('rejects untrusted %s hints without fetching a token-selected key', async field => {
    const fetcher = transport(), token = (await sign(access())).split('.');
    token[0] = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key', [field]: field === 'crit' ? ['unverified'] : 'https://attacker.test.invalid/keys' })).toString('base64url');
    await expect(createOfficialPlanVerifier(fetcher).verifyAccessToken(token.join('.'))).rejects.toThrow('Official token verification failed.');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { iss: 'https://attacker.test.invalid' }, { aud: 'another-resource' }, { aud: [AUDIENCE, 'another-resource'] },
    { sub: '' }, { client_id: '' }, { client_id: 'x'.repeat(257) }, { scope: undefined }, { iat: undefined }, { exp: undefined }, { nbf: undefined },
    { iat: NOW + 61 }, { nbf: NOW + 1 }, { exp: NOW }, { exp: NOW + 3661 }, { iat: NOW + 0.5 }, { nbf: NOW + 0.5 },
    { exp: Number.MAX_SAFE_INTEGER }, { scope: 'openid resource.invoke' }, { scope: 'chatgpt.tokens.use.direct' },
    { scope: 'chatgpt.tokens.use.direct resource.invoke resource.invoke' }, { scope: ['chatgpt.tokens.use.direct', 'resource.invoke'] },
    { scope: 'chatgpt.tokens.use.direct\nresource.invoke' }, { scope: 'chatgpt.tokens.use.direct resource.invoke ü' },
  ])('rejects incompatible signed access claims %#', async patch => {
    await expect(createOfficialPlanVerifier(transport()).verifyAccessToken(await sign({ ...access(), ...patch }))).rejects.toThrow('Official token verification failed.');
  });

  it('verifies callback nonce and refresh subject separately', async () => {
    const verifier = createOfficialPlanVerifier(transport()), token = await sign(id());
    expect(await verifier.verifyIdToken(token, { clientId: 'synthetic-client', nonce: 'synthetic-nonce' })).toEqual({ subject: 'synthetic-subject' });
    expect(await verifier.verifyIdToken(token, { clientId: 'synthetic-client', subject: 'synthetic-subject' })).toEqual({ subject: 'synthetic-subject' });
    for (const expected of [{ clientId: 'synthetic-client' }, { clientId: 'synthetic-client', nonce: 'wrong' },
      { clientId: 'synthetic-client', subject: 'wrong' }, { clientId: 'another-client', nonce: 'synthetic-nonce' }])
      await expect(verifier.verifyIdToken(token, expected)).rejects.toThrow('Official token verification failed.');
  });

  it('requires the authorized party for multiple ID audiences', async () => {
    const verifier = createOfficialPlanVerifier(transport());
    for (const azp of [undefined, 'another-client']) await expect(verifier.verifyIdToken(await sign({ ...id(), aud: ['synthetic-client', 'another-client'], azp }),
      { clientId: 'synthetic-client', nonce: 'synthetic-nonce' })).rejects.toThrow('Official token verification failed.');
    expect(await verifier.verifyIdToken(await sign({ ...id(), aud: ['synthetic-client', 'another-client'], azp: 'synthetic-client' }),
      { clientId: 'synthetic-client', nonce: 'synthetic-nonce' })).toEqual({ subject: 'synthetic-subject' });
  });

  it.each([{ exp: NOW }, { iat: NOW + 61 }, { iat: undefined }, { sub: '' }, { nonce: undefined }, { nbf: NOW + 1 }, { exp: NOW + 0.5 }])
    ('rejects expired, malformed or incomplete signed ID claims %#', async patch => {
      await expect(createOfficialPlanVerifier(transport()).verifyIdToken(await sign({ ...id(), ...patch }),
        { clientId: 'synthetic-client', nonce: 'synthetic-nonce' })).rejects.toThrow('Official token verification failed.');
    });

  it.each(['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'])('rejects a changed discovery %s before loading keys', async field => {
    const fetcher = transport({ ...metadata, [field]: 'https://attacker.test.invalid/config' });
    await expect(createOfficialPlanVerifier(fetcher).verifyAccessToken(await sign(access()))).rejects.toThrow('Official token verification failed.');
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([DISCOVERY]);
  });

  it('refreshes the bounded key set for each verification and accepts a fresh signing key', async () => {
    const second = await generateKeyPair('RS256'), replacement = { ...await exportJWK(second.publicKey), kid: 'replacement', alg: 'RS256' };
    const set = { keys: [jwk] }, fetcher = transport(metadata, set), verifier = createOfficialPlanVerifier(fetcher);
    await verifier.verifyAccessToken(await sign(access())); set.keys = [replacement];
    await expect(verifier.verifyAccessToken(await sign(access()))).rejects.toThrow('Official token verification failed.');
    const token = await new SignJWT(access()).setProtectedHeader({ alg: 'RS256', kid: 'replacement' }).sign(second.privateKey);
    expect((await verifier.verifyAccessToken(token)).subject).toBe('synthetic-subject'); expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each([() => [], () => [jwk, jwk], () => Array.from({ length: 17 }, (_, i) => ({ ...jwk, kid: `key-${i}` })),
    () => [{ ...jwk, use: 'enc' }], () => [{ ...jwk, kty: 'oct', k: 'synthetic' }], () => [{ ...jwk, d: 'synthetic-private-key' }],
    () => [{ ...jwk, n: Buffer.alloc(256, 1).toString('base64url') }], () => [{ ...jwk, key_ops: ['sign'] }]])
    ('rejects unsupported or ambiguous key sets %#', async keySet => {
      await expect(createOfficialPlanVerifier(transport(metadata, { keys: keySet() })).verifyAccessToken(await sign(access()))).rejects.toThrow('Official token verification failed.');
    });

  it('returns only the trusted discovered revocation path after checking all discovery pins', async () => {
    const fetcher = transport({ ...metadata, revocation_endpoint: `${ISSUER}/another-reviewed-revocation-path` });
    expect(await createOfficialPlanVerifier(fetcher).revocationEndpoint()).toBe(`${ISSUER}/another-reviewed-revocation-path`);
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([DISCOVERY]);
  });
  it.each([undefined, 'http://auth.openai.com/revoke', 'https://attacker.test.invalid/revoke',
    'https://auth.openai.com@attacker.test.invalid/revoke', 'https://user:password@auth.openai.com/revoke',
    `${ISSUER}/`, `${ISSUER}/revoke?token=secret`, `${ISSUER}/revoke#fragment`, `${ISSUER}/revoke?`, `${ISSUER}/revoke#`,
    `${ISSUER}/a/../revoke`, `${ISSUER}/revoke%2Fescape`])('rejects unsafe revocation discovery %#', async endpoint => {
    await expect(createOfficialPlanVerifier(transport({ ...metadata, revocation_endpoint: endpoint })).revocationEndpoint()).rejects.toThrow('Official token verification failed.');
  });

  it('bounds fetch time even when the injected transport ignores cancellation', async () => {
    const token = await sign(access()), fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const denied = expect(createOfficialPlanVerifier(fetcher).verifyAccessToken(token)).rejects.toThrow('Official token verification failed.');
    await vi.advanceTimersByTimeAsync(8000); await denied;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled response bodies even when stream cancellation never resolves', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }));
    const denied = expect(createOfficialPlanVerifier(fetcher).verifyAccessToken(await sign(access()))).rejects.toThrow('Official token verification failed.');
    await vi.advanceTimersByTimeAsync(8000); await denied;
    expect(cancelled).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    () => new Response('not-json', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { status: 302, headers: { location: 'https://attacker.test.invalid' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    () => new Response('x'.repeat(64001), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '64001' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ])('rejects invalid, redirected, oversized or non-UTF8 public JSON %#', async response => {
    await expect(createOfficialPlanVerifier(vi.fn<typeof fetch>(async () => response())).verifyAccessToken(await sign(access()))).rejects.toThrow('Official token verification failed.');
    expect(vi.getTimerCount()).toBe(0);
  });
});
