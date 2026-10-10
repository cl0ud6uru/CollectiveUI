import type { PetView } from "./shared";

const HERMES_ASSIMILATED = { src: "/portraits/hermes-assimilated.png", width: 1024, height: 1536 };

/** Portraits follow the resolved pet identity, including personal choices and the viewer's off preference. */
export function petPortrait(pet: PetView | undefined) {
  if (!pet?.enabled || pet.appearance !== "catalog") return null;
  const catalogId = pet.source === "default" ? pet.botDefault.catalogId
    : pet.source === "personal" ? pet.preference.catalogId : null;
  return catalogId === "builtin-hermes-assimilated-v2" ? HERMES_ASSIMILATED : null;
}
