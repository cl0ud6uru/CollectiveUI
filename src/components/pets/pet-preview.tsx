"use client";
import { useEffect, useState } from "react";
import { PET_ANIMATIONS, PET_AVATAR_SIZES, PET_DIRECTIONS } from "@/lib/pets/atlas";
import type { PetManifest } from "@/lib/pets/shared";

function Cell({ src, row, column, size }: { src: string; row: number; column: number; size: number }) {
  const width = size * 192 / 208;
  return <span className="relative inline-block shrink-0 overflow-hidden" style={{ width, height: size }} aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={src} alt="" draggable={false} className="absolute max-w-none" style={{ width: width * 8, height: size * 11, left: -column * width, top: -row * size }} />
  </span>;
}

/** Same slot geometry as BotAvatar; fixed directions are never played as animation frames. */
export function PetPreview({ src, manifest }: { src: string; manifest: PetManifest }) {
  const [row, setRow] = useState(0), [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false), [available, setAvailable] = useState(false);
  const [direction, setDirection] = useState<number | null>(null);
  const state = PET_ANIMATIONS[row];
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAvailable(!media.matches && document.visibilityState === "visible");
    sync(); media.addEventListener("change", sync); document.addEventListener("visibilitychange", sync);
    return () => { media.removeEventListener("change", sync); document.removeEventListener("visibilitychange", sync); };
  }, []);
  useEffect(() => {
    if (!playing || !available || direction !== null) return;
    const timer = window.setTimeout(() => setFrame((previous) => (previous + 1) % state.durations.length), state.durations[frame]);
    return () => window.clearTimeout(timer);
  }, [playing, available, direction, frame, state]);
  const cell = direction === null ? { row, column: frame } : PET_DIRECTIONS[direction];
  return <section aria-label="Codex Pet v2 preview" className="min-w-0 space-y-4">
    <div><h3 className="break-words font-medium">{manifest.displayName} · Codex Pet v2</h3><p className="break-words text-xs text-muted">{manifest.description}</p><p className="break-words text-xs">Credit: {manifest.credit || "Not supplied"}</p></div>
    <fieldset><legend className="mb-2 text-sm font-medium">Nine animation states</legend>
      <div className="grid grid-cols-3 gap-2">{PET_ANIMATIONS.map((animation, index) => <button key={animation.name} type="button" aria-pressed={direction === null && row === index} onClick={() => { setRow(index); setFrame(0); setDirection(null); }} className={`pet-control flex min-w-0 flex-col items-center rounded-lg border p-2 text-xs ${direction === null && row === index ? "border-accent" : "border-border"}`}>
        <Cell src={src} row={index} column={0} size={56} /><span>{animation.label}</span>
      </button>)}</div>
    </fieldset>
    {direction === null && <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={!available} aria-pressed={playing && available} className="pet-control min-h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50" onClick={() => setPlaying(!playing)}>{playing && available ? "Pause animation" : "Play animation"}</button>
      <label className="text-xs">{state.label} frame {frame + 1} of {state.durations.length}<input aria-label="Animation frame" className="block max-w-full accent-accent" type="range" min={0} max={state.durations.length - 1} value={frame} onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} /></label>
      {!available && <p className="text-xs text-muted">Playback follows reduced motion and page visibility. Inspect each frame with the slider.</p>}
    </div>}
    <fieldset><legend className="mb-2 text-sm font-medium">Sixteen look directions · clockwise from up</legend>
      <div className="grid grid-cols-4 gap-2">{PET_DIRECTIONS.map((look, index) => <button key={look.degrees} type="button" aria-pressed={direction === index} onClick={() => { setDirection(index); setPlaying(false); }} className={`pet-control flex min-w-0 flex-col items-center rounded-lg border px-1 py-2 text-xs ${direction === index ? "border-accent" : "border-border"}`}>
        <Cell src={src} row={look.row} column={look.column} size={48} /><span>{look.label}</span>
      </button>)}</div>
    </fieldset>
    <p className="text-xs text-muted">Selected: {direction === null ? `${state.label}, frame ${frame + 1}` : PET_DIRECTIONS[direction].label}. Check gaze direction, clipping, consistent identity and motion. Structural validation cannot judge artwork quality.</p>
    <div className="space-y-2">{["Light", "Dark"].map((theme) => <div key={theme} className="rounded-lg border p-3" style={{ background: theme === "Light" ? "#fff" : "#171717", color: theme === "Light" ? "#171717" : "#fff", borderColor: "#737373" }}>
      <p className="mb-2 text-xs font-medium">{theme} · actual avatar sizes</p>
      <div className="flex flex-wrap items-end gap-3">{PET_AVATAR_SIZES.map((size) => <figure key={size} className="text-center"><Cell src={src} row={cell.row} column={cell.column} size={size} /><figcaption className="text-[10px]">{size} px</figcaption></figure>)}</div>
    </div>)}</div>
  </section>;
}
