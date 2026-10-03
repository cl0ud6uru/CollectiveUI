import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AAD, decrypt, encrypt, keyring, needsRewrap, randomToken, rewrap, sha256Hex } from "@/lib/crypto";

const K0 = randomBytes(32).toString("base64");
const K1 = randomBytes(32).toString("base64");

/** The pre-keyring format: base64(iv | tag | ct) with the single ENCRYPTION_KEY and no AAD. */
function legacyEncrypt(plain: string, keyB64: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

describe("crypto keyring", () => {
  beforeEach(() => {
    vi.stubEnv("ENCRYPTION_KEY", K0);
    vi.stubEnv("ENCRYPTION_KEYS", "");
    vi.stubEnv("ENCRYPTION_PRIMARY_KID", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("writes the v2 format under the primary key and decrypts it", () => {
    const v = encrypt("sk-test", AAD.appApiKey);
    expect(v.startsWith("v2.k0.")).toBe(true);
    expect(decrypt(v, AAD.appApiKey)).toBe("sk-test");
  });

  it("still decrypts legacy values written before the keyring", () => {
    const legacy = legacyEncrypt("old-secret", K0);
    expect(decrypt(legacy)).toBe("old-secret");
    expect(decrypt(legacy, AAD.appApiKey)).toBe("old-secret"); // legacy values have no AAD
    expect(needsRewrap(legacy)).toBe(true);
  });

  it("binds ciphertexts to their AAD", () => {
    const v = encrypt("headers", AAD.mcpHeaders);
    expect(() => decrypt(v, AAD.appApiKey)).toThrow();
    expect(() => decrypt(v)).toThrow();
  });

  it("rotates: new writes use the primary kid, old kids keep decrypting, rewrap moves values over", () => {
    const old = encrypt("rotate-me", AAD.appApiKey);
    vi.stubEnv("ENCRYPTION_KEYS", `k1:${K1}`);
    vi.stubEnv("ENCRYPTION_PRIMARY_KID", "k1");
    expect(keyring().primary).toBe("k1");
    expect(decrypt(old, AAD.appApiKey)).toBe("rotate-me");
    const moved = rewrap(old, AAD.appApiKey)!;
    expect(moved.startsWith("v2.k1.")).toBe(true);
    expect(decrypt(moved, AAD.appApiKey)).toBe("rotate-me");
    expect(rewrap(moved, AAD.appApiKey)).toBeNull(); // idempotent
  });

  it("rejects unknown key ids and a primary kid that isn't configured", () => {
    const v = encrypt("x");
    expect(() => decrypt(v.replace("v2.k0.", "v2.nope."))).toThrow(/Unknown encryption key id/);
    vi.stubEnv("ENCRYPTION_PRIMARY_KID", "k9");
    expect(() => keyring()).toThrow(/not in the keyring/);
  });

  it("refuses the insecure dev key in production", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => encrypt("x")).toThrow(/required in production/);
  });

  it("accepts a passphrase as a key by hashing it", () => {
    vi.stubEnv("ENCRYPTION_KEY", "correct horse battery staple");
    expect(keyring().keys.get("k0")).toEqual(createHash("sha256").update("correct horse battery staple").digest());
  });

  it("helpers", () => {
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
    const t = randomToken("ptl_run_");
    expect(t.startsWith("ptl_run_")).toBe(true);
    expect(t).not.toBe(randomToken("ptl_run_"));
  });
});
