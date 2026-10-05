import { describe, expect, it } from "vitest";
import { draftPetPreview, petDisplayName } from "@/lib/pets/preview";
import type { CatalogPet } from "@/lib/pets/shared";

const manifest = { displayName: "Fixture pet", description: "", spriteVersionNumber: 2 as const, credit: "MIT" };
const catalog: CatalogPet[] = [
  { id: "live", manifest, revision: "r1", status: "published", hd: true },
  { id: "hidden", manifest: { ...manifest, displayName: "Hidden" }, revision: "r2", status: "unpublished", hd: false },
];

describe("bot editor header preview (#24)", () => {
  it("shows the original icon for no choice, Original, or an unavailable catalog pet", () => {
    expect(draftPetPreview(undefined, catalog)).toBeNull();
    expect(draftPetPreview({ appearance: "off", catalogId: null }, catalog)).toBeNull();
    expect(draftPetPreview({ appearance: "catalog", catalogId: "hidden" }, catalog)).toBeNull();
    expect(draftPetPreview({ appearance: "catalog", catalogId: "gone" }, catalog)).toBeNull();
  });

  it("previews built-in and published catalog pets before saving", () => {
    const ember = draftPetPreview({ appearance: "ember", catalogId: null }, catalog)!;
    expect(ember).toMatchObject({ enabled: true, appearance: "ember", spriteUrl: null, spriteHdUrl: null });
    expect(petDisplayName(ember)).toBe("Ember");
    expect(petDisplayName(draftPetPreview({ appearance: "moss", catalogId: null }, catalog)!)).toBe("Moss");
    const live = draftPetPreview({ appearance: "catalog", catalogId: "live" }, catalog)!;
    expect(live).toMatchObject({ enabled: true, appearance: "catalog", revision: "r1", spriteUrl: "/api/pets/catalog/live/sprite?v=r1",
      spriteHdUrl: "/api/pets/catalog/live/sprite?v=r1&size=2x" });
    expect(petDisplayName(live)).toBe("Fixture pet");
  });
});
