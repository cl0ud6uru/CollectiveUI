"use client";

import { X } from "lucide-react";
import type { CommandResult } from "@/lib/chat/hermes-commands";

/** Local control results never become assistant messages, model history or rendered upstream HTML. */
export function CommandResultCard({ result, onClose }: { result: CommandResult; onClose: () => void }) {
  return (
    <section role="status" aria-live="polite" aria-label="Command result" className="mb-3 max-h-72 overflow-y-auto rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-medium">{result.title}</h2>
        <button onClick={onClose} aria-label="Dismiss command result" className="rounded p-1 text-muted hover:bg-hover"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-2 text-muted">{result.lines.map((line, index) => <p key={index} className="whitespace-pre-wrap break-words">{line}</p>)}</div>
    </section>
  );
}
