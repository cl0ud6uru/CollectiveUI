import { z } from 'zod';
import { HttpError } from '@/lib/authz';

export const mcpOAuthInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('start'), requestId: z.string().uuid(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.enum(['poll', 'cancel']), flow: z.string().min(1).max(6000) }).strict(),
]);
export const unsupportedMcpOAuth = () => new HttpError(501, 'MCP OAuth here requires a browser-reachable HTTPS callback on the connected Hermes dashboard. Continue authorization in Hermes for this connection.');

/** Pinned `_safe_filename`; non-ASCII inventory cannot be compared safely to Python's Unicode \w. */
export function nativeMcpOAuthSlot(name: string): string | null {
  if (!name || name.length > 200 || !/^[\x00-\x7f]+$/.test(name)) return null;
  return name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 128) || 'default';
}

/** Validate the native callback, never substitute a portal URL into the RPC loopback field. */
export function nativeMcpAuthorizationURL(base: string, name: string, value: string | null) {
  try {
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    const root = new URL(base), url = new URL(value ?? '');
    const redirects = url.searchParams.getAll('redirect_uri');
    const states = url.searchParams.getAll('state');
    if (root.protocol !== 'https:' || url.protocol !== 'https:' || url.username || url.password || url.hash || redirects.length !== 1 || states.length !== 1 || !states[0]) throw new Error();
    const callback = new URL(redirects[0]);
    const expected = new URL(base.replace(/\/$/, '') + `/api/mcp/oauth/callback/${encodeURIComponent(name)}`);
    if (callback.href !== expected.href) throw new Error();
    return url.href;
  } catch { throw unsupportedMcpOAuth(); }
}

