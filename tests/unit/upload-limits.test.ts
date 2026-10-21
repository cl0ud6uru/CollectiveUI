import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ limits: { uploadMaxMb: 20, maxAttachmentsPerMessage: 10 }, save: vi.fn(), put: vi.fn(), insert: vi.fn(), submit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ user: { id: "fixture" }, isAdmin: true }),
  requirePrincipal: async () => ({ user: { id: "fixture" } }),
  errorResponse: (error: { status?: number; message: string }) => Response.json({ error: error.message }, { status: error.status ?? 500 }) }));
vi.mock("@/lib/auth/origin", () => ({ assertAuthOrigin: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => fixture.limits, setSetting: fixture.save }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/files/storage", () => ({ storage: () => ({ put: fixture.put }) }));
vi.mock("@/lib/files/extract", () => ({ extractText: vi.fn(), isImage: () => true }));
vi.mock("@/db", () => ({ db: { insert: () => ({ values: fixture.insert }) } }));
vi.mock("@/components/admin/branding-form", () => ({ BrandingForm: () => null }));
vi.mock("@/lib/remote-hermes/sessions", async () => {
  const { z } = await import("zod");
  return { profileName: z.string(), browseNativeSessions: vi.fn(), nativeHistory: vi.fn(), nativeControl: vi.fn(), nativeSnapshot: vi.fn(), openNativeSession: vi.fn(), submitNativePrompt: fixture.submit };
});

import nextConfig from "../../next.config";
import { MAX_UPLOAD_BODY_MB, MAX_UPLOAD_MB, effectiveUploadMaxMb } from "@/lib/files/upload-limits";
import { architectSettingsUpdateInput } from "@/lib/admin/architect-settings";
import { saveLimits } from "@/app/admin/actions";
import { POST } from "@/app/api/files/route";
import { POST as hermesPOST } from "@/app/api/hermes/[connectionId]/route";
import { SettingsForm } from "@/components/admin/settings-form";

const mb = 1024 * 1024;
function uploadRequest(size: number, bearer = false) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(size)], "fixture.png", { type: "image/png" }));
  return new Request("https://fixture.invalid/api/files", { method: "POST", headers: bearer ? { authorization: "Bearer synthetic-mobile-token" } : {}, body: form });
}
beforeEach(() => {
  fixture.limits = { uploadMaxMb: 20, maxAttachmentsPerMessage: 10 };
  fixture.save.mockReset(); fixture.put.mockReset(); fixture.insert.mockReset(); fixture.submit.mockReset();
  fixture.put.mockResolvedValue(undefined); fixture.insert.mockResolvedValue(undefined); fixture.submit.mockResolvedValue({ status: "accepted" });
});

