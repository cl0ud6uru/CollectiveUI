"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from "react";

export type LoginMood = "idle" | "working" | "attention";
const MoodContext = createContext<{ mood: LoginMood; report: (key: string, mood: LoginMood | null) => void } | null>(null);

/** Lets the sign-in forms tell the companion what is happening. Purely cosmetic; forms work without it. */
export function LoginMoodProvider({ children }: { children: React.ReactNode }) {
  const [moods, setMoods] = useState<Record<string, LoginMood>>({});
  const report = useCallback((key: string, mood: LoginMood | null) => setMoods((current) => {
    if ((current[key] ?? null) === mood) return current;
    const next = { ...current };
    if (mood) next[key] = mood; else delete next[key];
    return next;
  }), []);
  const values = Object.values(moods);
  const mood: LoginMood = values.includes("working") ? "working" : values.includes("attention") ? "attention" : "idle";
  const value = useMemo(() => ({ mood, report }), [mood, report]);
  return <MoodContext.Provider value={value}>{children}</MoodContext.Provider>;
}

export function useReportLoginMood(mood: LoginMood) {
  const report = useContext(MoodContext)?.report;
  const key = useId();
  useEffect(() => {
    report?.(key, mood);
    return () => report?.(key, null);
  }, [report, key, mood]);
}

export const useLoginMood = () => useContext(MoodContext)?.mood ?? "idle";
