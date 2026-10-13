import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createOfficialPlanVerifier } from '@/lib/hermes-team/official-plan-signatures';
import type { RefreshResult } from './oauth';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const SCOPE_LIST = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] as const;
const HOST_ID = z.string().max(256).regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const TOKEN_REPLY = z.object({ access_token: z.string().min(1).max(16_000), refresh_token: z.string().min(1).max(16_000).optional(),
  id_token: z.string().min(1).max(16_000).optional(), token_type: z.string().refine(v => v.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(3660), scope: z.string().min(1).max(4096) }).passthrough();
export const SIWCCredentialSchema = z.object({ version: z.literal(1), kind: z.literal('siwc'), clientId: z.string().min(1).max(256),
  accessToken: z.string().min(1).max(16_000), refreshToken: z.string().min(1).max(16_000).optional(), idToken: z.string().min(1).max(16_000),
  expiresIn: z.number().int().positive().max(3660).optional(), scope: z.string().min(1).max(4096), hostId: HOST_ID, createdAt: z.string().datetime() }).strict();
export type SIWCCredential = z.infer<typeof SIWCCredentialSchema>;
export type SIWCIdentity = { subject: string; email: string; clientId: string; expiresAt: Date };
const random = () => randomBytes(32).toString('base64url');
const fail = () => new Error('Sign in with ChatGPT could not be completed.');

async function boundedJson(response: Response) {
  if (!response.ok || response.redirected || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) throw fail();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > 64_000) throw fail(); chunks.push(value); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Strictly verify both signed tokens and exact permitted scope presence before an export can be trusted. */
export async function validateSIWCCredential(raw: unknown, options: { hostId: string; nonce?: string; subject?: string }, fetcher: typeof fetch = fetch): Promise<SIWCIdentity> {
  try {
    const credential = SIWCCredentialSchema.parse(raw), scopes = credential.scope.split(' ');
    if (credential.hostId !== HOST_ID.parse(options.hostId)) throw fail();
    if (new Set(scopes).size !== scopes.length || scopes.length !== SCOPE_LIST.length || SCOPE_LIST.some(scope => !scopes.includes(scope))) throw fail();
    const verifier = createOfficialPlanVerifier(fetcher);
    const subject = decodeJwt(credential.idToken).sub;
    if (typeof subject !== 'string') throw fail();
    const expectedSubject = options.subject ?? subject;
    const id = await verifier.verifyIdToken(credential.idToken, options.nonce ? { clientId: credential.clientId, nonce: options.nonce, ...(options.subject ? { subject: options.subject } : {}) } : { clientId: credential.clientId, subject: expectedSubject });
    const access = await verifier.verifyAccessToken(credential.accessToken);
    if (access.clientId !== credential.clientId || access.subject !== id.subject || SCOPE_LIST.some(scope => !access.scopes.includes(scope))) throw fail();
    const email = decodeJwt(credential.idToken).email;
    if (typeof email !== 'string' || !email.trim()) throw fail();
    return { subject: id.subject, email, clientId: credential.clientId, expiresAt: new Date(access.expiresAt) };
  } catch { throw fail(); }
}

async function exchange(body: URLSearchParams, fetcher: typeof fetch) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(), redirect: 'error', credentials: 'omit', signal: controller.signal });
    return TOKEN_REPLY.parse(await boundedJson(response));
  } catch { throw fail(); } finally { clearTimeout(timer); controller.abort(); }
}

