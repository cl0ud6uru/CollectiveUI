"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_PET, PET_LABELS, petState, type PetState, type PetView } from "@/lib/pets/shared";

type Activity = { botId: string; conversationId: string; state: PetState };
type PetContext = {
  pets: Record<string, PetView>;
  updatePet: (botId: string, pet: PetView) => void;
  activity: Activity | null;
  reportActivity: (activity: Activity) => void;
  clearActivity: (conversationId: string) => void;
};
const Context = createContext<PetContext | null>(null);

/** A fresh provider per authenticated account. No browser-persistent cross-account cache. */
export function PetProvider({ initialPets, accountId, children }: { initialPets: Record<string, PetView>; accountId?: string; children?: React.ReactNode }) {
  const [pets, setPets] = useState(initialPets);
  const [serverPets, setServerPets] = useState(initialPets);
  const [activity, setActivity] = useState<Activity | null>(null);
  if (serverPets !== initialPets) { setServerPets(initialPets); setPets(initialPets); }
  const generation = useRef(0);
  const updatePet = useCallback((botId: string, pet: PetView) => {
    generation.current++;
    setPets((current) => ({ ...current, [botId]: pet }));
  }, []);
  useEffect(() => {
    if (!accountId) return;
    const ac = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      const started = ++generation.current;
      try {
        const response = await fetch("/api/pets/preferences", { cache: "no-store", signal: ac.signal });
        if (ac.signal.aborted || started !== generation.current) return;
        if (response.status === 401 || response.status === 403) { setPets({}); setActivity(null); return; }
        if (!response.ok) return;
        const value = await response.json();
        if (ac.signal.aborted) return;
        if (value.userId !== accountId) { setPets({}); setActivity(null); return; }
        if (started === generation.current) setPets(value.pets);
      } catch { /* Transient network errors retain this account's last view; images remain authorized. */ }
      finally { inFlight = false; }
    }
    const timer = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { ac.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [accountId, initialPets]);
  const reportActivity = useCallback((next: Activity) => setActivity(next), []);
  const clearActivity = useCallback((conversationId: string) => setActivity((current) => current?.conversationId === conversationId ? null : current), []);
  const value = useMemo(() => ({ pets, updatePet, activity, reportActivity, clearActivity }), [pets, updatePet, activity, reportActivity, clearActivity]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Optional outside the authenticated chat shell: public/app/branding icons keep their original artwork. */
export function useOptionalPets() { return useContext(Context); }

export function usePets() {
  const value = useContext(Context);
  if (!value) throw new Error("usePets outside PetProvider");
  return value;
}

function subscribeEnvironment(cb: () => void) {
  window.addEventListener("online", cb); window.addEventListener("offline", cb);
  document.addEventListener("visibilitychange", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); document.removeEventListener("visibilitychange", cb); };
}
const readOnline = () => navigator.onLine;
const readVisible = () => document.visibilityState === "visible";
const serverTrue = () => true;
export function usePetEnvironment() {
  const online = useSyncExternalStore(subscribeEnvironment, readOnline, serverTrue);
  const visible = useSyncExternalStore(subscribeEnvironment, readVisible, serverTrue);
  return { online, visible };
}

/** Only the mounted direct chat supplies status. Navigation clears it; other bots remain decorative. */
export function PetChatActivity({ botId, conversationId, status, approval, failed, unavailable }: { botId: string; conversationId: string; status: string; approval: boolean; failed: boolean; unavailable: boolean }) {
  const { pets, reportActivity, clearActivity } = usePets();
  const { online } = usePetEnvironment();
  const state = petState({ status, approval, failed, unavailable, online });
  useEffect(() => {
    reportActivity({ botId, conversationId, state });
    return () => clearActivity(conversationId);
  }, [botId, conversationId, state, reportActivity, clearActivity]);
  return (pets[botId] ?? DEFAULT_PET).enabled
    ? <span role="status" aria-label="Bot avatar activity" aria-live="polite" aria-atomic="true" className="sr-only">{PET_LABELS[state]}</span>
    : null;
}
