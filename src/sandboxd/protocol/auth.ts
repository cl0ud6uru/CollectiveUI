/**
 * Request signing between the portal (web and worker) and sandboxd. sandboxd holds docker.sock, so every request must
 * prove it comes from the portal: HMAC-SHA256 over the method, path, a timestamp, a nonce and the body hash, with a
 * shared SANDBOXD_SECRET. Imported by both sides; node:crypto only (sandboxd has no npm dependencies).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_BYTES = 32;
export const MAX_SKEW_MS = 60_000;
export const HEADER_TS = "x-sbx-ts";
export const HEADER_NONCE = "x-sbx-nonce";
export const HEADER_SIG = "x-sbx-sig";

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_RE = /^[0-9a-f]{64}$/;

export function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES)
    throw new Error(`SANDBOXD_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
}

const sha256Hex = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");

/** The signed string. `path` includes the query string, exactly as sent. */
export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: Uint8Array | string): string {
  return ["v1", method.toUpperCase(), path, ts, nonce, sha256Hex(body)].join("\n");
}

export function signRequest(
  secret: string,
  req: { method: string; path: string; body?: Uint8Array | string; now?: number; nonce?: string },
): Record<string, string> {
  const ts = String(req.now ?? Date.now());
  const nonce = req.nonce ?? randomBytes(18).toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(canonicalRequest(req.method, req.path, ts, nonce, req.body ?? ""))
    .digest("hex");
  return { [HEADER_TS]: ts, [HEADER_NONCE]: nonce, [HEADER_SIG]: sig };
}

/** Remembers nonces for longer than the allowed clock skew, so a captured request can't be replayed. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(ttlMs = 2 * MAX_SKEW_MS + 5_000, max = 200_000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  /** Records the nonce; false if it was already used (a replay). */
  claim(nonce: string, now: number): boolean {
    this.prune(now);
    if (this.seen.has(nonce)) return false;
    // Full (a flood of validly signed requests): refuse rather than forget nonces that could then be replayed.
    if (this.seen.size >= this.max) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  private prune(now: number) {
    for (const [nonce, expires] of this.seen) {
      if (expires > now) break; // insertion order ≈ expiry order
      this.seen.delete(nonce);
    }
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "skew" | "signature" | "replay" };

type HeaderBag = Record<string, string | string[] | undefined>;
const one = (h: HeaderBag, k: string) => (Array.isArray(h[k]) ? undefined : (h[k] as string | undefined));

export function verifyRequest(
  secret: string,
  req: { method: string; path: string; headers: HeaderBag; body: Uint8Array | string; now: number; nonces: NonceCache },
): VerifyResult {
  const ts = one(req.headers, HEADER_TS);
  const nonce = one(req.headers, HEADER_NONCE);
  const sig = one(req.headers, HEADER_SIG);
  if (!ts || !nonce || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{10,16}$/.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig)) return { ok: false, reason: "malformed" };
  if (Math.abs(req.now - Number(ts)) > MAX_SKEW_MS) return { ok: false, reason: "skew" };
  const expected = createHmac("sha256", secret).update(canonicalRequest(req.method, req.path, ts, nonce, req.body)).digest();
  if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return { ok: false, reason: "signature" };
  // Only a correctly signed request may use up a nonce.
  if (!req.nonces.claim(nonce, req.now)) return { ok: false, reason: "replay" };
  return { ok: true };
}
