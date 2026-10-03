"use client";
import { useState } from "react";
export const petControl = "pet-control min-h-11 rounded-lg border border-border px-3 py-2 text-sm hover:bg-hover disabled:opacity-50";

export function PetUpload({ endpoint, shared = false, disabled = false, onSaved }: { endpoint: string; shared?: boolean; disabled?: boolean; onSaved: (value: unknown) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <form className="space-y-3" onSubmit={async (event) => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    const manifest = data.get("manifest"), sprite = data.get("sprite");
    if (!(manifest instanceof File) || manifest.size > 16384 || !(sprite instanceof File) || sprite.size > 4194304) { setError("Use a pet.json up to 16 KB and a sprite sheet up to 4 MB."); return; }
    setPending(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", body: data });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not import pet.");
      onSaved(value); form.reset();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not import pet."); }
    finally { setPending(false); }
  }}>
    <p className="text-xs leading-relaxed text-muted">Use a standard Codex pet.json (up to 16 KB) and a static PNG or WebP sprite sheet (up to 4 MB). V1: 1536 × 1872. V2: 1536 × 2288. No custom animation maps, scripts, archives or URL imports.</p>
    <fieldset disabled={pending || disabled} className="space-y-3">
      <label className="block text-xs">pet.json<input className={`${petControl} mt-1 block w-full text-xs`} type="file" name="manifest" accept=".json,application/json" required /></label>
      <label className="block text-xs">Sprite sheet<input className={`${petControl} mt-1 block w-full text-xs`} type="file" name="sprite" accept=".png,.webp,image/png,image/webp" required /></label>
      <label className="block text-xs">Artist and license credit<input className={`${petControl} mt-1 w-full bg-bg`} name="credit" maxLength={240} placeholder="Include any required attribution" /></label>
      <label className="flex min-h-11 items-start gap-2 text-xs leading-relaxed"><input type="checkbox" name="rights" value="confirmed" required className="mt-1 accent-accent" /><span>I have permission to {shared ? "use and share this artwork with all signed-in users" : "use this artwork"} and have included any required credit.</span></label>
      <button className={petControl} type="submit">{pending ? "Uploading…" : shared ? "Upload draft" : "Import pet"}</button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </form>;
}