async function saveProtected(path: string, data: SIWCCredential) {
  const target = resolve(path), temp = `${target}.${random()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temp, target); await chmod(target, 0o600);
  } catch { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); throw fail(); }
}

/** Read only a regular, owner-only profile file. The descriptor prevents a symlink swap after lstat. */
export async function readProtectedSIWCProfile(path: string): Promise<SIWCCredential> {
  let handle;
  try {
    if (!path || path.length > 4096 || typeof process.getuid !== 'function') throw fail();
    const uid = process.getuid(), flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(resolve(path), flags);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size < 2 || info.size > 64_000) throw fail();
    const bytes = await handle.readFile();
    if (bytes.byteLength > 64_000) throw fail();
    return SIWCCredentialSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { throw fail(); }
  finally { await handle?.close().catch(() => {}); }
}

/** Run one first-time local dynamic registration. The browser callback never receives tokens. */
export async function signInSIWC(options: { hostId?: string; existing?: unknown; outputPath: string; openBrowser: (url: string) => Promise<void> | void; fetcher?: typeof fetch; timeoutMs?: number }) {
  const existing = options.existing === undefined ? undefined : SIWCCredentialSchema.parse(options.existing);
  const hostId = HOST_ID.parse(options.hostId ?? existing?.hostId ?? `urn:uuid:${randomUUID()}`), fetcher = options.fetcher ?? fetch;
  if (existing && existing.hostId !== hostId) throw fail();
  const existingSubject = existing ? decodeJwt(existing.idToken).sub : undefined;
  if (existing && (typeof existingSubject !== 'string' || existing.clientId === 'dynamic_agent_client')) throw fail();
  if (!options.outputPath || options.outputPath.length > 4096) throw fail();
  const state = random(), nonce = random(), verifier = random();
  let server: Server | undefined, accepted = false, timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    let redirectUri = '';
    const result = new Promise<SIWCCredential>((resolveResult, rejectResult) => {
      server = createServer((req, res) => {
        const reply = (status: number, message: string) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(message); };
        void (async () => {
          try {
            if (accepted || req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host || (req.url?.length ?? 0) > 8192) throw fail();
            const cb = new URL(req.url ?? '/', redirectUri);
            if (cb.pathname !== '/auth/callback' || [...cb.searchParams.keys()].some(k => cb.searchParams.getAll(k).length !== 1 || !['state','code','client_id','scope','error'].includes(k)) || cb.searchParams.get('state') !== state) throw fail();
            accepted = true;
            if (cb.searchParams.has('error') || !cb.searchParams.get('code') || cb.searchParams.get('code')!.length > 4000) throw fail();
            const returnedClientId = cb.searchParams.get('client_id');
            const clientId = existing?.clientId ?? returnedClientId;
            if (!clientId || clientId === 'dynamic_agent_client' || clientId.length > 256 || (returnedClientId && returnedClientId !== clientId)) throw fail();
            const tokens = await exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: cb.searchParams.get('code')!,
              code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), fetcher);
            const granted = tokens.scope.split(' ');
            if (!tokens.id_token || new Set(granted).size !== granted.length || granted.length !== SCOPE_LIST.length || SCOPE_LIST.some(scope => !granted.includes(scope))) throw fail();
            const exported = { version: 1 as const, kind: 'siwc' as const, clientId, accessToken: tokens.access_token,
              ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}), idToken: tokens.id_token, expiresIn: tokens.expires_in,
              scope: tokens.scope, hostId, createdAt: new Date().toISOString() };
            await validateSIWCCredential(exported, { hostId, nonce, ...(existingSubject ? { subject: existingSubject } : {}) }, fetcher);
            const credential = SIWCCredentialSchema.parse(exported);
            await saveProtected(options.outputPath, credential);
            reply(200, 'Sign in complete. You may close this window and return to the terminal.'); resolveResult(credential);
          } catch { reply(400, 'Sign in was not completed. Return to the terminal for details.'); rejectResult(fail()); }
        })();
      });
      server.headersTimeout = 8000; server.requestTimeout = 8000; server.keepAliveTimeout = 100;
      server.once('error', () => rejectResult(fail()));
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address(); if (!address || typeof address === 'string') { rejectResult(fail()); return; }
        redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        const url = new URL(`${ISSUER}/api/accounts/authorize`);
        for (const [key, value] of Object.entries({ client_id: existing?.clientId ?? 'dynamic_agent_client', response_type: 'code', redirect_uri: redirectUri,
          scope: SCOPE_LIST.join(' '), resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), ext_agent_host_id: hostId,
          ...(!existing ? { agent_name_hint: 'collective_ui' } : {}) })) url.searchParams.set(key, value);
        try { void Promise.resolve(options.openBrowser(url.href)).catch(() => rejectResult(fail())); } catch { rejectResult(fail()); }
      });
    });
    const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(fail()), Math.min(Math.max(options.timeoutMs ?? 120_000, 1), 120_000)); });
    return await Promise.race([result, timeout]);
  } catch { throw fail(); }
  finally { if (timeoutHandle) clearTimeout(timeoutHandle); server?.closeAllConnections(); await new Promise<void>(resolveClose => { if (server?.listening) server.close(() => resolveClose()); else resolveClose(); }); }
}

/** Refresh with the issued per-account client ID and no scope expansion. */
export async function refreshSIWCTokens(refreshToken: string, clientId: string, fetcher: typeof fetch = fetch, expectedSubject?: string): Promise<RefreshResult> {
  const validClient = z.string().min(1).max(256).safeParse(clientId), validRefresh = z.string().min(1).max(16_000).safeParse(refreshToken);
  if (!validClient.success || !validRefresh.success) return { ok: false, permanent: true, reason: 'invalid_credential' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE }).toString(),
      redirect: 'error', credentials: 'omit', signal: controller.signal });
    const data = await boundedJson(new Response(response.body, { status: 200, headers: response.headers }));
    const body = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (!response.ok) {
      const rawError = body.error, code = typeof rawError === 'string' ? rawError : rawError && typeof rawError === 'object'
        ? String((rawError as Record<string, unknown>).code ?? (rawError as Record<string, unknown>).type ?? '') : String(body.code ?? '');
      const permanent = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client'].includes(code);
      return { ok: false, permanent, reason: permanent ? code : 'upstream_refresh_failed' };
    }
    const rotated = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined;
    const parsed = TOKEN_REPLY.safeParse(body), scopes = typeof body.scope === 'string' ? body.scope.split(' ') : [];
    if (!parsed.success || new Set(scopes).size !== scopes.length || scopes.length !== SCOPE_LIST.length || SCOPE_LIST.some(scope => !scopes.includes(scope))) {
      return { ok: false, permanent: false, reason: 'malformed_response', ...(rotated ? { rotatedRefreshToken: rotated } : {}) };
    }
    try {
      const verifier = createOfficialPlanVerifier(fetcher), access = await verifier.verifyAccessToken(parsed.data.access_token);
      if (access.clientId !== clientId || SCOPE_LIST.some(scope => !access.scopes.includes(scope))) throw fail();
      if (parsed.data.id_token) {
        const tokenSubject = decodeJwt(parsed.data.id_token).sub;
        if (typeof tokenSubject !== 'string' || (expectedSubject && tokenSubject !== expectedSubject)) throw fail();
        const identity = await verifier.verifyIdToken(parsed.data.id_token, { clientId, subject: tokenSubject });
        if (identity.subject !== access.subject) throw fail();
      } else if (expectedSubject && access.subject !== expectedSubject) throw fail();
    } catch { return { ok: false, permanent: false, reason: 'invalid_token_response', ...(rotated ? { rotatedRefreshToken: rotated } : {}) }; }
    return { ok: true, tokens: { accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token, idToken: parsed.data.id_token, expiresIn: parsed.data.expires_in } };
  } catch { return { ok: false, permanent: false, reason: 'network' }; }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Revoke using the endpoint from validated OpenAI discovery and the issued account client ID. */
export async function revokeSIWCTokens(tokens: { refreshToken?: string; accessToken?: string; clientId: string }, fetcher: typeof fetch = fetch): Promise<boolean> {
  const token = tokens.refreshToken || tokens.accessToken;
  if (!token || token.length > 16_000 || !z.string().min(1).max(256).safeParse(tokens.clientId).success) return false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const endpoint = await createOfficialPlanVerifier(fetcher).revocationEndpoint();
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token, token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token', client_id: tokens.clientId }).toString(),
      redirect: 'error', credentials: 'omit', signal: controller.signal });
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); return false; }
    if (!response.body) return true;
    const reader = response.body.getReader(); let total = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; total += item.value.byteLength; if (total > 64_000) return false; } }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    return total === 0;
  } catch { return false; }
  finally { clearTimeout(timer); controller.abort(); }
}
