import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, validateNewPassword, verifyPassword } from "@/lib/auth/password";
import { clientAddress } from "@/lib/auth/throttle";
import { providerEnabled } from "@/lib/auth/config";
import { assertAuthOrigin } from "@/lib/auth/origin";

afterEach(() => vi.unstubAllEnvs());
describe("local password security", () => {
  it("uses distinct salted memory-hard hashes and verifies exact Unicode/whitespace without truncation", async () => {
    const password = "Synthetic fixture 🌙 passphrase  ";
    const a = await hashPassword(password);
    const b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(a).not.toContain(password);
    expect(await verifyPassword(password, a)).toBe(true);
    expect(await verifyPassword(password.trim(), a)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
    expect(await verifyPassword(password, a.replace("131072", "1073741824"))).toBe(false);
  }, 15000);
  it("enforces input bounds and a long passphrase policy", () => {
    for (const bad of ["short", "a".repeat(15), "password1234567890", " ".repeat(20), "a".repeat(129), "\0" + "phrase".repeat(4)]) expect(() => validateNewPassword(bad)).toThrow();
    expect(() => validateNewPassword("Synthetic fixture passphrase!" )).not.toThrow();
    expect(() => validateNewPassword("🌙".repeat(127) + "!" )).not.toThrow();
  });
});
describe("provider and CSRF boundary", () => {
  it("requires local opt-in, preserves LDAP/Entra switches, rejects unknown providers", () => {
    vi.stubEnv("AUTH_LOCAL_ENABLED", "false"); vi.stubEnv("AUTH_ENTRA_ENABLED", "false"); vi.stubEnv("LDAP_ENABLED", "false");
    expect(providerEnabled("local")).toBe(false);
    vi.stubEnv("AUTH_LOCAL_ENABLED", "true"); expect(providerEnabled("local")).toBe(true);
    vi.stubEnv("AUTH_LOCAL_ENABLED", "TRUE"); expect(providerEnabled("local")).toBe(false);
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "synthetic-client"); expect(providerEnabled("microsoft-entra-id")).toBe(false);
    vi.stubEnv("AUTH_ENTRA_ENABLED", "true"); expect(providerEnabled("microsoft-entra-id")).toBe(true);
    vi.stubEnv("LDAP_ENABLED", "true"); vi.stubEnv("LDAP_URL", "ldap://fixture.invalid"); expect(providerEnabled("ldap")).toBe(true);
    expect(providerEnabled("fake")).toBe(false);
  });
  it("rejects missing, null, foreign and wrong-scheme origins regardless of forwarded host", () => {
    vi.stubEnv("AUTH_URL", "https://fixture.example");
    for (const origin of [null, "null", "https://evil.example", "http://fixture.example"]) {
      const h = new Headers({ "x-forwarded-host": "evil.example" }); if (origin) h.set("origin", origin);
      expect(() => assertAuthOrigin(h)).toThrow();
    }
    expect(() => assertAuthOrigin(new Headers({ origin: "https://fixture.example" }))).not.toThrow();
  });
  it("does not trust client forwarding headers by default", () => {
    vi.stubEnv("AUTH_TRUST_PROXY", "false");
    const h = new Headers({ "x-real-ip": "192.0.2.10", "x-forwarded-for": "192.0.2.20" });
    expect(clientAddress(h)).toBe("shared");
    vi.stubEnv("AUTH_TRUST_PROXY", "true"); expect(clientAddress(h)).toBe("192.0.2.10");
    h.set("x-real-ip", "192.0.2.10,192.0.2.20"); expect(clientAddress(h)).toBe("shared");
  });
});

import { absoluteSessionDeadline } from "@/lib/auth/session-state";
it("caps legacy JWTs at the original expiry despite subsequent Auth.js refreshes", () => {
  const legacy = { exp: 1000 };
  const sessionDeadline = absoluteSessionDeadline(legacy);
  expect(sessionDeadline).toBe(1000);
  expect(absoluteSessionDeadline({ exp: 5000, sessionDeadline })).toBe(1000);
  expect(absoluteSessionDeadline({ signedInAt: 100, exp: 999999 })).toBe(43300);
  expect(absoluteSessionDeadline({})).toBe(0);
});
