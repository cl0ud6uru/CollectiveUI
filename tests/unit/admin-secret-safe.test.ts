import { describe, expect, it } from "vitest";
import { isSecretKey, safeUrl, SecretFieldError, secretSafe } from "@/lib/admin/secret-safe";

describe("admin tool output secret guard", () => {
  it("recognizes credential-like field names in any casing", () => {
    for (const k of ["apiKeyEnc", "api_key_enc", "secretEnc", "credentialsEnc", "headersEnc", "identitySecretEnc", "headers", "password_hash",
      "passwordHash", "tokenHash", "accessToken", "refresh_token_enc", "webhookSecret", "adminKeyEnc", "apiKey", "Authorization", "totpSecretEnc",
      "ref", "env", "privateKey", "deviceAuthEnc", "cookie"])
      expect(isSecretKey(k), k).toBe(true);
    for (const k of ["name", "status", "lastError", "upn", "model", "baseUrl", "enabled", "createdAt", "botId", "provider", "kind"])
      expect(isSecretKey(k), k).toBe(false);
  });

  it("allows presence booleans, known count metrics and null under credential-like names", () => {
    expect(secretSafe({ hasKey: true, hasHeaders: false, inputTokens: 12, tokenHash: null, apiKeyEnc: undefined }))
      .toEqual({ hasKey: true, hasHeaders: false, inputTokens: 12, tokenHash: null, apiKeyEnc: undefined });
    expect(() => secretSafe({ password: 123456 })).toThrow(SecretFieldError);
    expect(() => secretSafe({ apiKeyEnc: "v1:abc" })).toThrow(SecretFieldError);
    expect(() => secretSafe({ app: { providerConfig: { headers: { Authorization: "x" } } } })).toThrow(/\$\.app\.providerConfig\.headers/);
    expect(() => secretSafe([{ name: "ok" }, { secretEnc: { iv: "a", data: "b" } }])).toThrow(/\$\[1\]\.secretEnc/);
    expect(() => secretSafe({ sandbox: { ref: "abc123" } })).toThrow(SecretFieldError);
  });

  it("redacts token-shaped text inside ordinary strings", () => {
    const out = secretSafe({ lastError: "401 for Bearer abcdefghijklmnop with key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX", nested: ["ghp_ABCDEFGHIJKLMNOPQRSTUV1234"] });
    expect(JSON.stringify(out)).not.toMatch(/abcdefghijklmnop|sk-proj-ABC|ghp_ABC/);
    expect(out.lastError).toContain("[redacted]");
  });

  it("serializes dates, caps long strings and refuses non-JSON values", () => {
    expect(secretSafe({ at: new Date("2026-10-11T00:00:00Z") })).toEqual({ at: "2026-10-11T00:00:00.000Z" });
    expect(secretSafe({ text: "x".repeat(5000) }).text).toHaveLength(4000 + "… [truncated]".length);
    expect(secretSafe({ n: Number.POSITIVE_INFINITY })).toEqual({ n: null });
    expect(() => secretSafe({ buf: Buffer.from("secret") })).toThrow(SecretFieldError);
    expect(() => secretSafe({ f: () => 1 })).toThrow(SecretFieldError);
    expect(() => secretSafe({ big: BigInt(1) })).toThrow(SecretFieldError);
  });

  it("does not mutate its input", () => {
    const input = { lastError: "Bearer abcdefghijklmnop" };
    secretSafe(input);
    expect(input.lastError).toBe("Bearer abcdefghijklmnop");
  });

  it("drops user info, query and fragment from URLs", () => {
    expect(safeUrl("https://user:pw@mcp.example:8443/v1/mcp?token=abc#frag")).toBe("https://mcp.example:8443");
    expect(safeUrl("https://api.openai.com/v1")).toBe("https://api.openai.com");
    expect(safeUrl("not a url with secret")).toBe("(unparseable URL omitted)");
    expect(safeUrl(null)).toBeNull();
  });
});
