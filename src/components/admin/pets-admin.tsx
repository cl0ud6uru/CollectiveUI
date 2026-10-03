"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AdminHeader } from "./ui";
import { Select } from "@/components/ui/select";
import { PetArt } from "@/components/pets/pet-art";
import { PetUpload, petControl } from "@/components/pets/pet-upload";
import { BotDefaultEditor, defaultKey } from "@/components/pets/bot-default-editor";
import { catalogPreview, type BotPetDefault, type CatalogPet } from "@/lib/pets/shared";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

type AdminCatalogPet = CatalogPet & { defaultCount: number; personalCount: number; preferenceCount: number; builtIn: boolean };
type Deleted = { displayName: string; defaultsReset: number; selectionsReset: number };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function PetsAdmin({ catalog, bots }: { catalog: AdminCatalogPet[]; bots: (BotPetDefault & { id: string; name: string; avatar: string | null; enabled: boolean; sharedIdentity: boolean })[] }) {
  const router = useRouter();
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const bot = bots.find((b) => b.id === botId);
  const [notice, setNotice] = useState("");
  const [defaultNotice, setDefaultNotice] = useState<{ botId: string; text: string } | null>(null);
  const [deleted, setDeleted] = useState("");
  const [deleteError, setDeleteError] = useState("");
  return <div className="space-y-6">
    <AdminHeader title="Pets" description="Upload, review and publish shared avatar artwork. Private user imports stay private until their owner explicitly copies them here." />
    <section className="rounded-xl border border-border p-4"><h2 className="mb-3 font-medium">Upload a catalog draft</h2><PetUpload endpoint="/api/admin/pets" shared onSaved={() => { setNotice("Draft uploaded. Review its animation and credit before publishing."); router.refresh(); }} /><p role="status" className="mt-3 text-sm text-muted">{notice}</p></section>
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-medium">Assign a bot default</h2>
      <Select aria-label="Bot to configure" className={`${petControl} max-w-full`} value={botId} onChange={(e) => { setBotId(e.target.value); setDefaultNotice(null); }}>{bots.map((b) => <option key={b.id} value={b.id}>{b.name}{b.enabled ? "" : " · disabled"}</option>)}</Select>
      {bot && <BotDefaultEditor key={`${bot.id}:${defaultKey(bot)}`} botId={bot.id} avatar={bot.avatar} value={bot} catalog={catalog} sharedIdentity={bot.sharedIdentity} onSaveStart={() => setDefaultNotice(null)} onSaved={() => { setDefaultNotice({ botId: bot.id, text: bot.sharedIdentity ? "Shared bot pet saved for everyone." : "Bot default saved." }); router.refresh(); }} />}
      {defaultNotice?.botId === botId && <p role="status" className="text-xs text-muted">{defaultNotice.text}</p>}
    </section>
    <section>
      <h2 className="mb-3 font-medium">Catalog · {catalog.length}</h2>
      <p className="mb-4 text-sm text-muted">Published pets are available to all signed-in users. Drafts and unpublished art are admin only. Unpublishing keeps references and restores a fallback; republishing restores selections. Deleting an unpublished pet or draft removes its artwork permanently. Built-in pets can be unpublished but not deleted.</p>
      <p role="status" className="mb-3 text-sm text-muted empty:hidden">{deleted}</p>
      {deleteError && <p role="alert" className="mb-3 text-sm text-danger">{deleteError}</p>}
      <div className="grid gap-4 lg:grid-cols-2">{catalog.map((pet) => <CatalogCard key={`${pet.id}:${pet.status}`} pet={pet}
        onSaved={() => { setDeleted(""); setDeleteError(""); router.refresh(); }}
        onDeleted={(d) => { setDeleteError(""); setDeleted(`Deleted ${d.displayName}. ${plural(d.defaultsReset, "bot default")} now ${d.defaultsReset === 1 ? "uses" : "use"} the original icon. Cleared ${plural(d.selectionsReset, "saved catalog choice")}; Off preferences stay off.`); router.refresh(); }}
        onStale={(name) => { setDeleted(""); setDeleteError(`${name} was already deleted. The catalog has been refreshed.`); router.refresh(); }}
      />)}</div>
      {!catalog.length && <p className="text-sm text-muted">No uploaded pets yet. Moss and Ember remain available in Pet avatar settings.</p>}
    </section>
  </div>;
}
function CatalogCard({ pet, onSaved, onDeleted, onStale }: { pet: AdminCatalogPet; onSaved: () => void; onDeleted: (deleted: Deleted) => void; onStale: (name: string) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <article id={pet.id} className="min-w-0 scroll-mt-4 rounded-xl border border-border p-4">
    <div className="flex items-center gap-4"><PetArt pet={catalogPreview(pet)} state="idle" botId="catalog-preview" size={80} fallback={<span className="text-xs text-danger">Preview unavailable</span>} /><div className="min-w-0"><h3 className="break-words font-medium">{pet.manifest.displayName}</h3><p className="mt-1 text-xs text-muted">{pet.builtIn ? "built-in · " : ""}{pet.status} · {pet.defaultCount} bot defaults · {pet.personalCount} personal selections</p></div></div>
    <p className="mt-3 break-words text-sm text-muted">{pet.manifest.description}</p><p className="mt-2 break-words text-xs">Credit: {pet.manifest.credit || "Not supplied"}</p>
    <form className="mt-3 space-y-3" onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError("");
      const rights = new FormData(event.currentTarget).get("rights");
      try {
        const response = await fetch(`/api/admin/pets/${encodeURIComponent(pet.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: pet.status === "published" ? "unpublished" : "published", ...(rights === "confirmed" ? { rights } : {}) }) });
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "Could not update catalog."); onSaved();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not update catalog."); } finally { setPending(false); }
    }}>
      {pet.status === "published" ? <p className="text-xs text-muted">Unpublishing affects bot defaults and personal selections. Those users fall back to an available bot default or the original icon. Republishing restores their selections.</p> : <label className="flex min-h-11 items-start gap-2 text-xs leading-relaxed"><input type="checkbox" name="rights" value="confirmed" required className="mt-1" />I reviewed this artwork and credit and confirm permission to share it with all signed-in users.</label>}
      <button className={petControl} disabled={pending}>{pending ? "Saving…" : pet.status === "published" ? "Unpublish pet" : "Publish pet"}</button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
    <DeletePet pet={pet} disabled={pending} onDeleted={onDeleted} onStale={onStale} />
  </article>;
}

/** Deletion is separate from Unpublish: only drafts and unpublished, non-built-in pets, after a confirmation. */
function DeletePet({ pet, disabled, onDeleted, onStale }: { pet: AdminCatalogPet; disabled: boolean; onDeleted: (deleted: Deleted) => void; onStale: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const name = pet.manifest.displayName;
  const hintId = `delete-hint-${pet.id}`;
  if (pet.builtIn) return <p className="mt-4 border-t border-border pt-3 text-xs text-muted">Built-in pets ship with CollectiveUI and can&apos;t be deleted. Unpublish to hide it from everyone; it stays hidden after restarts.</p>;
  const blocked = pet.status === "published";
  async function remove() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/admin/pets/${encodeURIComponent(pet.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: pet.id }) });
      const value = await response.json();
      if (response.status === 404) { setOpen(false); onStale(name); return; }
      if (!response.ok) { setError(typeof value.error === "string" ? value.error : "Could not confirm deletion. Refresh the catalog before trying again."); return; }
      if (value.id !== pet.id || typeof value.displayName !== "string" || !Number.isInteger(value.defaultsReset) || value.defaultsReset < 0 || !Number.isInteger(value.selectionsReset) || value.selectionsReset < 0) throw new Error("Invalid deletion receipt");
      setOpen(false); onDeleted(value as Deleted);
    } catch { setError("Could not confirm deletion. Check your connection and refresh the catalog before trying again."); }
    finally { setPending(false); }
  }
  return <div className="mt-4 border-t border-border pt-3">
    <Dialog open={open} onOpenChange={(next) => { if (!pending) { setOpen(next); setError(""); } }}>
      <DialogTrigger asChild><button type="button" className={`${petControl} text-danger disabled:text-muted`} disabled={disabled || blocked} aria-describedby={hintId}>Delete pet…</button></DialogTrigger>
      <p id={hintId} className="mt-2 text-xs text-muted">{blocked ? "Unpublish this pet before deleting it." : "Permanently removes this artwork from the catalog."}</p>
      <DialogContent title={`Delete ${name}?`} description="This permanently deletes the artwork and can't be undone. To use it again, upload it as a new draft." hideClose={pending}>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>{pet.defaultCount ? `${plural(pet.defaultCount, "bot default")} using it will switch to the original bot icon.` : "No bot defaults use it."}</li>
          <li>{pet.preferenceCount ? `${plural(pet.preferenceCount, "saved avatar preference")} will have this catalog choice cleared, including inactive choices. Personal selections return to following the bot default; Off preferences stay off.` : "No saved avatar preferences reference it."}</li>
          <li>Because it isn&apos;t published, nobody sees it today; their avatars won&apos;t change.</li>
        </ul>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className={petControl} disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className={`${petControl} border-danger text-danger`} disabled={pending} onClick={() => void remove()}>{pending ? "Deleting…" : "Delete permanently"}</button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
