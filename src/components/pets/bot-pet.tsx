"use client";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { PawPrint } from "lucide-react";
import { BaseBotAvatar } from "@/components/bots/blob-avatar";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { catalogPreview, DEFAULT_PET, PET_LABELS, type CatalogPet, type PetPreferences, type PetView } from "@/lib/pets/shared";
import { SavedPetPreview } from "./saved-pet-preview";
import { PetArt } from "./pet-art";
import { PetChoices } from "./pet-choices";
import { PetUpload, petControl as control } from "./pet-upload";
import { BotDefaultEditor, defaultKey } from "./bot-default-editor";
import { usePetEnvironment, usePets } from "./pet-context";

/** Shared defaults and private preferences have distinct controls and distinct authorized endpoints. */
export function BotPetSettings({ botId, botName, botAvatar, editor = false }: { botId: string; botName: string; botAvatar?: string | null; editor?: boolean }) {
  const { pets, updatePet, activity } = usePets();
  const pet = pets[botId] ?? DEFAULT_PET;
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<CatalogPet[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const { visible } = usePetEnvironment();
  const current = activity?.botId === botId ? activity : null;
  const state = current?.state ?? "idle";
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/pet`;
  const pref = pet.preference;
  const appearanceName = useId();
  const previewAsset = editor && pet.appearance === "catalog" ? catalog.find((asset) => asset.revision === pet.revision) : undefined;
  const previewPet = previewAsset ? { ...catalogPreview(previewAsset), motion: pet.motion } : pet;
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    void Promise.all([fetch(`${endpoint}${editor ? "?editor=1" : ""}`, { signal: ac.signal, cache: "no-store" }), fetch("/api/pets/catalog", { signal: ac.signal, cache: "no-store" })]).then(async ([res, items]) => {
      if (!res.ok || !items.ok) throw new Error("Could not load avatar preferences.");
      const value: PetView = await res.json(); const choices: CatalogPet[] = await items.json();
      if (!ac.signal.aborted) { updatePet(botId, value); setCatalog(choices); setLoaded(true); setError(""); }
    }).catch((err: unknown) => { if (!ac.signal.aborted) setError(err instanceof Error ? err.message : "Could not load preferences."); });
    return () => ac.abort();
  }, [endpoint, botId, attempt, open, updatePet, editor]);

  async function mutate(method: string, body?: BodyInit, path = endpoint) {
    setPending(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method, body, headers: body ? { "Content-Type": "application/json" } : undefined });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not save avatar.");
      updatePet(botId, value); setNotice(method === "DELETE" ? "Imported pet removed." : "Preferences saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save avatar."); }
    finally { setPending(false); }
  }
  const save = (patch: Partial<PetPreferences>) => void mutate("PATCH", JSON.stringify({ ...pref, ...patch }));
  const name = pet.custom?.displayName ?? (pet.appearance === "ember" ? "Ember" : "Moss");
  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setLoaded(false); }}>
    <DialogTrigger asChild><button className="pet-control inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-xs text-muted hover:bg-hover" aria-label={`Pet avatar settings for ${botName}`}><PawPrint className="h-3.5 w-3.5" /> Pet avatar</button></DialogTrigger>
    <DialogContent title="Pet avatar" description={pet.sharedIdentity ? `${botName} has one shared pet identity, controlled by its authorized owner or admin.` : `Choose how ${botName} looks to you. Personal imports and preferences stay private.`}>
      <div className="flex items-center gap-4 rounded-xl bg-surface-2 px-4 py-2">
        {pet.enabled ? <PetArt pet={previewPet} state={state} botId={botId} size={76} still={!visible} fallback={<span className="text-xs text-muted">Preview unavailable</span>} /> : <BaseBotAvatar value={botAvatar} size={76} className="h-[76px] w-[76px]" />}
        <div className="min-w-0"><p className="truncate font-medium">{pet.enabled ? name : "Original bot icon"}</p><p className="mt-1 text-xs text-muted">{current && pet.enabled ? PET_LABELS[state] : pet.source === "default" ? "Following bot default" : "Your view of this bot"}</p>{pet.custom?.credit && <p className="mt-1 break-words text-xs text-muted">Credit: {pet.custom.credit}</p>}</div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {!loaded && (error ? <button className={`${control} mt-3`} onClick={() => setAttempt((n) => n + 1)}>Retry loading preferences</button> : <p role="status" className="mt-3 text-xs text-muted">Loading preferences…</p>)}
      <fieldset disabled={pending || !loaded} className="mt-4 space-y-4 disabled:opacity-60">
        {!pet.sharedIdentity && <><fieldset><legend className="mb-2 text-sm font-medium">My avatar preference</legend><div className="flex flex-wrap gap-2">
          {([['follow', 'Follow bot default'], ['personal', 'Personal pet'], ['off', 'Off · original icon']] as const).map(([mode, label]) => <label key={mode} className={`${control} flex items-center gap-2`}><input type="radio" name="pet-mode" checked={pref.mode === mode} onChange={() => save(mode === "personal" && ((pref.appearance === "catalog" && !catalog.some((p) => p.id === pref.catalogId)) || (pref.appearance === "custom" && !pet.privateImport)) ? { mode, appearance: "moss", catalogId: null } : { mode })} />{label}</label>)}
        </div></fieldset>
        {pref.mode === "personal" && <fieldset>
          <PetChoices radioName={appearanceName} value={pref.appearance === "custom" ? { appearance: "off", catalogId: null } : { appearance: pref.appearance, catalogId: pref.catalogId }} catalog={catalog} onChange={(choice) => choice.appearance === "off" ? save({ mode: "off" }) : save({ appearance: choice.appearance, catalogId: choice.catalogId })} />
          {pet.privateImport && <label className={`${control} mt-2 flex items-center gap-2`}><input type="radio" name={appearanceName} checked={pref.appearance === "custom"} onChange={() => save({ appearance: "custom", catalogId: null })} />{pet.privateImport.manifest.displayName} · My private import</label>}
          {pet.source !== "personal" && <p className="mt-2 text-xs text-muted">Your selected pet is unavailable. Showing the bot default or original icon until it returns. You can choose another pet.</p>}
        </fieldset>}</>}
        {pet.sharedIdentity && <p className="text-sm text-muted">{pet.canManageDefault ? "Use the shared pet controls below to change this bot for everyone." : "Only the bot owner or an authorized admin can change this shared pet. Service bots are admin only."} Your saved personal avatar choices stay private and inactive while this identity is shared.</p>}
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm"><span>Animation</span><Select aria-label="Animation" className={control} value={pref.motion} onChange={(e) => void mutate("PATCH", JSON.stringify({ motion: e.target.value }), `${endpoint}/motion`)}><option value="auto">Follow system</option><option value="still">Still</option></Select></label>
        <p className="text-xs text-muted">Reduced motion always keeps animation still. Animation changes apply only to your account and never change the shared identity.</p>
      </fieldset>
      {!pet.sharedIdentity && <details className="mt-5 border-t border-border pt-4">
        <summary className="pet-control cursor-pointer rounded-lg py-2 text-sm font-medium">Import your own pet</summary>
        <p className="my-3 text-xs text-muted">One private import per bot; importing replaces and selects it. Community gallery art may have separate rights. Nothing here is published automatically.</p>
        {pet.privateImport && <div className="mb-3 rounded-lg bg-surface-2 p-3 text-xs"><p className="break-words font-medium">{pet.privateImport.manifest.displayName}</p><p className="mt-1 break-words">{pet.privateImport.manifest.description}</p><p className="mt-1 break-words">Credit: {pet.privateImport.manifest.credit || "Not supplied"}</p><SavedPetPreview key={pet.privateImport.revision} manifest={pet.privateImport.manifest} src={`${endpoint}/sprite?v=${encodeURIComponent(pet.privateImport.revision)}`} /><button type="button" disabled={pending} className={`${control} mt-2`} onClick={() => void mutate("DELETE")}>Remove imported pet</button></div>}
        <PetUpload endpoint={endpoint} disabled={pending || !loaded} onSaved={(value) => { updatePet(botId, value as PetView); setNotice("Pet imported. Your previous import was replaced."); }} />
      </details>}
      {pet.canManageDefault && loaded && <details className="mt-5 border-t border-border pt-4"><summary className="pet-control cursor-pointer rounded-lg py-2 text-sm font-medium">{pet.sharedIdentity ? "Shared bot pet" : "Admin · Bot default"}</summary>
        <div className="mt-3"><BotDefaultEditor key={defaultKey(pet.botDefault)} botId={botId} avatar={botAvatar} value={pet.botDefault} catalog={catalog} sharedIdentity={pet.sharedIdentity} onSaveStart={() => setNotice("")} onSaved={(saved) => { updatePet(botId, saved); setNotice(saved.sharedIdentity ? "Shared bot pet saved for everyone." : "Bot default saved."); }} /></div>
        {pet.canPublish && pref.mode === "personal" && pref.appearance === "custom" && pet.privateImport && <form className="mt-4 space-y-3" onSubmit={async (event) => {
          event.preventDefault(); setPending(true); setError("");
          const rights = new FormData(event.currentTarget).get("rights");
          try {
            const response = await fetch("/api/admin/pets/from-import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId, revision: pet.privateImport?.revision, rights }) });
            const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "Could not copy import.");
            setDraft(value.id); setNotice("Your import was copied to an admin draft. Review and publish it in Admin → Pets, then assign a bot default.");
          } catch (err) { setError(err instanceof Error ? err.message : "Could not copy import."); } finally { setPending(false); }
        }}><p className="text-xs text-muted">Copy my saved private import to the shared catalog. It may differ from this bot’s displayed pet. Admins can review the draft. My private original stays private.</p><label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" name="rights" value="confirmed" required className="mt-1" />I have permission to share this artwork and its credit with all signed-in users.</label><button disabled={pending} className={control}>Copy my import to admin draft</button></form>}
        {pet.canPublish && <Link href={draft ? `/admin/pets#${draft}` : "/admin/pets"} className="mt-3 inline-block text-sm underline">{draft ? "Review my draft in Admin → Pets" : "Manage catalog in Admin → Pets"}</Link>}
      </details>}
      <p role="status" className="mt-3 text-xs text-muted">{notice || (pending ? "Saving…" : "Moss and Ember are original CollectiveUI companions.")}</p>
    </DialogContent>
  </Dialog>;
}
