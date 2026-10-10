import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DEFAULT_PET, type PetView } from "@/lib/pets/shared";
import { petPortrait } from "@/lib/pets/portraits";

const hermes: PetView = { ...DEFAULT_PET, enabled: true, appearance: "catalog", source: "default",
  botDefault: { appearance: "catalog", catalogId: "builtin-hermes-assimilated-v2" } };

describe("sidebar portraits follow the visible pet", () => {
  it("preserves the supplied artwork byte for byte", async () => {
    const bytes = await readFile("public/portraits/hermes-assimilated.png");
    expect(bytes.length).toBe(2_069_982);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("d4a4768441b51f80c1bbc72fd2f31cc569c3044ce06b59fefd73569859fbccc7");
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
