"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveLoginPet } from "@/app/admin/actions";
import { PortalMark } from "@/components/brand-mark";
import { PetChoices, petChoiceKey } from "@/components/pets/pet-choices";
import { Button } from "@/components/ui/button";
import type { BotPetDefault, CatalogPet } from "@/lib/pets/shared";
import type { LoginPetSettings } from "@/lib/settings";

/** Saves on its own, like the logo: the sign-in page is public, so a catalog pet needs a separate confirmation. */
export function LoginPetForm({ initial, catalog }: { initial: LoginPetSettings; catalog: CatalogPet[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState<BotPetDefault>({ appearance: initial.appearance, catalogId: initial.catalogId });
  const [savedKey, setSavedKey] = useState(petChoiceKey(choice));
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const catalogChoice = choice.appearance === "catalog";
  const unchanged = petChoiceKey(choice) === savedKey;
  function save() {
    if (catalogChoice && !confirmed) { setNotice({ error: true, text: "Confirm you can show this artwork publicly first." }); return; }
    start(async () => {
      setNotice(null);
      try {
        await saveLoginPet(choice, catalogChoice ? "confirmed" : undefined);
        setSavedKey(petChoiceKey(choice));
        setConfirmed(false);
        setNotice({ error: false, text: "Sign-in companion saved." });
        router.refresh();
      } catch {
        const text = catalogChoice ? "The companion could not be saved. The pet may have been unpublished; reload and try again." : "The companion could not be saved. Please try again.";
        setNotice({ error: true, text });
        toast.error(text);
      }
    });
  }
  return (
    <div className="space-y-3 rounded-xl border border-border bg-sidebar p-4">
      <PetChoices legend="Sign-in companion" original originalLabel="Portal bot" originalArt={<PortalMark className="h-9 w-9" />} value={choice} catalog={catalog} disabled={pending}
        onChange={(next) => { setChoice(next); setConfirmed(false); setNotice(null); }} />
      <p className="text-xs text-muted">Stands at the center of the sign-in page. Visitors can click it to say hello, and it reacts while someone signs in.</p>
      {catalogChoice && !unchanged && <label className="flex min-h-11 items-start gap-2 text-xs">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 accent-accent" />
        I have permission to show this artwork and its credit publicly on the sign-in page, including to people who are not signed in.
      </label>}
      <Button variant="outline" disabled={pending || unchanged || (catalogChoice && !confirmed)} onClick={save} className="focus-visible:outline-2">{pending ? "Saving…" : "Save companion"}</Button>
      {notice && <p role={notice.error ? "alert" : "status"} className={`text-sm ${notice.error ? "text-danger" : "text-muted"}`}>{notice.text}</p>}
    </div>
  );
}
