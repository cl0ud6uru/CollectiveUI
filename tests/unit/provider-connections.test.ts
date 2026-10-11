import { describe, expect, it, vi } from "vitest";
vi.mock("@/db", () => ({ db: {} }));
import { assertConnectionTarget, connectionConfig, openProviderCredential, providerConnectionView, sealProviderCredential, type ProviderConnection } from "@/lib/llm/provider-connections";
import { AppInput } from "@/lib/llm/catalog";
import { openAppSecret } from "@/lib/llm/secrets";

const fixture = (): ProviderConnection => ({ id: "conn-1", name: "Fixture project", provider: "openai", baseUrl: null, organization: "org-one", project: "proj-one",
  enabled: true, createdBy: "admin", createdAt: new Date(), updatedAt: new Date(), credentialEnc: sealProviderCredential("conn-1", "fixture-provider-key") });

describe("saved provider credentials", () => {
  it("binds encryption to both the connection row and column", () => {
    const row = fixture();
    expect(row.credentialEnc).not.toContain("fixture-provider-key");
    expect(openProviderCredential(row)).toBe("fixture-provider-key");
    expect(() => openProviderCredential({ ...row, id: "other" })).toThrow();
    expect(() => openAppSecret({ id: row.id, apiKeyEnc: row.credentialEnc })).toThrow();
  });
  it("returns only whitelisted metadata to administrators", () => {
    const row = fixture();
    const view = providerConnectionView(row);
    expect(view.createdBy).toBe("admin");
    expect(view).not.toHaveProperty("credentialEnc");
    expect(JSON.stringify(view)).not.toContain(row.credentialEnc);
    expect(JSON.stringify(view)).not.toContain("fixture-provider-key");
  });
  it("pins credential endpoint and billing selectors while keeping model flags", () => {
    const row = fixture();
    expect(connectionConfig(row, { reasoning: true, project: "other", store: false, apiKey: "ignored" })).toEqual({ organization: "org-one", project: "proj-one", reasoning: true, store: false });
    expect(() => assertConnectionTarget(row, "openai", null, { organization: "org-one", project: "proj-one" })).not.toThrow();
    for (const [kind, url, config] of [
      ["openai", "https://attacker.invalid/v1", { organization: "org-one", project: "proj-one" }],
      ["openai", null, { organization: "org-one", project: "other" }],
      ["openai", null, { organization: "other", project: "proj-one" }],
      ["chatgpt", null, {}], ["hermes", null, {}],
    ] as const) expect(() => assertConnectionTarget(row, kind, url, config)).toThrow();
  });
  it("keeps saved API credentials out of personal plans and Hermes", () => {
    for (const provider of ["chatgpt", "hermes", "anthropic"]) {
      expect(AppInput.safeParse({ name: "Fixture", provider, providerConnectionId: "conn-1", model: "model", supportsTools: true, supportsVision: false, isPublic: true, enabled: true }).success).toBe(false);
    }
  });
  it("supports compatible credentials with exact destination and API type matching", () => {
    const row = { ...fixture(), provider: "openai-compatible" as const, baseUrl: "https://provider.example/api/v1/", organization: null, project: null };
    expect(connectionConfig(row, { store: true, organization: "ignored", project: "ignored", apiKey: "ignored" })).toEqual({});
    expect(() => assertConnectionTarget(row, "openai-compatible", row.baseUrl, {})).not.toThrow();
    for (const [kind, url] of [["openai", row.baseUrl], ["openai-compatible", "https://provider.example/other/v1/"], ["openai-compatible", "https://other.example/api/v1/"]]) {
      expect(() => assertConnectionTarget(row, kind, url, {})).toThrow();
    }
    expect(providerConnectionView(row)).toMatchObject({ provider: "openai-compatible", baseUrl: row.baseUrl });
    expect(providerConnectionView(row)).not.toHaveProperty("credentialEnc");
    expect(AppInput.safeParse({ name: "Fixture", provider: "openai-compatible", providerConnectionId: row.id, baseUrl: row.baseUrl, model: "model", supportsTools: true, supportsVision: false, isPublic: true, enabled: true }).success).toBe(true);
  });
});
