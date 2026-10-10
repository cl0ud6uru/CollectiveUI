import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_PET, type PetView } from "@/lib/pets/shared";
import { petPortrait } from "@/lib/pets/portraits";

const hermes: PetView = { ...DEFAULT_PET, enabled: true, appearance: "catalog", source: "default",
  botDefault: { appearance: "catalog", catalogId: "builtin-hermes-assimilated-v2" } };

describe("sidebar portraits follow the visible pet", () => {
  it("preserves the supplied transparent cutout byte for byte", async () => {
    const bytes = await readFile("public/portraits/hermes-assimilated.png");
    expect(bytes.length).toBe(2_180_226);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("2fe203809023389661433ab19b2073615ab8317f581d3a4768a18538fce81f6d");
  });
  it("contains a full-size alpha cutout with transparent outside corners", async () => {
    const image = sharp("public/portraits/hermes-assimilated.png");
    expect(await image.metadata()).toMatchObject({ width: 1024, height: 1536, hasAlpha: true });
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    let highestAlpha = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 0) transparent++;
      highestAlpha = Math.max(highestAlpha, data[i]);
    }
    expect(transparent).toBeGreaterThan(info.width * info.height / 2);
    expect(highestAlpha).toBeGreaterThanOrEqual(250);
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) {
      // The supplied cutout has one 1/255 corner; it composites within one colour level of the sidebar.
      expect(data[(y * info.width + x) * 4 + 3]).toBeLessThanOrEqual(1);
    }
  });
  it("shows the supplied Hermes portrait for the selected shared identity", () => {
    expect(petPortrait(hermes)?.src).toBe("/portraits/hermes-assimilated.png");
  });
  it("honors a personal catalog choice over the bot default", () => {
    const personal = { ...hermes, source: "personal" as const,
      preference: { ...DEFAULT_PET.preference, mode: "personal" as const, appearance: "catalog" as const, catalogId: "builtin-nimbus-v2" } };
    expect(petPortrait(personal)).toBeNull();
    expect(petPortrait({ ...personal, preference: { ...personal.preference, catalogId: "builtin-hermes-assimilated-v2" } })).toEqual(petPortrait(hermes));
  });
  it("omits artwork for disabled, missing, unmapped and private imported pets", () => {
    for (const pet of [undefined, DEFAULT_PET, { ...hermes, enabled: false }, { ...hermes, appearance: "custom" as const },
      { ...hermes, botDefault: { appearance: "catalog" as const, catalogId: "builtin-hermes-v2" } }]) {
      expect(petPortrait(pet)).toBeNull();
    }
  });
});
