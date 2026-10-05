import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLED_PETS, HD_SPRITE_FILE, readBundledPet } from "@/lib/pets/bundled";
import { hdDifference } from "@/lib/pets/import";
import { petV2Fixture } from "../fixtures/pet-v2";

let directory: string, source: Record<string, unknown>, sprite: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "hermes-bundle-test-"));
  source = JSON.parse(await readFile("assets/pets/hermes/v2/pet.json", "utf8"));
  // These are synthetic geometric fixtures, never substitute artwork for the selected Hermes concept.
  sprite = await sharp(await petV2Fixture()).webp({ lossless: true }).toBuffer();
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture(manifest = source, pixels = sprite, hd?: Buffer) {
  await writeFile(path.join(directory, "pet.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "spritesheet.webp"), pixels);
  if (hd) await writeFile(path.join(directory, HD_SPRITE_FILE), hd);
  else await rm(path.join(directory, HD_SPRITE_FILE), { force: true });
}
const doubled = (pixels: Buffer) => sharp(pixels).resize(3072, 4576, { kernel: "nearest" }).webp({ quality: 95, alphaQuality: 100 }).toBuffer();

describe("Bundled pet validation with synthetic pixels", () => {
  it("normalizes a complete v2 sheet and retains the exact approved metadata", async () => {
    await fixture();
    const result = await readBundledPet(directory);
    expect(result.manifest).toEqual({
      displayName: "Hermes", spriteVersionNumber: 2,
      description: "A black-and-green animated companion celebrating Hermes Agent and its integration with CollectiveUI.",
      credit: "Pet adaptation for CollectiveUI by @cl0ud6uru. Inspired by Hermes Agent from Nous Research. Unofficial community artwork; not affiliated with or endorsed by Nous Research.",
    });
    expect(await sharp(result.sprite).metadata()).toMatchObject({ format: "png", width: 1536, height: 2288, hasAlpha: true });
  });
  it("rejects missing, corrupt, and incomplete artwork without creating a substitute", async () => {
    await fixture(); await rm(path.join(directory, "spritesheet.webp"));
    await expect(readBundledPet(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await fixture(source, Buffer.from("not an image"));
    await expect(readBundledPet(directory)).rejects.toThrow(/static spritesheet/);
    await fixture(source, await sharp({ create: { width: 1536, height: 2288, channels: 4, background: "transparent" } }).webp().toBuffer());
    await expect(readBundledPet(directory)).rejects.toThrow(/idle frame 1 is empty/);
  });
  it("rejects legacy layout, missing credit, and paths outside the bundle", async () => {
    await fixture({ ...source, spriteVersionNumber: 1 });
    await expect(readBundledPet(directory)).rejects.toThrow(/Codex Pet v2/);
    await fixture({ ...source, credit: "" });
    await expect(readBundledPet(directory)).rejects.toThrow(/artwork credit/);
    await fixture({ ...source, spritesheetPath: "../spritesheet.webp" });
    await expect(readBundledPet(directory)).rejects.toThrow(/standard Codex/);
  });
});

describe("HD renditions with synthetic pixels", () => {
  it("reads an optional 2× sheet as a WebP rendition of the same artwork", async () => {
    await fixture();
    expect((await readBundledPet(directory)).spriteHd).toBeNull();
    await fixture(source, sprite, await doubled(sprite));
    const { sprite: standard, spriteHd } = await readBundledPet(directory);
    expect(await sharp(spriteHd!).metadata()).toMatchObject({ format: "webp", width: 3072, height: 4576, hasAlpha: true });
    expect(await hdDifference(standard, spriteHd!)).toBeLessThan(1);
  }, 30_000);
  it("rejects an HD sheet of the wrong size, with an empty frame, or of different artwork", async () => {
    await fixture(source, sprite, sprite);
    await expect(readBundledPet(directory)).rejects.toThrow(/3072 × 4576 HD sprite sheet/);
    await fixture(source, sprite, Buffer.from("not an image"));
    await expect(readBundledPet(directory)).rejects.toThrow(/3072 × 4576 HD sprite sheet/);
    const blank = { input: { create: { width: 384, height: 416, channels: 4 as const, background: "transparent" } }, blend: "clear" as const, left: 0, top: 0 };
    await fixture(source, sprite, await sharp(await doubled(sprite)).composite([blank]).webp({ lossless: true }).toBuffer());
    await expect(readBundledPet(directory)).rejects.toThrow(/idle frame 1 is empty/);
    await fixture(source, sprite, await sharp(await doubled(sprite)).negate({ alpha: false }).webp({ lossless: true }).toBuffer());
    await expect(readBundledPet(directory)).rejects.toThrow(/same artwork as the v2 sheet/);
  }, 30_000);
});

const bundles = [
  { slug: "hermes", name: "Hermes", file: "spritesheet.webp", hash: "80e08093c5cdaa390c6176fca447acf3cacb122e08927573f0f7256622c2c646", normalizedBytes: 3904456 },
  { slug: "hermes-assimilated", name: "Hermes Assimilated", file: "spritesheet.webp", hash: "071c27d8292fd0da02fbc7d7e923fbc98cbfc2de16b29f14f32624bee981dc7b", normalizedBytes: 3585739 },
  { slug: "the-queen", name: "The Queen", file: "spritesheet.png", hash: "fed57f8824f9e4a93064ab9e60996637867a583b2e3b83d3a175460560ac7487" },
];

describe("shipped artwork", () => {
  it("keeps BUNDLED_PETS hashes and HD flags in step with the shipped files", async () => {
    const { createHash } = await import("node:crypto");
    for (const pet of BUNDLED_PETS) {
      const loaded = await readBundledPet(`assets/pets/${pet.directory}`);
      expect(createHash("sha256").update(loaded.sprite).digest("hex")).toBe(pet.sprite);
      expect(!!loaded.spriteHd).toBe(pet.hd);
      expect(pet.releases).not.toContain(pet.sprite);
    }
  }, 120_000);
  it.each(bundles)("imports $name through multipart and ZIP export/reimport with credit intact", async (bundle) => {
    const { createHash } = await import("node:crypto");
    const { parsePetUpload } = await import("@/lib/pets/import");
    const { writePetArchive } = await import("@/lib/pets/archive");
    const root = `assets/pets/${bundle.slug}/v2`;
    const bytes = await readFile(`${root}/${bundle.file}`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(bundle.hash);
    const manifest = await readFile(`${root}/pet.json`);
    const form = new FormData();
    form.set("manifest", new File([new Uint8Array(manifest)], "pet.json"));
    form.set("sprite", new File([new Uint8Array(bytes)], bundle.file));
    form.set("credit", ""); form.set("rights", "confirmed");
    const imported = await parsePetUpload(new Request("http://localhost/api/pets/export", { method: "POST", body: form }));
    expect(imported.manifest).toMatchObject({ displayName: bundle.name, credit: JSON.parse(manifest.toString()).credit, spriteVersionNumber: 2 });
    expect(imported.sprite.length).toBeLessThanOrEqual(4194304);
    if (bundle.normalizedBytes) expect(imported.sprite.length).toBe(bundle.normalizedBytes);
    const zipped = new FormData();
    zipped.set("archive", new File([new Uint8Array(writePetArchive(imported.manifest, imported.sprite))], "pet.zip"));
    zipped.set("credit", ""); zipped.set("rights", "confirmed");
    const again = await parsePetUpload(new Request("http://localhost/api/pets/export", { method: "POST", body: zipped }));
    expect(again.manifest).toEqual(imported.manifest); expect(again.sprite.equals(imported.sprite)).toBe(true);
  });
  it.each(bundles)("keeps $name inside its cells with distinct gaze poses", async ({ slug, file }) => {
    const { createHash } = await import("node:crypto");
    const { PET_ANIMATIONS } = await import("@/lib/pets/atlas");
    const counts = [...PET_ANIMATIONS.map(state => state.durations.length), 8, 8];
    const hashes = [], gazes = [];
    for (let row = 0; row < 11; row++) for (let column = 0; column < counts[row]; column++) {
      const pixels = await sharp(`assets/pets/${slug}/v2/${file}`).extract({ left: column * 192, top: row * 208, width: 192, height: 208 }).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < 208; y++) for (let x = 0; x < 192; x++) {
        const i = (y * 192 + x) * 4;
        if (!x || x === 191 || !y || y === 207) expect(pixels[i + 3]).toBe(0);
        if (!pixels[i + 3]) pixels.fill(0, i, i + 3); // Invisible RGB does not establish visual uniqueness.
      }
      const hash = createHash("sha256").update(pixels).digest("hex");
      hashes.push(hash); if (row >= 9) gazes.push(hash);
    }
    expect(hashes).toHaveLength(73); expect(new Set(gazes).size).toBe(16);
    if (slug !== "the-queen") expect(new Set(hashes).size).toBe(73);
  });
  it("changes only Queen's unused cells, preserving every required source pixel", async () => {
    const { PET_ANIMATIONS } = await import("@/lib/pets/atlas");
    const original = await sharp("assets/pets/the-queen/source/spritesheet.png").ensureAlpha().raw().toBuffer();
    const runtime = await sharp("assets/pets/the-queen/v2/spritesheet.png").ensureAlpha().raw().toBuffer();
    const counts = [...PET_ANIMATIONS.map(state => state.durations.length), 8, 8];
    for (let y = 0; y < 2288; y++) {
      const start = y * 1536 * 4, usedEnd = start + counts[Math.floor(y / 208)] * 192 * 4;
      expect(runtime.subarray(start, usedEnd).equals(original.subarray(start, usedEnd))).toBe(true);
      expect(runtime.subarray(usedEnd, start + 1536 * 4).some(byte => byte !== 0)).toBe(false);
    }
  });
});
