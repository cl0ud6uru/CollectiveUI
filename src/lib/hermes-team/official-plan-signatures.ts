import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import type { VerifiedOfficialAccessClaims } from './official-plan';

const ISSUER = 'https://auth.openai.com' as const;
const AUDIENCE = 'https://api.openai.com/v1' as const;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const MAX_JSON_BYTES = 64_000;
const FETCH_TIMEOUT_MS = 8_000;
const identity = z.string().min(1).max(256);
const numericDate = z.number().int().nonnegative().refine(value => Number.isSafeInteger(value * 1000));
const failure = () => new HttpError(409, 'Official token verification failed.');
const discoverySchema = z.object({
  issuer: z.literal(ISSUER),
  authorization_endpoint: z.literal(`${ISSUER}/api/accounts/authorize`),
  token_endpoint: z.literal(`${ISSUER}/api/accounts/oauth/token`),
  jwks_uri: z.literal(JWKS),
  revocation_endpoint: z.string().max(1024).optional(),
  id_token_signing_alg_values_supported: z.array(z.string().min(1).max(32)).min(1).max(16).optional(),
}).passthrough();
const jwksSchema = z.object({ keys: z.array(z.object({
  kty: z.literal('RSA'), kid: identity, alg: z.literal('RS256').optional(), use: z.literal('sig').optional(),
  key_ops: z.array(z.literal('verify')).min(1).max(1).optional(),
  n: z.string().regex(/^[A-Za-z0-9_-]+$/).min(342).max(1366),
  e: z.string().regex(/^[A-Za-z0-9_-]+$/).min(1).max(12),
}).passthrough()).min(1).max(16) }).passthrough();

/** Fixed public discovery only. Never send a token, follow redirects or trust a JWT key URL. */
async function publicJson(fetcher: typeof fetch, url: string) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(failure()); }, FETCH_TIMEOUT_MS);
  });
  try {
    const pending = fetcher(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error',
      credentials: 'omit', cache: 'no-store', signal: controller.signal });
    // A fetch implementation that ignores AbortSignal still cannot prolong verification.
    void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await Promise.race([pending, deadline]);
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || response.redirected || (response.url && response.url !== url)
      || !['application/json', 'application/jwk-set+json'].includes(mime ?? '') || !response.body) {
      void response.body?.cancel().catch(() => {}); throw failure();
    }
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
      void response.body.cancel().catch(() => {}); throw failure();
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
      size += item.value.length;
      if (size > MAX_JSON_BYTES) { void reader.cancel().catch(() => {}); throw failure(); }
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { clearTimeout(timer); controller.abort(); reader?.releaseLock(); }
}

function dates(payload: JWTPayload, requireNotBefore: boolean) {
  const issuedAt = numericDate.parse(payload.iat) * 1000, expiresAt = numericDate.parse(payload.exp) * 1000;
  const notBefore = payload.nbf === undefined && !requireNotBefore ? undefined : numericDate.parse(payload.nbf) * 1000;
  const now = Date.now();
  if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt <= issuedAt
    || (notBefore !== undefined && (notBefore > now || notBefore >= expiresAt))) throw failure();
  return { issuedAt, expiresAt, notBefore };
}

/**
 * Candidate RS256 subset; it does not establish live registration or entitlement.
 * Contracts: https://developers.openai.com/siwc/website and
 * https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 * Fresh bounded key fetches also support key rotation without retrying a failed signature.
 */
export function createOfficialPlanVerifier(fetcher: typeof fetch) {
  const discovery = async () => {
    const metadata = discoverySchema.parse(await publicJson(fetcher, DISCOVERY));
    if (metadata.id_token_signing_alg_values_supported && !metadata.id_token_signing_alg_values_supported.includes('RS256')) throw failure();
    return metadata;
  };
  const verify = async (token: string, audience: string, requiredClaims: string[]) => {
    if (typeof token !== 'string' || token.length > 16_000 || token.split('.').length !== 3 || token.split('.')[0].length > 2048) throw failure();
    // This untrusted header can reject input; it cannot select an issuer, URL or secret.
    z.object({ alg: z.literal('RS256'), kid: identity, typ: z.enum(['JWT', 'at+jwt']).optional() }).strict().parse(decodeProtectedHeader(token));
    await discovery();
    const set = jwksSchema.parse(await publicJson(fetcher, JWKS));
    if (new Set(set.keys.map(key => key.kid)).size !== set.keys.length) throw failure();
    for (const key of set.keys) {
      if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(field => field in key)) throw failure();
      const modulus = Buffer.from(key.n, 'base64url');
      if (modulus.length < 256 || modulus.length > 1024 || modulus[0] < 128) throw failure();
    }
    return (await jwtVerify(token, createLocalJWKSet(set), { issuer: ISSUER, audience, algorithms: ['RS256'], requiredClaims, clockTolerance: 0 })).payload;
  };
  return {
    async verifyAccessToken(token: string): Promise<VerifiedOfficialAccessClaims> {
      try {
        const payload = await verify(token, AUDIENCE, ['sub', 'client_id', 'scope', 'exp', 'iat', 'nbf']);
        const subject = identity.parse(payload.sub), clientId = identity.parse(payload.client_id);
        if (payload.aud !== AUDIENCE) throw failure();
        const scope = z.string().min(1).max(4096).regex(/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/).parse(payload.scope);
        const scopes = z.array(z.string().min(1).max(100)).min(1).max(30).parse(scope.split(' '));
        if (new Set(scopes).size !== scopes.length || !['chatgpt.tokens.use.direct', 'resource.invoke'].every(item => scopes.includes(item))) throw failure();
        const time = dates(payload, true);
        if (time.expiresAt - time.issuedAt > 3_660_000 || time.expiresAt > Date.now() + 3_660_000) throw failure();
        return { issuer: ISSUER, audience: AUDIENCE, subject, clientId, scopes, issuedAt: time.issuedAt, notBefore: time.notBefore!, expiresAt: time.expiresAt };
      } catch { throw failure(); }
    },
    async verifyIdToken(token: string, expected: { clientId: string; nonce?: string; subject?: string }): Promise<{ subject: string }> {
      try {
        const clientId = identity.parse(expected.clientId);
        if (expected.nonce === undefined && expected.subject === undefined) throw failure();
        if (expected.nonce !== undefined) identity.parse(expected.nonce);
        if (expected.subject !== undefined) identity.parse(expected.subject);
        const payload = await verify(token, clientId, ['sub', 'exp', 'iat']);
        const subject = identity.parse(payload.sub); dates(payload, false);
        const audiences = z.union([identity, z.array(identity).min(1).max(8)]).parse(payload.aud);
        if ((Array.isArray(audiences) && audiences.length > 1 && payload.azp !== clientId)
          || (payload.azp !== undefined && payload.azp !== clientId)
          || (expected.nonce !== undefined && payload.nonce !== expected.nonce)
          || (expected.subject !== undefined && subject !== expected.subject)) throw failure();
        return { subject };
      } catch { throw failure(); }
    },
    async revocationEndpoint(): Promise<string> {
      try {
        const endpoint = (await discovery()).revocation_endpoint; if (!endpoint) throw failure();
        const url = new URL(endpoint);
        if (url.origin !== ISSUER || url.username || url.password || /[?#]/.test(endpoint) || url.search || url.hash
          || url.pathname === '/' || !/^\/[A-Za-z0-9_/-]{1,256}$/.test(url.pathname) || url.href !== endpoint) throw failure();
        return endpoint;
      } catch { throw failure(); }
    },
  };
}
