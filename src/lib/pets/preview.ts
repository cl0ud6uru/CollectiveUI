import { catalogPreview, DEFAULT_PET, type BotPetDefault, type CatalogPet, type PetView } from "./shared";

/**
 * The header preview for an unsaved pet choice. Null means the original bot icon: the choice is "off", or its catalog
 * pet is no longer published (the picker explains that separately).
 */
export function draftPetPreview(choice: BotPetDefault | undefined, catalog: CatalogPet[]): PetView | null {
  if (!choice || choice.appearance === "off") return null;
  if (choice.appearance === "moss" || choice.appearance === "ember") return { ...DEFAULT_PET, enabled: true, appearance: choice.appearance };
  const pet = catalog.find((p) => p.id === choice.catalogId && p.status === "published");
  return pet ? catalogPreview(pet) : null;
}

export const petDisplayName = (pet: PetView) => pet.custom?.displayName ?? (pet.appearance === "ember" ? "Ember" : "Moss");
