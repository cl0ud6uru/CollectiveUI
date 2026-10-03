import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { assertBrandingOrigin, normalizeLogo, readLogoBody } from "@/lib/branding/logo";
import { BrandingInput, LOGO_MAX_BYTES } from "@/lib/branding/shared";
import { safeCallback } from "@/lib/auth/callback";

const image = () => sharp({ create: { width: 800, height: 400, channels: 4, background: "#aceedd" } });

describe("public branding image validation", () => {
  it.each(["png", "jpeg", "webp"] as const)("decodes %s, scales it, and stores only a clean PNG", async (format) => {
    const input = await image().withMetadata().toFormat(format).toBuffer();
    const output = await normalizeLogo(input, `image/${format}`);
    expect(await sharp(output).metadata()).toMatchObject({ format: "png", width: 512, height: 256 });
    expect((await sharp(output).metadata()).exif).toBeUndefined();
    expect((await sharp(output).metadata()).icc).toBeUndefined();
  });
  it("rejects empty, oversized, spoofed, truncated, SVG and HTML inputs", async () => {
    for (const input of [Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from("<html>bad</html>"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])]) {
      await expect(normalizeLogo(input, "image/png")).rejects.toMatchObject({ status: expect.any(Number) });
    }
    await expect(normalizeLogo(Buffer.alloc(LOGO_MAX_BYTES + 1), "image/png")).rejects.toMatchObject({ status: 413 });
    await expect(normalizeLogo(await image().png().toBuffer(), "image/jpeg")).rejects.toMatchObject({ status: 415 });
    await expect(normalizeLogo(await image().png().toBuffer(), "image/svg+xml")).rejects.toMatchObject({ status: 415 });
  });
  it("rejects excessive dimensions and animation", async () => {
    const wide = await sharp({ create: { width: 2049, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    await expect(normalizeLogo(wide, "image/png")).rejects.toMatchObject({ status: 400 });
    const animated = await sharp(Buffer.concat([Buffer.alloc(4 * 2 * 4, 128), Buffer.alloc(4 * 2 * 4, 255)]), { raw: { width: 4, height: 4, channels: 4, pageHeight: 2 } }).webp().toBuffer();
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    await expect(normalizeLogo(animated, "image/webp")).rejects.toMatchObject({ status: 400 });
  });
  it("caps streamed bytes even without Content-Length", async () => {
    const request = new Request("http://localhost/api/admin/branding/logo", { method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array(LOGO_MAX_BYTES + 1) });
    await expect(readLogoBody(request)).rejects.toMatchObject({ status: 413 });
    await expect(readLogoBody(new Request(request.url, { method: "POST", body: "bad" }))).rejects.toMatchObject({ status: 415 });
  });
  it("requires a matching browser Origin, including when AUTH_URL is configured", () => {
    vi.stubEnv("AUTH_URL", "https://portal.example");
    const request = (origin?: string) => new Request("http://internal:3000/api/admin/branding/logo", { headers: origin ? { origin } : {} });
    expect(() => assertBrandingOrigin(request("https://portal.example"))).not.toThrow();
    for (const origin of [undefined, "null", "https://evil.example", "https://portal.example.evil"]) expect(() => assertBrandingOrigin(request(origin))).toThrow("Invalid request origin");
    vi.unstubAllEnvs();
  });
});

describe("branding text and auth redirects", () => {
  const base = { appName: " Company ", welcomeText: "Hi", logoEmoji: "✨" };
  it("keeps existing branding compatible, trims names, and strips private or invented settings", () => {
    expect(BrandingInput.parse({ ...base, logoUrl: "https://evil.example/logo.svg", secret: "x" })).toEqual({ ...base, appName: "Company" });
    for (const input of [{ ...base, appName: " " }, { ...base, appName: "a".repeat(61) }, { ...base, loginHeadline: "a".repeat(101) }, { ...base, loginDescription: "a".repeat(241) }]) expect(BrandingInput.safeParse(input).success).toBe(false);
  });
  it("allows local callback paths and rejects external and backslash redirects", () => {
    expect(safeCallback("/bots?tab=mine")).toBe("/bots?tab=mine");
    for (const input of [undefined, ["/"], "https://evil.example", "//evil.example", "/\\evil.example", "/\n/evil.example"]) expect(safeCallback(input)).toBe("/");
  });
});
