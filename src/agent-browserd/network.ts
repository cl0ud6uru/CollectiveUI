import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { BrowserError, BROWSER_LIMITS } from "../lib/agent-browser/provider-contract.ts";

type Address = { address: string; family: number };
export type Resolve = (host: string) => Promise<Address[]>;
const resolve: Resolve = host => lookup(host, { all: true });

/** Conservative public-unicast policy. No internal allowlist exception, including mapped/transition IPv6. */
export function publicAddress(raw: string): boolean {
  if (isIP(raw) === 4) {
    const [a, b, c] = raw.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(raw) !== 6) return false;
  const v = new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase();
  // Only global 2000::/3, excluding documentation, Teredo, 6to4 and protocol assignments.
  const first = parseInt(v.split(":")[0], 16);
  const second = parseInt(v.split(":")[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && first !== 0x2002 && first !== 0x3fff;
}

export function browserUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 4096) throw new BrowserError("invalid", "Invalid browser URL");
  let u: URL;
  try { u = new URL(raw); } catch { throw new BrowserError("invalid", "Invalid browser URL"); }
  const h = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password ||
      (u.port && u.port !== (u.protocol === "https:" ? "443" : "80")) ||
      !h || h === "localhost" || /\.(localhost|local|internal|home|test|invalid)$/.test(h) ||
      ["metadata.google.internal", "metadata", "instance-data"].includes(h) ||
      (!isIP(h) && !h.includes(".")) || (isIP(h) && !publicAddress(h)))
    throw new BrowserError("denied", "Browser destination blocked");
  return u;
}

export async function publicDestination(raw: string, dns: Resolve = resolve) {
  const url = browserUrl(raw); const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns(host);
  if (!addresses.length || addresses.some(a => !publicAddress(a.address) || a.family !== isIP(a.address)))
    throw new BrowserError("denied", "Browser destination blocked");
  return { url, address: addresses.find(a => a.family === 4) ?? addresses[0] };
}

export type EgressRequest = { url: string; method: string; headers: Record<string, string>; bodyB64?: string };
export type EgressResponse = { status: number; headers: { name: string; value: string }[]; bodyB64: string };
const FORBIDDEN_HEADERS = /^(host|connection|proxy-.*|upgrade|transfer-encoding|content-length|accept-encoding|te|trailer)$/i;

/** Single-hop request, fixed lookup, fresh socket, original TLS SNI/cert check. Never follows redirects. */
export async function fetchPublic(input: EgressRequest, signal: AbortSignal, dns: Resolve = resolve): Promise<EgressResponse> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const boundedDns: Resolve = host => new Promise((done, fail) => {
    if (abort.aborted) { fail(abort.reason); return; }
    const onAbort = () => fail(abort.reason);
    abort.addEventListener("abort", onAbort, { once: true });
    void dns(host).then(done, fail).finally(() => abort.removeEventListener("abort", onAbort));
  });
  const { url, address } = await publicDestination(input.url, boundedDns);
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(input.method) || !input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) throw new BrowserError("invalid");
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  for (const [name, value] of Object.entries(input.headers)) {
    if (!/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) throw new BrowserError("invalid");
    headerBytes += name.length + value.length;
    if (headerBytes > 16 * 1024) throw new BrowserError("invalid");
    if (!FORBIDDEN_HEADERS.test(name)) headers[name] = value;
  }
  headers["accept-encoding"] = "identity";
  if (input.bodyB64 !== undefined && (typeof input.bodyB64 !== "string" || input.bodyB64.length > BROWSER_LIMITS.maxRequestBytes * 4 / 3 + 4)) throw new BrowserError("invalid");
  const body = input.bodyB64 ? Buffer.from(input.bodyB64, "base64") : undefined;
  if (body && body.length > BROWSER_LIMITS.maxRequestBytes) throw new BrowserError("invalid");
  abort.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const req = (url.protocol === "https:" ? https.request : http.request)(url, {
      method: input.method, headers, agent: false, signal: abort, family: address.family,
      lookup: (_h, _o, cb) => cb(null, address.address, address.family),
      maxHeaderSize: 16 * 1024,
    }, res => {
      const status = res.statusCode ?? 502;
      if (status < 200 || status > 599 || res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        req.destroy(new BrowserError("denied", "Unsupported browser response")); return;
      }
      const responseHeaders: { name: string; value: string }[] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i], value = res.rawHeaders[i + 1];
        // Set-Cookie is retained as separate headers for the runtime's private cookie jar.
        if (!FORBIDDEN_HEADERS.test(name) && !/^content-encoding$/i.test(name)) responseHeaders.push({ name, value });
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on("error", reject);
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > BROWSER_LIMITS.maxResponseBytes) req.destroy(new BrowserError("denied", "Browser response too large"));
        else chunks.push(c);
      });
      res.on("end", () => {
        void (async () => {
          // A denied Location never reaches Chromium; the next request resolves and pins again.
          if (status >= 300 && status < 400 && res.headers.location) await publicDestination(new URL(res.headers.location, url).href, boundedDns);
          abort.throwIfAborted();
          resolveResult({ status, headers: responseHeaders, bodyB64: Buffer.concat(chunks).toString("base64") });
        })().catch(reject);
      });
    });
    req.on("error", reject); req.end(body);
  });
}
