"use client";

import { useEffect, useState } from "react";
import type { VoiceAudioDiagnostics } from "@/lib/voice/audio-diagnostics";

export function VoiceAudioDiagnosticsControls({ diagnostics, active }: { diagnostics: VoiceAudioDiagnostics; active: boolean }) {
  const [, refresh] = useState(0);
  useEffect(() => diagnostics.subscribe(() => refresh(value => value + 1)), [diagnostics]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics.report(), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "voice-audio-diagnostics.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details className="text-xs text-white/70">
    <summary className="cursor-pointer">Audio diagnostics</summary>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="button" className="underline" disabled={!active && !diagnostics.enabled} onClick={() => diagnostics.enabled ? diagnostics.stop() : diagnostics.start()}>{diagnostics.enabled ? "Stop capture" : "Capture locally"}</button>
      <button type="button" className="underline" onClick={() => diagnostics.clear()}>Clear</button>
      <button type="button" className="underline" disabled={!diagnostics.count} onClick={download}>Export JSON</button>
      <span role="status">{diagnostics.count} / 180 samples{diagnostics.enabled ? " · capturing" : ""}</span>
    </div>
    <p className="mt-2">Capture up to three minutes of numeric playback metrics, kept here until cleared. Unavailable metrics are omitted. No audio or transcript is captured or uploaded.</p>
  </details>;
}
