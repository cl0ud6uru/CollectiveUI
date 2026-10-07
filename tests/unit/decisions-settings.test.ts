import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ admin: vi.fn(), principal: vi.fn(), assert: vi.fn(), app: vi.fn(), provider: vi.fn(), save: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/session", () => ({ requireAdmin: h.admin }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: h.principal }));
vi.mock("@/lib/authz", () => ({ assertAdmin: h.assert, getAccessibleModel: h.app, HttpError: class extends Error {
  constructor(_status: number, message: string) { super(message); }
} }));
vi.mock("@/lib/llm/resolve", () => ({ providerContextFor: h.provider }));
vi.mock("@/lib/settings", () => ({ setSetting: h.save }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
import { saveDecisionsSettings } from "@/app/admin/decisions-actions";
beforeEach(() => {
  vi.resetAllMocks();
  const admin = { isAdmin: true, user: { id: "admin", sessionVersion: 1 } };
  h.admin.mockResolvedValue(admin); h.principal.mockResolvedValue(admin);
  h.app.mockResolvedValue({ enabled: true, provider: "openai", credentialMode: "org", baseUrl: null });
  h.provider.mockResolvedValue({ baseUrl: null });
});
describe("Decisions admin settings gates", () => {
  it("requires admin access and rechecks a changed session", async () => {
    h.admin.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(saveDecisionsSettings({})).rejects.toThrow("Forbidden");
    h.principal.mockResolvedValueOnce(null);
    await expect(saveDecisionsSettings({})).rejects.toThrow("Your access changed");
    h.assert.mockImplementationOnce(() => { throw new Error("Admin revoked"); });
    await expect(saveDecisionsSettings({})).rejects.toThrow("Admin revoked");
    expect(h.save).not.toHaveBeenCalled();
  });
  it("validates the enabled provider and never performs inference during save", async () => {
    await saveDecisionsSettings({ queenRouting: true, providerAppId: "api" });
    expect(h.app).toHaveBeenCalledTimes(1); expect(h.provider).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith("decisions", { queenRouting: true, providerAppId: "api" });
    expect(h.audit).toHaveBeenCalledWith("admin", "settings.decisions", undefined, { queenRouting: true, providerAppId: "api" });
    expect(h.revalidate).toHaveBeenCalledWith("/admin/tools");
  });
  it.each(["hermes", "chatgpt", "openai-compatible", "azure"])("denies enabling with %s even if UI is bypassed", async provider => {
    h.app.mockResolvedValue({ enabled: true, provider, credentialMode: "org", baseUrl: null });
    await expect(saveDecisionsSettings({ queenRouting: true, providerAppId: "api" })).rejects.toThrow("requires a company OpenAI");
    expect(h.save).not.toHaveBeenCalled();
  });
  it("denies missing, inaccessible or unsupported saved provider", async () => {
    await expect(saveDecisionsSettings({ queenRouting: true })).rejects.toThrow("Choose a company");
    h.app.mockRejectedValueOnce(new Error("Access revoked"));
    await expect(saveDecisionsSettings({ queenRouting: true, providerAppId: "api" })).rejects.toThrow("Access revoked");
    h.provider.mockResolvedValue({ baseUrl: "https://proxy.example/v1" });
    await expect(saveDecisionsSettings({ queenRouting: true, providerAppId: "api" })).rejects.toThrow("endpoint does not support");
    expect(h.save).not.toHaveBeenCalled();
  });
  it("can switch off after losing the provider, without reading credentials", async () => {
    await saveDecisionsSettings({ queenRouting: false, providerAppId: "revoked" });
    expect(h.app).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledWith("decisions", { queenRouting: false, providerAppId: "revoked" });
  });
});
