import { redactSecrets } from "@/lib/redact";

/**
 * Field names that hold credentials or credential-adjacent material (compared lowercased, without "_" or "-"):
 * encrypted columns (*Enc), hashes, headers, tokens, keys, and sandbox refs (which address sandboxd directly).
 */
const SECRET_PARTS = ["secret", "token", "password", "passwd", "apikey", "credential", "cookie", "privatekey", "signingkey", "authorization", "totp", "recoverycode"];
const SECRET_SUFFIXES = ["enc", "hash", "headers", "ciphertext", "env"];
const SECRET_NAMES = new Set(["ref", "key", "dek", "kek", "iv"]);

export const isSecretKey = (key: string) => {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  return SECRET_NAMES.has(k) || SECRET_PARTS.some(p => k.includes(p)) || SECRET_SUFFIXES.some(s => k.endsWith(s));
};

export class SecretFieldError extends Error {
  constructor(readonly path: string) {
    super(`Refused to return a credential-like field (${path}).`);
  }
}

const MAX_STRING = 4000;
const MAX_DEPTH = 12;

/**
 * The last step of every admin tool result. Tools select explicit fields; this is the safety net that fails closed:
 * - a field whose name looks like a credential may only carry a presence boolean, known token-count metric or null (e.g. hasKey, inputTokens);
 *   a string or object under such a name throws SecretFieldError instead of being returned
 * - every string is passed through redactSecrets and capped in length (error text can quote provider bodies)
 * - Dates become ISO strings, and anything else that isn't plain JSON (functions, buffers, bigints) is refused
 */
export function secretSafe<T>(value: T): T {
  return walk(value, "$", 0) as T;
}

function walk(value: unknown, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new SecretFieldError(`${path} (too deep)`);
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const clean = redactSecrets(value);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}… [truncated]` : clean;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 200).map((v, i) => walk(v, `${path}[${i}]`, depth + 1));
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const at = `${path}.${k}`;
      if (isSecretKey(k) && v !== null && v !== undefined && typeof v !== "boolean" &&
        !(typeof v === "number" && /^(inputTokens|outputTokens|totalTokens|cachedTokens|reasoningTokens|tokenCount|tokens)$/.test(k)))
        throw new SecretFieldError(at);
      out[k] = walk(v, at, depth + 1);
    }
    return out;
  }
  throw new SecretFieldError(`${path} (unsupported ${typeof value})`);
}

/** A URL origin only: user info, paths, query and fragment can all carry credentials. Unparseable values are not echoed. */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(unparseable URL omitted)";
  }
}