describe("one supported upload limit across settings and transport", () => {
  it("keeps accepted files below both bounded request buffers", () => {
    expect(MAX_UPLOAD_MB).toBe(25); expect(MAX_UPLOAD_BODY_MB).toBe(30);
    expect(MAX_UPLOAD_MB).toBeLessThan(MAX_UPLOAD_BODY_MB);
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(`${MAX_UPLOAD_BODY_MB}mb`);
    expect(nextConfig.experimental?.serverActions).toMatchObject({ bodySizeLimit: `${MAX_UPLOAD_BODY_MB}mb` });
    expect(effectiveUploadMaxMb(20)).toBe(20); expect(effectiveUploadMaxMb(500)).toBe(25);
  });
  it.each([26, 40, 500])("rejects unsupported new %s MB settings through Admin and Architect without saving", async uploadMaxMb => {
    await expect(saveLimits({ uploadMaxMb, maxAttachmentsPerMessage: 10 })).rejects.toThrow("at most 25 MB");
    expect(architectSettingsUpdateInput.safeParse({ setting: "limits", expectedUpdatedAt: null, uploadMaxMb, maxAttachmentsPerMessage: 10 }).success).toBe(false);
    expect(fixture.save).not.toHaveBeenCalled();
  });
  it.each([1, 20, 25])("allows %s MB through both settings schemas", async uploadMaxMb => {
    await saveLimits({ uploadMaxMb, maxAttachmentsPerMessage: 10 });
    expect(fixture.save).toHaveBeenCalledWith("limits", { uploadMaxMb, maxAttachmentsPerMessage: 10 });
    expect(architectSettingsUpdateInput.safeParse({ setting: "limits", expectedUpdatedAt: null, uploadMaxMb, maxAttachmentsPerMessage: 10 }).success).toBe(true);
  });
  it("shows the legacy configured value and effective maximum without silently rewriting it", () => {
    const html = renderToStaticMarkup(createElement(SettingsForm, { branding: { appName: "Fixture", welcomeText: "", logoEmoji: "" }, initialLogoUrl: null,
      limits: { uploadMaxMb: 500, maxAttachmentsPerMessage: 10 }, apps: [], bots: [], loginPet: { appearance: "off", catalogId: null, revision: null }, petCatalog: [] }));
    expect(html).toContain('value="500"'); expect(html).toContain('max="25"');
    expect(html).toContain("The saved 500 MB limit exceeds the supported 25 MB maximum.");
    expect(html).toContain("Uploads currently use 25 MB."); expect(fixture.save).not.toHaveBeenCalled();
  });
  it.each([false, true])("rejects a legacy oversized upload with its effective limit; native bearer=%s", async bearer => {
    fixture.limits.uploadMaxMb = 500;
    const response = await POST(uploadRequest(MAX_UPLOAD_MB * mb + 1, bearer));
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: "Files must be 25 MB or smaller." });
    expect(fixture.put).not.toHaveBeenCalled(); expect(fixture.insert).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
  });
  it("accepts the 25 MB supported boundary under a larger legacy setting", async () => {
    fixture.limits.uploadMaxMb = 500;
    const request = uploadRequest(MAX_UPLOAD_MB * mb);
    expect((await request.clone().arrayBuffer()).byteLength).toBeLessThan(MAX_UPLOAD_BODY_MB * mb);
    expect((await POST(request)).status).toBe(200); expect(fixture.put).toHaveBeenCalledOnce();
    expect(fixture.insert).toHaveBeenCalledWith(expect.objectContaining({ size: MAX_UPLOAD_MB * mb }));
  });
  it("retains a lower configured limit and reports it on incomplete multipart data", async () => {
    fixture.limits.uploadMaxMb = 10;
    const response = await POST(uploadRequest(10 * mb + 1));
    expect(response.status).toBe(413); expect((await response.json()).error).toContain("10 MB");
    const truncated = new Request("https://fixture.invalid/api/files", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=missing" }, body: "incomplete" });
    const incomplete = await POST(truncated);
    expect(incomplete.status).toBe(413); expect((await incomplete.json()).error).toContain("10 MB");
    expect(fixture.put).not.toHaveBeenCalled();
  });
  it.each([[500, 20], [10, 10]])("bounds Hermes files under saved %s MB to %s MB and reports that limit", async (configured, effective) => {
    fixture.limits.uploadMaxMb = configured;
    const form = new FormData();
    form.append("request", JSON.stringify({ operation: "submit", sessionId: "synthetic-session", requestId: "00000000-0000-4000-8000-000000000001", text: "Synthetic" }));
    form.append("files", new File([new Uint8Array(effective * mb + 1)], "fixture.png", { type: "image/png" }));
    const response = await hermesPOST(new Request("https://fixture.invalid/api/hermes/fixture", { method: "POST", body: form }), { params: Promise.resolve({ connectionId: "fixture" }) });
    expect(response.status).toBe(413); expect(await response.json()).toEqual({ error: `Hermes attachments must be ${effective} MB or smaller.` });
    expect(fixture.submit).not.toHaveBeenCalled();
  });
  it("reports an incomplete Hermes multipart request as a bounded upload error", async () => {
    const request = new Request("https://fixture.invalid/api/hermes/fixture", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=missing" }, body: "incomplete" });
    const response = await hermesPOST(request, { params: Promise.resolve({ connectionId: "fixture" }) });
    expect(response.status).toBe(413); expect((await response.json()).error).toContain("entire attachment request under 25 MB");
    expect(fixture.submit).not.toHaveBeenCalled();
  });
});
