import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { dashboardBase } from './policy';

const text = z.string().min(1).max(4096);
/** Hermes uses snake_case on the wire; mirror the native client's typed JSON decoder. */
function nativeFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), v]));
}
export const dashboardSecretsSchema = z.object({
  mode: z.enum(['password', 'sessionToken']),
  accessToken: text.optional(), refreshToken: text.optional(), sessionToken: text.optional(),
  expiresAt: z.number().finite().optional(), provider: z.string().max(200).optional(), userId: z.string().max(200).optional(),
}).superRefine((s, ctx) => {
  if (s.mode === 'password' ? !s.accessToken : !s.sessionToken) ctx.addIssue({ code: 'custom', message: 'Missing Hermes credential' });
});
export type DashboardSecrets = z.infer<typeof dashboardSecretsSchema>;
const tokenSchema = z.preprocess(nativeFields, z.object({ accessToken: text, refreshToken: text.optional().nullable(), expiresAt: z.number().finite().optional().nullable(), provider: z.string().optional().nullable(), userId: z.string().optional().nullable() }));
const profileSchema = z.preprocess(nativeFields, z.object({ name: z.string().min(1).max(200), displayName: z.string().max(300).nullable().optional(), botTitle: z.string().max(300).nullable().optional(), description: z.string().max(2000).nullable().optional(), model: z.string().max(200).nullable().optional(), provider: z.string().max(200).nullable().optional() }));
export type RemoteHermesProfile = z.infer<typeof profileSchema>;

