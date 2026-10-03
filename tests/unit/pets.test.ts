import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { assertPetOrigin, normalizePetSprite, parsePetManifest, readPetBody } from "@/lib/pets/import";
import { DEFAULT_PET, PET_MAX_BYTES, petPreferencesSchema, petState } from "@/lib/pets/shared";

const manifest = { displayName: "Original sample", spritesheetPath: "spritesheet.png" };
const parse = (v: unknown) => parsePetManifest(Buffer.from(JSON.stringify(v)), "Test artist · MIT");

describe("chat companion state", () => {
  const ready = { status: "ready", online: true, unavailable: false, failed: false, approval: false };
  it("defaults off, with no invented live state", () => {
    expect(DEFAULT_PET.enabled).toBe(false);
    expect(petState(ready)).toBe("idle");
    for (const status of ["submitted", "streaming"]) expect(petState({ ...ready, status })).toBe("working");
    expect(petState({ ...ready, approval: true, status: "streaming" })).toBe("approval");
    expect(petState({ ...ready, status: "error" })).toBe("attention");
    expect(petState({ ...ready, failed: true })).toBe("attention");
    expect(petState({ ...ready, online: false, status: "streaming" })).toBe("unavailable");
    expect(petState({ ...ready, unavailable: true, approval: true })).toBe("unavailable");
    expect(petState({ ...ready, failed: true, status: "submitted" })).toBe("working");
  });
  it("validates preferences and rejects injected storage fields", () => {
    expect(petPreferencesSchema.safeParse({ mode: "personal", catalogId: null, appearance: "moss", motion: "still" }).success).toBe(true);
    for (const v of [{ enabled: "true" }, { enabled: true, appearance: "https://bad", motion: "auto" }, { enabled: true, appearance: "moss", motion: "auto", userId: "other" }]) expect(petPreferencesSchema.safeParse(v).success).toBe(false);
  });
});

