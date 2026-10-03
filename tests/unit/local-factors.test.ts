import { afterEach, describe, expect, it, vi } from "vitest";
import { generate } from "otplib";
import { assertSecurityOrigin, bindingCookieName, readBinding, securityConfig, createTotp, openTotp, sealTotp, checkTotp, recoveryHash, createRecoveryCodes } from "@/lib/auth/factors";
import { securityRequest } from "@/lib/auth/security-request";
vi.mock("@/lib/auth/throttle", () => ({ allowSecurityRequest: vi.fn(async () => true) }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const key = Buffer.alloc(32, 81).toString("base64");
it("enforces fixed HTTPS origin/RP and localhost-only development; never trusts Host", () => {
  vi.stubEnv("NODE_ENV", "test");
  for (const origin of ["http://example.test", "http://127.0.0.1", "https://u:p@example.test", "https://example.test/path", "https://example.test?a=1"]) {
    vi.stubEnv("AUTH_URL", origin); expect(() => securityConfig()).toThrow();
  }
  vi.stubEnv("AUTH_URL", "http://localhost:3100"); expect(securityConfig().rpID).toBe("localhost");
  vi.stubEnv("NODE_ENV", "production"); expect(() => securityConfig()).toThrow();
  vi.stubEnv("AUTH_URL", "https://login.example.test");
  expect(bindingCookieName()).toBe("__Host-collective-preauth");
  for (const origin of ["", "null", "https://evil.test", "http://login.example.test"]) expect(() => assertSecurityOrigin(new Headers({ origin, host: "login.example.test" }))).toThrow();
  expect(() => assertSecurityOrigin(new Headers({ origin: "https://login.example.test" }))).not.toThrow();
  expect(() => assertSecurityOrigin(new Headers({ origin: "https://login.example.test", "sec-fetch-site": "cross-site" }))).toThrow();
  const cookie = `__Host-collective-preauth=${"x".repeat(43)}`;
  expect(readBinding(new Headers({ cookie }))).toHaveLength(43);
  expect(readBinding(new Headers({ cookie: `${cookie}; ${cookie}` }))).toBe("");
});
it("rejects missing/weak encryption configuration, legacy ciphertext and cross-account substitution", () => {
  vi.stubEnv("ENCRYPTION_KEYS", ""); vi.stubEnv("ENCRYPTION_KEY", "");
  expect(() => sealTotp("secret", "alice")).toThrow();
  vi.stubEnv("ENCRYPTION_KEY", "weak-passphrase"); expect(() => sealTotp("secret", "alice")).toThrow();
  vi.stubEnv("ENCRYPTION_KEY", key);
  const encrypted = sealTotp("synthetic-secret", "alice");
  expect(encrypted).not.toContain("synthetic-secret");
  expect(openTotp(encrypted, "alice")).toBe("synthetic-secret");
  expect(() => openTotp(encrypted, "bob")).toThrow();
  expect(() => openTotp(encrypted.split(".")[2], "alice")).toThrow();
  vi.stubEnv("ENCRYPTION_KEYS", `k1:${key}, k2:${Buffer.alloc(32, 82).toString("base64")}`); vi.stubEnv("ENCRYPTION_PRIMARY_KID", "k2");
  expect(openTotp(encrypted, "alice")).toBe("synthetic-secret");
  expect(sealTotp("secret", "alice")).toMatch(/^v2.k2./);
  vi.stubEnv("ENCRYPTION_KEY", "weak-legacy"); vi.stubEnv("ENCRYPTION_PRIMARY_KID", "k0");
  expect(() => sealTotp("secret", "alice")).toThrow();
});
it("uses library TOTP verification with a +/- one-step window and monotonically accepted steps", async () => {
  vi.stubEnv("ENCRYPTION_KEY", key); vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.useFakeTimers(); const epoch = 1790995200; vi.setSystemTime(epoch * 1000);
  const enrollment = createTotp("alice", "synthetic-user");
  expect(enrollment.uri).toContain("otpauth://totp/");
  const token = await generate({ secret: enrollment.secret, epoch });
  const step = await checkTotp(enrollment.totpEnc, "alice", token);
  await expect(checkTotp(enrollment.totpEnc, "alice", token, step)).rejects.toThrow();
  await expect(checkTotp(enrollment.totpEnc, "alice", await generate({ secret: enrollment.secret, epoch: epoch - 60 }))).rejects.toThrow();
  await expect(checkTotp(enrollment.totpEnc, "alice", await generate({ secret: enrollment.secret, epoch: epoch + 60 }))).rejects.toThrow();
  expect(await checkTotp(enrollment.totpEnc, "alice", await generate({ secret: enrollment.secret, epoch: epoch + 30 }), step)).toBe(step + 1);
  await expect(checkTotp(enrollment.totpEnc, "alice", "1234567")).rejects.toThrow();
});
it("generates independent, account-bound high-entropy recovery codes", () => {
  const codes = createRecoveryCodes(); expect(new Set(codes).size).toBe(10);
  for (const code of codes) {
    expect(code).toMatch(/^[A-F0-9]{8}(-[A-F0-9]{8}){4}$/);
    expect(recoveryHash("alice", code)).not.toBe(recoveryHash("bob", code));
    expect(recoveryHash("alice", code)).toBe(recoveryHash("alice", code.toLowerCase()));
  }
});
describe("sensitive JSON request boundary", () => {
  it("rejects wrong/missing origin, wrong media type, extra fields and oversized streamed bodies", async () => {
    vi.stubEnv("AUTH_URL", "https://example.test");
    for (const headers of [{ "content-type": "application/json" }, { origin: "https://evil.test", "content-type": "application/json" }, { origin: "https://example.test", "content-type": "text/plain" }]) {
      await expect(securityRequest(new Request("https://example.test", { method: "POST", headers: headers as Record<string, string>, body: '{}' }))).rejects.toThrow();
    }
    const headers = { origin: "https://example.test", "content-type": "application/json" };
    for (const body of [JSON.stringify({ action: "a", admin: true }), "x".repeat(33000)]) await expect(securityRequest(new Request("https://example.test", { method: "POST", headers, body }))).rejects.toThrow();
  });
});