async function json(res: Response, maxBytes = 1024 * 1024): Promise<unknown> {
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status === 401 || res.status === 403 ? 401 : 502,
      res.status === 401 || res.status === 403 ? 'Hermes rejected this sign-in. Check your credentials or sign in again.' : 'The Hermes dashboard refused the request. Check that it supports native sign-in.');
  }
  if (!res.body) throw new HttpError(502, 'Hermes returned an empty response.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HttpError(502, 'The Hermes response is too large.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(502, 'Hermes returned a page instead of JSON. Use the Hermes dashboard URL.'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Native dashboard auth, separate from API_SERVER_KEY and from model-provider authentication. */
export class DashboardClient {
  readonly base: string;
  constructor(base: string, private transport: typeof fetch, private secrets?: DashboardSecrets) { this.base = dashboardBase(base); }
  private async call(path: string, body?: unknown, headers: Record<string, string> = {}, maxBytes?: number) {
    const auth: Record<string, string> = this.secrets?.mode === 'sessionToken'
      ? { 'X-Hermes-Session-Token': this.secrets.sessionToken! }
      : this.secrets ? { Authorization: `Bearer ${this.secrets.accessToken}` } : {};
    return json(await this.transport(this.base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...auth, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), maxBytes);
  }
  async status() { return z.preprocess(nativeFields, z.object({ version: z.string().optional(), authRequired: z.boolean().optional() })).parse(await this.call('/api/status')); }
  async profiles(): Promise<RemoteHermesProfile[]> { return z.object({ profiles: z.array(profileSchema).max(2000) }).parse(await this.call('/api/profiles')).profiles; }
  async websocketTicket() {
    return z.object({ ticket: text }).parse(await this.call('/api/auth/ws-ticket', {})).ticket;
  }
  private async readSessionPage(profile: string, offset: number) {
    const query = new URLSearchParams({ profile, limit: '100', offset: String(offset), archived: 'include', order: 'recent' });
    // Native pages append pinned sessions outside the requested 100-row window.
    // Keep the foundation's bounded backfill support; never count pins as page rows.
    return z.object({ sessions: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().max(500).nullable().optional(), model: z.string().max(200).nullable().optional(), archived: z.boolean().optional() })).max(2000), total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).parse(await this.call(`/api/sessions?${query}`));
  }
  async sessions(profile: string, offset = 0) {
    return (await this.readSessionPage(profile, offset)).sessions;
  }
  async sessionPage(profile: string, offset = 0) {
    const result = await this.readSessionPage(profile, offset);
    if (result.total === undefined) throw new HttpError(501, 'This Hermes version does not support paged conversations.');
    const nextOffset = offset + 100;
    return { sessions: result.sessions, nextOffset, hasMore: nextOffset < result.total };
  }
  async history(profile: string, storedId: string, offset: number) {
    if (!storedId || storedId === '.' || storedId === '..') throw new HttpError(400, 'Invalid Hermes session identity.');
    const query = new URLSearchParams({ profile, limit: '200', offset: String(offset), order: 'latest', inline_images: 'false' });
    const result = z.object({ messages: z.array(z.record(z.string(), z.unknown())).max(200) }).parse(await this.call(`/api/sessions/${encodeURIComponent(storedId)}/messages?${query}`, undefined, {}, 8 * 1024 * 1024));
    return { messages: result.messages.filter(m => m.display_kind !== 'hidden').map(m => ({
      id: String(m.id ?? m.row_id ?? ''), role: typeof m.role === 'string' ? m.role.slice(0, 30) : '',
      text: typeof (m.display_content ?? m.content) === 'string' ? String(m.display_content ?? m.content).slice(0, 32000) : '',
    })).filter(m => m.id && m.text), nextOffset: offset + result.messages.length, hasMore: result.messages.length === 200 };
  }
  async passwordLogin(username: string, password: string): Promise<DashboardSecrets> {
    const providers = z.object({ providers: z.array(z.preprocess(nativeFields, z.object({ name: z.string(), supportsPassword: z.boolean().optional() }))).max(100) }).parse(await this.call('/api/auth/providers')).providers;
    const supported = providers.filter(p => p.supportsPassword);
    if (supported.length !== 1) throw new HttpError(400, supported.length ? 'This dashboard has multiple password providers. Select a single provider in Hermes before connecting.' : 'This Hermes dashboard does not offer username/password sign-in.');
    const provider = supported[0].name;
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ provider, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: 'http://127.0.0.1:1/callback', state });
    // Keep cookies only in this sign-in attempt. Never follow the eventual loopback callback.
    const res = await this.transport(`${this.base}/auth/native/authorize?${query}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!res.ok && ![302, 303, 307].includes(res.status)) { await res.body?.cancel(); throw new HttpError(400, 'This Hermes server does not support native password sign-in.'); }
    const cookies = res.headers.getSetCookie().map(c => c.split(';', 1)[0]).join('; ');
    await res.body?.cancel();
    if (!cookies) throw new HttpError(502, 'Hermes did not create a native sign-in session.');
    const login = z.object({ next: z.string().max(8192) }).parse(await this.call('/auth/password-login', { provider, username, password }, { Cookie: cookies }));
    const callback = new URL(login.next);
    if (callback.origin !== 'http://127.0.0.1:1' || callback.pathname !== '/callback' || callback.searchParams.get('state') !== state || !callback.searchParams.get('code'))
      throw new HttpError(502, 'Hermes returned an invalid sign-in callback.');
    const tokens = tokenSchema.parse(await this.call('/auth/native/token', { code: callback.searchParams.get('code'), code_verifier: verifier }));
    return dashboardSecretsSchema.parse({ mode: 'password', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? undefined, expiresAt: tokens.expiresAt ?? undefined, provider: tokens.provider ?? provider, userId: tokens.userId ?? undefined });
  }
  async refresh(): Promise<DashboardSecrets> {
    if (!this.secrets?.refreshToken) throw new HttpError(401, 'Sign into this Hermes dashboard again.');
    const tokens = tokenSchema.parse(await new DashboardClient(this.base, this.transport).call('/auth/native/refresh', { refresh_token: this.secrets.refreshToken, provider: this.secrets.provider ?? '' }));
    return dashboardSecretsSchema.parse({ ...this.secrets, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? this.secrets.refreshToken, expiresAt: tokens.expiresAt ?? undefined, provider: tokens.provider ?? this.secrets.provider, userId: tokens.userId ?? this.secrets.userId });
  }
}