describe("explicit inherited pet preferences", () => {
  it("accepts follow/personal/off and requires an exact catalog reference", () => {
    for (const mode of ["follow", "personal", "off"]) {
      expect(petPreferencesSchema.safeParse({ mode, appearance: "moss", catalogId: null, motion: "auto" }).success).toBe(true);
      expect(petPreferencesSchema.safeParse({ mode, appearance: "catalog", catalogId: "approved-pet", motion: "still" }).success).toBe(true);
    }
    const base = { mode: "personal", appearance: "catalog", catalogId: "approved-pet", motion: "auto" };
    for (const patch of [{ catalogId: null }, { appearance: "custom" }, { mode: "default" }, { userId: "other" }, { enabled: true }])
      expect(petPreferencesSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe("bounded data-only pet imports", () => {
  it("accepts canonical v1/v2 and discards inert extra metadata", () => {
    expect(parse({ ...manifest, kind: "animal", ignored: "never evaluated" })).toEqual({ ...manifest, description: "", spriteVersionNumber: 1, credit: "Test artist · MIT" });
    expect(parse({ ...manifest, spriteVersionNumber: 2 }).spriteVersionNumber).toBe(2);
  });
  it.each(["../spritesheet.png", "https://example.com/pet.png", "file:///tmp/pet.png", "/spritesheet.png", "pet.svg", "spritesheet.png?x=1", "a\\spritesheet.png"])("rejects untrusted sprite references: %s", (spritesheetPath) => {
    expect(() => parse({ ...manifest, spritesheetPath })).toThrow();
  });
  it("rejects malformed, oversized, unsupported and executable format declarations", () => {
    for (const v of [null, [], {}, { ...manifest, spriteVersionNumber: 3 }, { ...manifest, spriteVersionNumber: "2" }, { ...manifest, displayName: "x".repeat(81) }, { ...manifest, states: {} }, { ...manifest, animations: [] }, { ...manifest, frameWidth: 4096 }]) expect(() => parse(v)).toThrow();
    expect(() => parsePetManifest(Buffer.from("not-json"), "")).toThrow(/valid JSON/);
    expect(() => parsePetManifest(Buffer.alloc(16385), "")).toThrow(/16 KB/);
    expect(() => parsePetManifest(Buffer.from(JSON.stringify(manifest)), "\u0000")).toThrow();
  });
  it("bounds actual request bytes, even without Content-Length", async () => {
    const req = new Request("http://localhost/upload", { method: "POST", body: "12345" });
    await expect(readPetBody(req, 4)).rejects.toThrow(/too large/);
    expect(await readPetBody(new Request("http://localhost/upload", { method: "POST", body: "1234" }), 4)).toEqual(Buffer.from("1234"));
    await expect(readPetBody(new Request("http://localhost/upload", { method: "POST", headers: { "Content-Length": "200" }, body: "x" }), 4)).rejects.toThrow();
  });
  it("refuses cross-site or missing origins", () => {
    const url = process.env.AUTH_URL ?? "http://localhost:3102";
    expect(() => assertPetOrigin(new Request(url, { headers: { origin: new URL(url).origin } }))).not.toThrow();
    expect(() => assertPetOrigin(new Request(url, { headers: { origin: "https://attacker.example" } }))).toThrow();
    expect(() => assertPetOrigin(new Request(url))).toThrow();
  });
  it("decodes PNG and WebP to clean PNG with the correct atlas size", async () => {
    for (const version of [1, 2] as const) {
      const sprite = sharp({ create: { width: 1536, height: version === 2 ? 2288 : 1872, channels: 4, background: "#6a805c88" } });
      for (const format of ["png", "webp"] as const) {
        const original = await sprite.clone()[format]().toBuffer();
        const png = await normalizePetSprite(original, version, `spritesheet.${format}`);
        const meta = await sharp(png).metadata();
        expect(meta.format).toBe("png"); expect(meta.width).toBe(1536); expect(meta.height).toBe(version === 2 ? 2288 : 1872); expect(meta.exif).toBeUndefined();
      }
    }
  });
  it("rejects SVG, HTML, archives, truncation, mismatched versions/names, oversized pixels and bytes", async () => {
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from("<html><script>alert(1)</script>"), Buffer.from("PK\x03\x04zip"), Buffer.alloc(PET_MAX_BYTES + 1)]) await expect(normalizePetSprite(bytes, 1, "spritesheet.png")).rejects.toThrow();
    const png = await sharp({ create: { width: 1536, height: 1872, channels: 4, background: "transparent" } }).png().toBuffer();
    await expect(normalizePetSprite(png, 2, "spritesheet.png")).rejects.toThrow(/2288/);
    await expect(normalizePetSprite(png, 1, "spritesheet.webp")).rejects.toThrow();
    await expect(normalizePetSprite(png.subarray(0, 50), 1, "spritesheet.png")).rejects.toThrow();
    // APNG animation-control marker inserted after IHDR: it must be rejected before a first-frame decode.
    const animationChunk = Buffer.alloc(20); animationChunk.writeUInt32BE(8); animationChunk.write("acTL", 4);
    const apng = Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)]);
    await expect(normalizePetSprite(apng, 1, "spritesheet.png").then(() => "accepted")).rejects.toThrow();
    const huge = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
    await expect(normalizePetSprite(huge, 1, "spritesheet.png")).rejects.toThrow();
    const red = await sharp({ create: { width: 1536, height: 1872, channels: 4, background: "red" } }).raw().toBuffer();
    const blue = await sharp({ create: { width: 1536, height: 1872, channels: 4, background: "blue" } }).raw().toBuffer();
    const animated = await sharp(Buffer.concat([red, blue]), { raw: { width: 1536, height: 3744, channels: 4, pageHeight: 1872 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(normalizePetSprite(animated, 1, "spritesheet.webp").then(() => "accepted")).rejects.toThrow();
  });
});
