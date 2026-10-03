"use client";
import { useId } from "react";
import { BaseBotAvatar } from "@/components/bots/blob-avatar";
import { catalogPreview, DEFAULT_PET, type BotPetDefault, type CatalogPet } from "@/lib/pets/shared";
import { PetArt } from "./pet-art";
import { petControl } from "./pet-upload";

export const petChoiceKey = (choice: BotPetDefault) => choice.appearance === "catalog" ? `catalog:${choice.catalogId}` : choice.appearance;

/** Native radio cards: the preview and name stay together for mouse, touch and keyboard. */
export function PetChoices({ value, catalog, onChange, legend = "Choose your pet", original = false, originalLabel = "Original bot icon", originalArt, avatar, disabled = false, radioName }: {
  value: BotPetDefault; catalog: CatalogPet[]; onChange: (choice: BotPetDefault) => void;
  legend?: string; original?: boolean; originalLabel?: string; originalArt?: React.ReactNode; avatar?: string | null; disabled?: boolean; radioName?: string;
}) {
  const generatedName = useId(); const name = radioName ?? generatedName; const selected = petChoiceKey(value);
  const choices = [
    ...(original ? [{ key: "off", label: originalLabel, choice: { appearance: "off" as const, catalogId: null }, art: originalArt ?? <BaseBotAvatar value={avatar} size={40} className="h-10 w-10" /> }] : []),
    ...(["moss", "ember"] as const).map((appearance) => ({ key: appearance, label: appearance === "moss" ? "Moss" : "Ember", choice: { appearance, catalogId: null }, art: <PetArt pet={{ ...DEFAULT_PET, enabled: true, appearance }} state="idle" size={40} still /> })),
    ...catalog.filter((pet) => pet.status === "published").map((pet) => ({ key: `catalog:${pet.id}`, label: pet.manifest.displayName, choice: { appearance: "catalog" as const, catalogId: pet.id }, art: <PetArt pet={catalogPreview(pet)} state="idle" size={40} still fallback={<span className="text-xs text-muted">Preview unavailable</span>} /> })),
  ];
  return <fieldset disabled={disabled} className="min-w-0 space-y-2 disabled:opacity-60">
    <legend className="mb-2 text-sm font-medium">{legend}</legend>
    <div className="grid grid-cols-2 gap-2">{choices.map((item) => <label key={item.key} className={`${petControl} flex min-w-0 cursor-pointer items-center gap-2 ${selected === item.key ? "border-accent bg-accent/5" : ""}`}>
      <input type="radio" name={name} checked={selected === item.key} onChange={() => onChange(item.choice)} className="shrink-0 accent-accent" />
      <span className="flex h-12 w-10 shrink-0 items-center justify-center" aria-hidden="true">{item.art}</span>
      <span className="min-w-0 break-words text-sm">{item.label}</span>
    </label>)}</div>
    {value.appearance === "catalog" && !choices.some((item) => item.key === selected) && <p className="text-xs text-muted">Your selected catalog pet is unavailable. Choose another pet or wait for it to be published again.</p>}
  </fieldset>;
}
