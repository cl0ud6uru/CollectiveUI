import { describe, expect, it, vi } from "vitest";
import type { AiApp } from "@/db/schema";

vi.mock("@/db", () => ({ db: {} }));

import { AAD, encrypt } from "@/lib/crypto";
import { planAppWrite, planConnectionTest } from "@/lib/llm/app-form";
import { AppInput, CONFIG_SCHEMAS } from "@/lib/llm/catalog";
import { appSecretNeedsRowBinding, decodeSecret, encodeSecretInput, openAppSecret, sealAppSecret } from "@/lib/llm/secrets";

const SA = JSON.stringify({
  type: "service_account",
  project_id: "p",
  client_email: "sa@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  token_uri: "https://evil.example.com/token",
});
const bedrockKeys = CONFIG_SCHEMAS.bedrock.parse({ region: "us-east-1", auth: "access-keys" });
const bedrockApiKey = CONFIG_SCHEMAS.bedrock.parse({ region: "us-east-1" });
const vertex = CONFIG_SCHEMAS["vertex-anthropic"].parse({ project: "my-proj-1" });

describe("credential encoding", () => {
  it("stores API keys as plain strings (unchanged format) and multi-part credentials as JSON", () => {
    expect(encodeSecretInput("openai", {} as never, { apiKey: " sk-1 " })).toBe("sk-1");
    const aws = encodeSecretInput("bedrock", bedrockKeys, { accessKeyId: "AKIA1", secretAccessKey: "s" })!;
    expect(decodeSecret("bedrock", bedrockKeys, aws)).toEqual({ type: "aws-keys", accessKeyId: "AKIA1", secretAccessKey: "s", sessionToken: undefined });
  });

  it("keeps only email and private key from a service account (never token_uri)", () => {
    const stored = encodeSecretInput("vertex-anthropic", vertex, { serviceAccountJson: SA })!;
    expect(stored).not.toContain("evil.example.com");
    expect(decodeSecret("vertex-anthropic", vertex, stored)).toMatchObject({ type: "service-account", clientEmail: "sa@p.iam.gserviceaccount.com" });
  });

  it("rejects wrong shapes and Claude.ai tokens without echoing the secret", () => {
    expect(() => encodeSecretInput("vertex-anthropic", vertex, { serviceAccountJson: '{"type":"authorized_user"}' })).toThrow(/service account/);
    expect(() => encodeSecretInput("vertex-anthropic", vertex, { serviceAccountJson: "sk-proj-SECRETVALUE not json" })).toThrow(
      /^The service account key is not valid JSON$/,
    );
    expect(() => encodeSecretInput("anthropic", {} as never, { apiKey: "sk-ant-oat01-abcdef" })).toThrow(/Claude.ai/);
    expect(() => encodeSecretInput("openai-compatible", {} as never, { apiKey: "x sk-ant-sid01-abcdef" })).toThrow(/Claude.ai/);
    expect(() => encodeSecretInput("bedrock", bedrockApiKey, { apiKey: "short" })).toThrow(/Bedrock API key/);
    expect(() => encodeSecretInput("bedrock", bedrockKeys, { accessKeyId: "AKIA1" })).toThrow(/both/);
    // A legacy plain key can't be used where structured credentials are needed.
    expect(() => decodeSecret("vertex-anthropic", vertex, "sk-1")).toThrow();
    expect(() => decodeSecret("bedrock", bedrockKeys, "sk-1")).toThrow();
    expect(decodeSecret("bedrock", bedrockApiKey, "ABSKxxxxxxxxxxxxxxxxxxxx")).toEqual({ type: "api-key", apiKey: "ABSKxxxxxxxxxxxxxxxxxxxx" });
  });

  it("binds ciphertexts to the app row and still reads column-bound values", () => {
    const sealed = sealAppSecret("a1", "sk-1");
    expect(openAppSecret({ id: "a1", apiKeyEnc: sealed })).toBe("sk-1");
    expect(() => openAppSecret({ id: "a2", apiKeyEnc: sealed })).toThrow(); // moved to another row
    const old = encrypt("sk-old", AAD.appApiKey);
    expect(openAppSecret({ id: "a1", apiKeyEnc: old })).toBe("sk-old");
    expect(appSecretNeedsRowBinding({ id: "a1", apiKeyEnc: old })).toBe(true);
    expect(appSecretNeedsRowBinding({ id: "a1", apiKeyEnc: sealed })).toBe(false);
  });
});

const existing = (over: Partial<AiApp>): Pick<AiApp, "id" | "provider" | "providerConfig" | "baseUrl" | "apiKeyEnc"> => ({
  id: "a1",
  provider: "openai",
  providerConfig: {},
  baseUrl: null,
  apiKeyEnc: sealAppSecret("a1", "sk-stored"),
  ...over,
});
const input = (over: Record<string, unknown>) =>
  AppInput.parse({ name: "App", model: "m", supportsVision: false, supportsTools: true, isPublic: true, enabled: true, provider: "openai", ...over });

describe("stored credential reuse", () => {
  it("keeps the stored key when nothing about the endpoint changed", () => {
    expect(planAppWrite(input({}), existing({})).secret).toBeUndefined();
  });

  it("requires re-entering the key when the provider or base URL changes", () => {
    expect(() => planAppWrite(input({ provider: "anthropic" }), existing({}))).toThrow(/Re-enter/);
    expect(() => planAppWrite(input({ baseUrl: "https://attacker.example.com/v1" }), existing({}))).toThrow(/Re-enter/);
    expect(() =>
      planAppWrite(
        input({ provider: "openai-compatible", baseUrl: "https://other.internal/v1" }),
        existing({ provider: "openai-compatible", baseUrl: "https://llm.internal/v1" }),
      ),
    ).toThrow(/Re-enter/);
  });

  it("accepts a new key, clears only for OpenAI-compatible, and requires credentials for native providers", () => {
    expect(planAppWrite(input({ credentials: { apiKey: "sk-new" } }), existing({})).secret).toBe("sk-new");
    expect(
      planAppWrite(input({ provider: "openai-compatible", baseUrl: "http://x/v1", credentials: { apiKey: "__clear__" } }), undefined).secret,
    ).toBeNull();
    expect(() => planAppWrite(input({}), undefined)).toThrow(/Enter the credentials/);
    expect(planAppWrite(input({ provider: "openai-compatible", baseUrl: "http://x/v1" }), undefined).secret).toBeNull();
  });

  it("Test connection never uses the stored key for a changed endpoint", () => {
    const stored = existing({});
    expect(planConnectionTest("openai", {}, null, {}, stored).secret).toEqual({ type: "api-key", apiKey: "sk-stored" });
    expect(() => planConnectionTest("openai", {}, "https://attacker.example.com/v1", {}, stored)).toThrow(/Re-enter/);
    expect(() => planConnectionTest("anthropic", {}, null, {}, stored)).toThrow(/Re-enter/);
  });
});
