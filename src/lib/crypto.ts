import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets at rest: AES-256-GCM with a keyring so keys can be rotated.
 *
 *  - ENCRYPTION_KEYS="k1:<base64>,k2:<base64>" plus ENCRYPTION_PRIMARY_KID=k2 (new writes use the primary key).
 *  - The legacy single ENCRYPTION_KEY is kid "k0" and keeps decrypting values written before the keyring existed.
 *
 * Format: "v2.<kid>.<base64(iv | tag | ciphertext)>". Unprefixed values are the legacy format (kid k0, no AAD).
 * An optional AAD binds a ciphertext to where it is stored (e.g. "ai_apps.api_key_enc"), so it can't be moved.
 */

type Keyring = { primary: string; keys: Map<string, Buffer> };

function toKey(raw: string): Buffer {
  // Accept base64 (32 bytes) or any passphrase (hashed to 32 bytes).
  const b = Buffer.from(raw, "base64");
  return b.length === 32 ? b : createHash("sha256").update(raw).digest();
}

const DEV_KEY = createHash("sha256").update("dev-only-insecure-key").digest();

let cached: { sig: string; ring: Keyring } | undefined;

export function keyring(): Keyring {
  const sig = `${process.env.ENCRYPTION_KEYS ?? ""}|${process.env.ENCRYPTION_PRIMARY_KID ?? ""}|${process.env.ENCRYPTION_KEY ?? ""}|${process.env.NODE_ENV}`;
  if (cached?.sig === sig) return cached.ring;

  const keys = new Map<string, Buffer>();
  if (process.env.ENCRYPTION_KEY) keys.set("k0", toKey(process.env.ENCRYPTION_KEY));
  for (const entry of (process.env.ENCRYPTION_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    if (i <= 0) throw new Error("ENCRYPTION_KEYS entries must look like <kid>:<base64 key>");
    const kid = entry.slice(0, i);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(kid)) throw new Error(`Invalid key id "${kid}" in ENCRYPTION_KEYS`);
    keys.set(kid, toKey(entry.slice(i + 1)));
  }
  if (!keys.size) {
    if (process.env.NODE_ENV === "production") throw new Error("ENCRYPTION_KEY or ENCRYPTION_KEYS is required in production");
    keys.set("k0", DEV_KEY);
  }
  const primary = process.env.ENCRYPTION_PRIMARY_KID || (keys.has("k0") && keys.size === 1 ? "k0" : [...keys.keys()].at(-1)!);
  if (!keys.has(primary)) throw new Error(`ENCRYPTION_PRIMARY_KID "${primary}" is not in the keyring`);
  const ring = { primary, keys };
  cached = { sig, ring };
  return ring;
}

/** Where each encrypted column lives; used as AAD so ciphertexts can't be swapped between columns. */
export const AAD = {
  appApiKey: "ai_apps.api_key_enc",
  mcpHeaders: "mcp_servers.headers_enc",
  webSearchKey: "settings.tools.webSearch.apiKeyEnc",
  userAccessToken: "user_tokens.access_token_enc",
  userRefreshToken: "user_tokens.refresh_token_enc",
  routineWebhookSecret: "routines.webhook_secret",
  /** Row-bound: "<column>|<row id>". */
  userCredentialSecret: "user_credentials.secret_enc",
  chatgptDeviceAuth: "chatgpt_device_logins.device_auth_enc",
  /** Row-bound: "<column>|<server id>". */
  mcpIdentitySecret: "mcp_servers.identity_secret_enc",
} as const;

export function encrypt(plain: string, aad?: string): string {
  const { primary, keys } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(primary)!, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v2.${primary}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

function parse(payload: string): { kid: string; data: Buffer; legacy: boolean } {
  if (payload.startsWith("v2.")) {
    const dot = payload.indexOf(".", 3);
    if (dot < 0) throw new Error("Malformed encrypted value");
    return { kid: payload.slice(3, dot), data: Buffer.from(payload.slice(dot + 1), "base64"), legacy: false };
  }
  return { kid: "k0", data: Buffer.from(payload, "base64"), legacy: true };
}

export function decrypt(payload: string, aad?: string): string {
  const { kid, data, legacy } = parse(payload);
  const key = keyring().keys.get(kid);
  if (!key) throw new Error(`Unknown encryption key id "${kid}"`);
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  // Legacy values were written without AAD.
  if (aad && !legacy) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

/** True when the value should be re-encrypted (legacy format, or not under the primary key). */
export function needsRewrap(payload: string): boolean {
  const { kid, legacy } = parse(payload);
  return legacy || kid !== keyring().primary;
}

/** Re-encrypts a value under the primary key (and AAD). Returns null when it is already current. */
export function rewrap(payload: string, aad?: string): string | null {
  return needsRewrap(payload) ? encrypt(decrypt(payload, aad), aad) : null;
}

export const encryptOptional = (v?: string | null, aad?: string) => (v ? encrypt(v, aad) : null);
export const decryptOptional = (v?: string | null, aad?: string) => (v ? decrypt(v, aad) : undefined);

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** URL-safe random token, e.g. randomToken("ptl_run_"). */
export function randomToken(prefix = "", bytes = 32): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function toolApprovalSecret(binding?: string): string {
  const secret = process.env.TOOL_APPROVAL_SECRET ?? createHash("sha256").update(`approval:${process.env.AUTH_SECRET ?? "dev"}`).digest("base64");
  return binding ? createHmac("sha256", secret).update(binding).digest("base64") : secret;
}
