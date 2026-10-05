"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { PET_FRAMES, PET_GREETING, type PetArtState, type PetView } from "@/lib/pets/shared";
import "./pets.css";

/** Original CollectiveUI artwork. Imported files never enter this SVG markup. */
function Seedling({ ember }: { ember: boolean }) {
  return <svg viewBox="0 0 96 104" fill="none" aria-hidden="true" className="pet-seedling">
    <ellipse cx="48" cy="93" rx="25" ry="4" fill="currentColor" opacity=".08" />
    <g className="pet-body">
      <path d="M45 34C46 24 52 19 58 16" stroke={ember ? "#9c542b" : "#587958"} strokeWidth="4" strokeLinecap="round" />
      <path d="M49 28C31 29 26 18 27 10C41 9 49 15 49 28Z" fill={ember ? "#e7a355" : "#80aa77"} />
      <path d="M51 23C50 12 59 7 70 8C70 18 64 24 51 23Z" fill={ember ? "#c5773e" : "#527c5a"} />
      <path d="M26 78L23 89C26 93 34 93 38 88L39 80M57 80L58 89C63 94 71 92 73 89L70 78" fill={ember ? "#9f653e" : "#637960"} />
      <rect x="16" y="33" width="64" height="54" rx="23" fill={ember ? "#dfb17d" : "#b5c5a5"} />
      <path d="M20 54C20 42 30 37 43 37" stroke={ember ? "#f7dbb7" : "#e0e8cb"} strokeWidth="4" strokeLinecap="round" />
      <rect x="25" y="48" width="46" height="26" rx="12" fill={ember ? "#513c32" : "#354a40"} />
      <g className="pet-eyes" fill="#f5efd4"><rect x="35" y="55" width="5" height="9" rx="2.5" /><rect x="56" y="55" width="5" height="9" rx="2.5" /></g>
      <path d="M44 65Q48 68 52 65" stroke="#f5efd4" strokeWidth="1.5" strokeLinecap="round" />
      <path className="pet-hand" d="M18 63Q7 66 12 75M78 63Q89 66 84 75" stroke={ember ? "#c48d5b" : "#8da581"} strokeWidth="7" strokeLinecap="round" />
      <circle cx="48" cy="80" r="2" fill={ember ? "#8e482a" : "#547653"} />
    </g>
  </svg>;
}

export function PetArt({ pet, state, size = 64, still = false, compact = false, fallback }: { pet: PetView; state: PetArtState; botId?: string; size?: number; still?: boolean; compact?: boolean; fallback?: React.ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [failedHd, setFailedHd] = useState<string | null>(null);
  const retried = useRef(new Set<string>());
  useEffect(() => {
    if (!failedSrc || retried.current.has(failedSrc)) return;
    const timer = window.setTimeout(() => { retried.current.add(failedSrc); setFailedSrc(null); }, 3000);
    return () => window.clearTimeout(timer);
  }, [failedSrc]);
  const imported = (pet.appearance === "custom" || pet.appearance === "catalog") && pet.custom;
  const src = pet.spriteUrl;
  // The browser picks the 2× sheet only when the atlas is drawn wider than 1536 device pixels (large avatars on dense
  // screens). If it fails, the v2 sheet alone is retried before falling back to the original icon.
  const hdSrc = pet.spriteHdUrl && pet.custom?.spriteVersionNumber === 2 && failedHd !== pet.spriteHdUrl ? pet.spriteHdUrl : null;
  const animation = state === "greeting" ? PET_GREETING : PET_FRAMES[state];
  const height = size * 208 / 192;
  const style = { width: size, height, "--pet-travel": `${-size * animation.frames}px`, "--pet-frames": animation.frames, "--pet-duration": `${animation.seconds}s` } as CSSProperties;
  if (imported && (!src || failedSrc === src) && fallback) return fallback;
  return <span data-pet-art data-state={state} data-compact={compact} data-still={still || pet.motion === "still" || state === "unavailable"} className="pet-art" style={style} aria-hidden="true">
    {imported && src && failedSrc !== src ? (
      // A bounded, authenticated PNG atlas (or its WebP HD rendition), rendered at its cell aspect ratio.
      // eslint-disable-next-line @next/next/no-img-element
      <img key={`${src}:${state}`} className="pet-atlas" src={src} srcSet={hdSrc ? `${src} 1536w, ${hdSrc} 3072w` : undefined} sizes={hdSrc ? `${size * 8}px` : undefined}
        alt="" draggable={false} onError={(event) => {
          if (hdSrc && event.currentTarget.currentSrc === new URL(hdSrc, location.href).href) setFailedHd(hdSrc);
          else setFailedSrc(src);
        }} style={{ width: size * 8, height: height * (pet.custom?.spriteVersionNumber === 2 ? 11 : 9), top: -height * animation.row }} />
    ) : <Seedling ember={pet.appearance === "ember"} />}
  </span>;
}
