"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PublicLoginPet } from "@/lib/branding/shared";
import { PetArt } from "@/components/pets/pet-art";
import { DEFAULT_PET, type PetArtState, type PetView } from "@/lib/pets/shared";
import { useLoginMood } from "./login-mood";

const LINES = ["Hi there!", "Welcome back!", "Ready when you are.", "Let’s build something.", "Good to see you!"];
const BURST = ["#3b82f6", "#ec4899", "#14b8a6", "#f97316", "#eab308", "#8b5cf6", "#4ade80", "#f5f5f5"];
const GREETING_MS = 1800;

const compactQuery = "(max-width: 760px)";
function useCompact() {
  return useSyncExternalStore((onChange) => {
    const media = matchMedia(compactQuery);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, () => matchMedia(compactQuery).matches, () => false);
}

/** The portal's own bot, drawn like PortalMark. Happy eyes while it says hello. */
function PortalBot({ state }: { state: PetArtState }) {
  const blob = state === "greeting" || state === "working" ? "working" : state === "attention" ? "waiting" : "idle";
  return <svg viewBox="0 0 100 100" className={`blob blob-${blob} block w-full`} aria-hidden="true">
    <g className="blob-body">
      <circle cx="50" cy="50" r="44" fill="#f5f5f5" />
      {state === "greeting" ? <g stroke="#0d0d0d" strokeWidth="5" strokeLinecap="round" fill="none"><path d="M35 50Q41 39 47 50" /><path d="M54 50Q60 39 66 50" /></g>
        : <g className="blob-eyes">
          <rect x="37" y="36" width="9" height="20" rx="4.5" fill="#0d0d0d" transform="rotate(-14 41.5 46)" />
          <rect x="55" y="36" width="9" height="20" rx="4.5" fill="#0d0d0d" transform="rotate(-14 59.5 46)" />
        </g>}
    </g>
  </svg>;
}

function petView(pet: PublicLoginPet): PetView | null {
  if (pet.appearance === "off") return null;
  if (pet.appearance === "catalog") return { ...DEFAULT_PET, enabled: true, appearance: "catalog", spriteUrl: pet.spriteUrl, spriteHdUrl: pet.spriteHdUrl,
    custom: { displayName: pet.name, description: "", spriteVersionNumber: pet.spriteVersionNumber, credit: pet.credit } };
  return { ...DEFAULT_PET, enabled: true, appearance: pet.appearance };
}

/** Click to say hello. It also follows the sign-in form: busy while signing in, concerned after an error. */
export function LoginCompanion({ pet }: { pet: PublicLoginPet }) {
  const mood = useLoginMood();
  const compact = useCompact();
  const [greetings, setGreetings] = useState(0);
  const [greeting, setGreeting] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function greet() {
    setGreetings((n) => n + 1);
    setGreeting(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setGreeting(false), GREETING_MS);
  }
  const state: PetArtState = greeting ? "greeting" : mood;
  const view = petView(pet);
  const fallback = <PortalBot state={state} />;
  return (
    <button type="button" className="login-companion" data-state={state} onClick={greet} aria-label={`Say hello to ${pet.name}`}>
      <span key={greetings} className="login-companion-hop" data-hop={greetings > 0 || undefined}>
        {view ? <PetArt pet={view} state={state} size={compact ? 96 : 150} fallback={fallback} /> : fallback}
      </span>
      {greeting && <>
        <span key={`burst-${greetings}`} className="login-companion-burst" aria-hidden="true">
          {BURST.map((color, i) => <span key={i} style={{ "--a": `${i * 45 + (greetings % 2) * 22}deg`, background: color } as React.CSSProperties} />)}
        </span>
        <span key={`line-${greetings}`} className="login-companion-bubble" aria-hidden="true">{LINES[(greetings - 1) % LINES.length]}</span>
      </>}
      <span className="login-companion-tag" aria-hidden="true">Say hi to {pet.name}</span>
    </button>
  );
}
