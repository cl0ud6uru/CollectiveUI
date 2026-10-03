"use client";
import { useState } from "react";
import type { BotPetDefault, CatalogPet, PetView } from "@/lib/pets/shared";
import { petControl } from "./pet-upload";
import { PetChoices, petChoiceKey } from "./pet-choices";
export const defaultKey = petChoiceKey;
export function BotDefaultEditor({ botId, value, catalog, onSaved, onSaveStart, avatar, sharedIdentity = true }: { botId: string; value: BotPetDefault; catalog: CatalogPet[]; onSaved: (pet: PetView) => void; onSaveStart: () => void; avatar?: string | null; sharedIdentity?: boolean }) {
  // Admin rows also carry display metadata. Only the selection belongs in a mutation payload.
  const [choice, setChoice] = useState<BotPetDefault>(() => ({ appearance: value.appearance, catalogId: value.catalogId }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <form onSubmit={async (event) => {
    event.preventDefault(); onSaveStart(); setPending(true); setError("");
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/pet/default`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(choice) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not set bot default.");
      onSaved(data as PetView);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not set bot default."); }
    finally { setPending(false); }
  }} className="space-y-3">
    <p className="text-xs text-muted">{sharedIdentity ? "The bot owner or an authorized admin controls this shared identity. Service bots are admin only. Personal avatar overrides are inactive." : "This default applies when you follow the bot default. Private personal preferences remain available."}</p>
    <PetChoices value={choice} catalog={catalog} onChange={setChoice} legend={sharedIdentity ? "Bot pet for everyone" : "Bot default"} original avatar={avatar} disabled={pending} />
    <button className={petControl} type="submit" disabled={pending}>{pending ? "Saving…" : "Save bot pet"}</button>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </form>;
}
