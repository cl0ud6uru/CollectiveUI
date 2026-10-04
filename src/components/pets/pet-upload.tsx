"use client";
import { useEffect, useRef, useState } from "react";
import type { PetManifest } from "@/lib/pets/shared";
import { PetPreview } from "./pet-preview";
export const petControl = "pet-control min-h-11 rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-50";
type Draft = { manifest: PetManifest; sprite: Blob; src: string };

function uploadData(draft: Draft) {
  const form = new FormData();
  form.set("manifest", new File([JSON.stringify({ ...draft.manifest, spritesheetPath: "spritesheet.png" })], "pet.json", { type: "application/json" }));
  form.set("sprite", draft.sprite, "spritesheet.png"); form.set("credit", draft.manifest.credit); form.set("rights", "confirmed");
  return form;
}

export function PetUpload({ endpoint, shared = false, disabled = false, onSaved }: { endpoint: string; shared?: boolean; disabled?: boolean; onSaved: (value: unknown) => void }) {
  const [pending, setPending] = useState<"validation" | "save" | "export" | null>(null);
  const [error, setError] = useState("");
  const [format, setFormat] = useState("files");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const operation = useRef<AbortController | null>(null), generation = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => () => { generation.current++; operation.current?.abort(); }, []);
  useEffect(() => () => { if (draft) URL.revokeObjectURL(draft.src); }, [draft]);
  function reset() {
    generation.current++; operation.current?.abort(); operation.current = null;
    setDraft(null); setReviewed(false); setError(""); setPending(null); formRef.current?.reset();
  }
  async function submit(action: "validation" | "save" | "export", data: FormData) {
    if (operation.current) return;
    const controller = new AbortController(), ticket = ++generation.current;
    operation.current = controller; setPending(action); setError("");
    try {
      const url = action === "export" ? "/api/pets/export" : `${endpoint}${action === "validation" ? "?validate=1" : ""}`;
      const response = await fetch(url, { method: "POST", body: data, signal: controller.signal });
      if (!response.ok) { const value = await response.json(); throw new Error(value.error ?? "Could not process pet."); }
      if (action === "export") {
        const blob = await response.blob();
        if (generation.current !== ticket) return;
        const href = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = href; link.download = "codex-pet-v2.zip"; link.click(); window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      } else {
        const value = await response.json();
        if (generation.current !== ticket) return;
        if (action === "validation") {
          const bytes = Uint8Array.from(atob(value.sprite), (character) => character.charCodeAt(0));
          const sprite = new Blob([bytes], { type: "image/png" });
          setDraft({ manifest: value.manifest, sprite, src: URL.createObjectURL(sprite) }); setReviewed(false);
        } else { onSaved(value); setDraft(null); setReviewed(false); formRef.current?.reset(); }
      }
    } catch (err) {
      if (generation.current === ticket && !controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not process pet.");
    } finally { if (generation.current === ticket) { operation.current = null; setPending(null); } }
  }
  return <div className="space-y-3">
    <p className="text-sm font-medium">Pet builder · Import and review</p>
    <p className="text-xs leading-relaxed text-muted">New imports use Codex Pet v2: 1536 × 2288, nine animation rows and sixteen look directions. Choose pet.json (up to 16 KB) and a static PNG/WebP (up to 4 MB), or a ZIP containing those two files at its root.</p>
    <p className="text-xs text-muted">AI creation from a description or reference image is not available yet. This workflow makes no paid generation calls.</p>
    {!draft ? <form ref={formRef} className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const manifest = data.get("manifest"), sprite = data.get("sprite"), archive = data.get("archive");
      if (format === "zip" ? !(archive instanceof File) || !archive.size || archive.size > 4214784 : !(manifest instanceof File) || !manifest.size || manifest.size > 16384 || !(sprite instanceof File) || !sprite.size || sprite.size > 4194304) { setError("Choose a pet.json up to 16 KB and a sprite up to 4 MB, or a ZIP up to 4 MB plus 20 KB."); return; }
      void submit("validation", data);
    }}>
      <fieldset disabled={Boolean(pending) || disabled} className="space-y-3">
        <label className="block text-xs">Import format<select aria-label="Import format" className={`${petControl} mt-1 block w-full bg-bg`} value={format} onChange={(event) => { setFormat(event.target.value); setError(""); }}><option value="files">pet.json and sprite sheet</option><option value="zip">Pet ZIP archive</option></select></label>
        {format === "zip" ? <label className="block text-xs">Pet ZIP<input className={`${petControl} mt-1 block w-full text-xs`} type="file" name="archive" accept=".zip,application/zip" required /></label> : <>
          <label className="block text-xs">pet.json<input className={`${petControl} mt-1 block w-full text-xs`} type="file" name="manifest" accept=".json,application/json" required /></label>
          <label className="block text-xs">Sprite sheet<input className={`${petControl} mt-1 block w-full text-xs`} type="file" name="sprite" accept=".png,.webp,image/png,image/webp" required /></label>
        </>}
        <label className="block text-xs">Artist and license credit<input className={`${petControl} mt-1 w-full bg-bg`} name="credit" maxLength={240} placeholder="Include attribution, or preserve credit in pet.json" /></label>
        <label className="flex min-h-11 items-start gap-2 text-xs leading-relaxed"><input type="checkbox" name="rights" value="confirmed" required className="mt-1 accent-accent" /><span>I have permission to {shared ? "use and share this artwork with all signed-in users" : "use this artwork"} and have included any required credit.</span></label>
        <button className={petControl} type="submit">{pending ? "Validating…" : "Validate and preview"}</button>
      </fieldset>
    </form> : <>
      <p role="status" className="text-xs text-muted">Structure validated. Nothing has been saved. Review the artwork before {shared ? "saving an admin draft" : "replacing and selecting your private import"}.</p>
      <PetPreview src={draft.src} manifest={draft.manifest} />
      <label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" checked={reviewed} disabled={Boolean(pending) || disabled} onChange={(event) => setReviewed(event.target.checked)} className="mt-1" />I reviewed all animation states and look directions, including light and dark previews.</label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={petControl} disabled={!reviewed || Boolean(pending) || disabled} onClick={() => void submit("save", uploadData(draft))}>{pending === "save" ? "Saving…" : shared ? "Upload draft" : "Import pet"}</button>
        <button type="button" className={petControl} disabled={Boolean(pending) || disabled} onClick={() => void submit("export", uploadData(draft))}>{pending === "export" ? "Exporting…" : "Export v2 ZIP"}</button>
      </div>
    </>}
    {(draft || pending === "validation") && <button type="button" className={petControl} disabled={pending === "save" || pending === "export"} onClick={reset}>Cancel and start over</button>}
    {pending === "save" && <p className="text-xs text-muted">Saving may finish even if you close this view. Reopen the pet settings to check its current state.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
