import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readHermesBundle } from "@/lib/pets/bundled-hermes";
import { petV2Fixture } from "../fixtures/pet-v2";

let directory: string, source: Record<string, unknown>, sprite: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "hermes-bundle-test-"));
  source = JSON.parse(await readFile("assets/pets/hermes/v2/pet.json", "utf8"));
  // These are synthetic geometric fixtures, never substitute artwork for the selected Hermes concept.
  sprite = await sharp(await petV2Fixture()).webp({ lossless: true }).toBuffer();
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function fixture(manifest = source, pixels = sprite) {
  await writeFile(path.join(directory, "pet.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "spritesheet.webp"), pixels);
}

describe("Hermes bundle preparation with synthetic pixels", () => {
  it("normalizes a complete v2 sheet and retains the exact approved metadata", async () => {
    await fixture();
    const result = await readHermesBundle(directory);
    expect(result.manifest).toEqual({
      displayName: "Hermes", spriteVersionNumber: 2,
      description: "A black-and-green animated companion celebrating Hermes Agent and its integration with CollectiveUI.",
      credit: "Pet adaptation for CollectiveUI by @cl0ud6uru. Inspired by Hermes Agent from Nous Research. Unofficial community artwork; not affiliated with or endorsed by Nous Research.",
    });
    expect(await sharp(result.sprite).metadata()).toMatchObject({ format: "png", width: 1536, height: 2288, hasAlpha: true });
  });
  it("rejects missing, corrupt, and incomplete artwork without creating a substitute", async () => {
    await fixture(); await rm(path.join(directory, "spritesheet.webp"));
    await expect(readHermesBundle(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await fixture(source, Buffer.from("not an image"));
    await expect(readHermesBundle(directory)).rejects.toThrow(/static spritesheet/);
    await fixture(source, await sharp({ create: { width: 1536, height: 2288, channels: 4, background: "transparent" } }).webp().toBuffer());
    await expect(readHermesBundle(directory)).rejects.toThrow(/idle frame 1 is empty/);
  });
  it("rejects legacy layout, missing credit, and paths outside the bundle", async () => {
    await fixture({ ...source, spriteVersionNumber: 1 });
    await expect(readHermesBundle(directory)).rejects.toThrow(/Codex Pet v2/);
    await fixture({ ...source, credit: "" });
    await expect(readHermesBundle(directory)).rejects.toThrow(/artwork credit/);
    await fixture({ ...source, spritesheetPath: "../spritesheet.webp" });
    await expect(readHermesBundle(directory)).rejects.toThrow(/standard Codex/);
  });
});
