"use client";
import { useEffect, useRef, useState } from "react";
import type { PetManifest } from "@/lib/pets/shared";
import { PetPreview } from "./pet-preview";
import { petControl } from "./pet-upload";

export function SavedPetPreview({ manifest, src }: { manifest: PetManifest; src: string }) {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  if (manifest.spriteVersionNumber !== 2) return <p className="mt-3 text-xs text-muted">Legacy v1 pet. Existing selections still work; import a complete v2 sheet to use the builder.</p>;
  async function download() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setError("");
    try {
      const sprite = await fetch(src, { cache: "no-store", signal: controller.signal });
      if (!sprite.ok) throw new Error("The saved pet is no longer available. Refresh before exporting.");
      const form = new FormData();
      form.set("manifest", new File([JSON.stringify({ ...manifest, spritesheetPath: "spritesheet.png" })], "pet.json"));
      form.set("sprite", await sprite.blob(), "spritesheet.png"); form.set("credit", manifest.credit); form.set("rights", "confirmed");
      const response = await fetch("/api/pets/export", { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) { const value = await response.json(); throw new Error(value.error ?? "Could not export pet."); }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "codex-pet-v2.zip"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not export pet."); }
    finally { active.current = null; if (!controller.signal.aborted) setPending(false); }
  }
  return <details className="mt-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="pet-control cursor-pointer rounded-lg py-2 text-sm">Inspect all states and export</summary>
    {open && <div className="mt-3 space-y-3"><PetPreview manifest={manifest} src={src} /><button type="button" className={petControl} disabled={pending} onClick={() => void download()}>{pending ? "Exporting…" : "Export v2 ZIP"}</button>{error && <p role="alert" className="text-sm text-danger">{error}</p>}</div>}
  </details>;
}
