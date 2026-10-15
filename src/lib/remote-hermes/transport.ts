import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { HttpError } from '@/lib/authz';
import { isPrivateAddress } from '@/lib/agent/tools/web';
import { isBlockedAddress } from '@/lib/mcp/url';
import type { RemoteHermesSettings } from '@/lib/settings';
import { dashboardBase } from './policy';

function blocked(address: string) {
  const normalized = isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':').map(s => parseInt(s, 16));
    if (words.length === 2) return isBlockedAddress(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
  }
  return isBlockedAddress(normalized);
}

function loopback(address: string) {
  const normalized = isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase() : address.toLowerCase();
  if (isIP(normalized) === 4) return Number(normalized.split('.')[0]) === 127;
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return Number(mapped.split('.')[0]) === 127;
    const words = mapped.split(':').map(s => parseInt(s, 16));
    return words.length === 2 && Number.isInteger(words[0]) && Number.isInteger(words[1]) && (words[0] >> 8) === 127;
  }
  return false;
}

/** HTTP to non-loopback private hosts is trusted only when the exact base is attested. */
export function privateHttpTransportTrusted(base: string, address: string, policy: RemoteHermesSettings) {
  const url = new URL(dashboardBase(base));
  if (url.protocol !== 'http:') return true;
  if (loopback(address)) return true;
  return Array.isArray(policy.privateHttpTunnels) && policy.privateHttpTunnels.includes(url.toString().replace(/\/$/, ''));
}

/** Shared validation for HTTP and WebSocket upgrades. The caller pins this exact DNS answer. */
export async function dashboardAddress(base: string, policy: RemoteHermesSettings) {
  const normalized = dashboardBase(base);
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => blocked(a.address))) throw new HttpError(400, 'This Hermes address is blocked.');
  const privateHost = addresses.every(a => isPrivateAddress(a.address));
  if (addresses.some(a => isPrivateAddress(a.address)) && !policy.privateGateways.includes(normalized))
    throw new HttpError(403, 'Ask an administrator to approve this private Hermes dashboard URL.');
  if (url.protocol !== 'https:' && !privateHost) throw new HttpError(400, 'Public Hermes servers require HTTPS.');
  const chosen = addresses.find(a => a.family === 4) ?? addresses[0];
  const nonLoopback = addresses.find(a => !loopback(a.address));
  if (url.protocol === 'http:' && addresses.some(a => isPrivateAddress(a.address)) && nonLoopback &&
      !privateHttpTransportTrusted(normalized, nonLoopback.address, policy))
    throw new HttpError(403, 'Private HTTP requires a separately verified encrypted tunnel or a loopback dashboard.');
  return chosen;
}

/** Resolve once per request and pin the connection. Redirects are handled by the dashboard client. */
export function dashboardFetch(base: string, policy: RemoteHermesSettings): typeof fetch {
  const normalized = dashboardBase(base);
  return (async (input, init = {}) => {
    const url = new URL(String(input));
    const root = new URL(normalized);
    if (url.origin !== root.origin || (root.pathname !== '/' && !url.pathname.startsWith(root.pathname + '/')))
      throw new HttpError(400, 'Hermes redirected outside this dashboard.');
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Invalid Hermes destination.');
    const address = await dashboardAddress(normalized, policy);
    if (init.body != null && typeof init.body !== 'string') throw new HttpError(400, 'Invalid Hermes request body.');
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    return await new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false, family: address.family,
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        method: init.method ?? 'GET', signal,
        headers: Object.fromEntries(new Headers(init.headers)),
      }, res => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const v of value) headers.append(key, v);
          else if (value !== undefined) headers.set(key, value);
        }
        const noBody = [204, 205, 304].includes(res.statusCode ?? 200);
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 502, headers }));
      });
      req.on('error', () => reject(new HttpError(502, 'The Hermes dashboard could not be reached. Check its URL and network access.')));
      req.end(init.body);
    });
  }) as typeof fetch;
}
