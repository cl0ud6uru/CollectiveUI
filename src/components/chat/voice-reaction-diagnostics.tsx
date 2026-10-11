"use client";
import { useEffect, useState } from "react";
import type { VoiceReactionDiagnostics } from "@/lib/voice/reaction-diagnostics";
export function VoiceReactionDiagnosticsControls({ diagnostics, active, onCaptureChange }: { diagnostics: VoiceReactionDiagnostics; active: boolean; onCaptureChange: (capturing: boolean) => void }) {
  const [report, setReport] = useState<ReturnType<VoiceReactionDiagnostics["report"]> | null>(null);
  useEffect(() => {
    if (!report?.enabled) return;
    const timer = setInterval(() => { const value = diagnostics.report(); setReport(value); if (!value.enabled) onCaptureChange(false); }, 1000);
    return () => clearInterval(timer);
  }, [diagnostics, report?.enabled, onCaptureChange]);
  return <details className="mt-2 text-xs text-white/60"><summary>Avatar diagnostics</summary>
    <p className="mt-2">Local timing and fixed reaction labels only. No conversation text or audio. Capture stops after three minutes.</p>
    <button type="button" disabled={!active && !report?.enabled} className="mt-2 rounded border border-white/20 px-3 py-2" onClick={() => {
      if (report?.enabled) diagnostics.stop(); else diagnostics.start();
      const value = diagnostics.report(); setReport(value); onCaptureChange(value.enabled);
    }}>{report?.enabled ? "Stop avatar capture" : "Start avatar capture"}</button>
    {report && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(report, null, 2)}</pre>}
  </details>;
}
