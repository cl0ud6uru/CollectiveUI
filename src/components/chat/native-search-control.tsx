"use client";

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { toast } from "sonner";
import { SEARCH_COST_NOTICE, type NativeSearchMode } from "@/lib/native-search-policy";
import type { TargetOption } from "./types";

export function NativeSearchControl({ target, conversationId, started, busy, onChange }: {
  target: TargetOption; conversationId: string; started: boolean; busy: boolean;
  onChange: (mode: NativeSearchMode | null, pending: boolean) => void;
}) {
  const [state, setState] = useState<{ mode: NativeSearchMode; reason: string | null; maxCalls?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    onChange("off", true);
    const query = new URLSearchParams(started ? { conversationId } : target.kind === "bot" ? { botId: target.id } : { appId: target.id });
    const lookup = async () => {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`/api/chat/native-search?${query}`, { signal: abort.signal, cache: "no-store" });
        if (response.status !== 404 || !started || attempt === 9) return response;
        await new Promise(resolve => setTimeout(resolve, 200));
        abort.signal.throwIfAborted();
      }
    };
    lookup().then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Search settings unavailable.");
      if (!abort.signal.aborted) { setState(data); onChange(data.mode, false); }
    }).catch(error => {
      if (!abort.signal.aborted) { setState({ mode: "off", reason: `${error.message} Reload to verify search settings before sending.` }); onChange("off", true); }
    });
    return () => abort.abort();
  }, [conversationId, started, target.id, target.kind, onChange]);

  async function change(mode: NativeSearchMode) {
    if (!state) return;
    setSaving(true); onChange(state.mode, true);
    try {
      if (started) {
        const response = await fetch("/api/chat/native-search", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, mode }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not save search setting.");
      }
      setState({ ...state, mode }); onChange(mode, false);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Could not save search setting.";
      toast.error(reason);
      // A lost response can follow a committed write. Never send with an unverified mode.
      setState({ ...state, reason: `${reason} Reload to verify search settings before sending.` });
      onChange(state.mode, true);
    }
    finally { setSaving(false); }
  }
  return <details className="mb-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
    <summary className="flex cursor-pointer items-center gap-2 text-muted"><Globe className="h-3.5 w-3.5" />OpenAI native search · {!state ? "Loading…" : state.reason ? "Unavailable" : state.mode === "auto" ? "Auto" : "Off"}</summary>
    <div className="mt-2 space-y-2">
      <label className="flex items-center gap-2">Search for this chat
        <select aria-label="OpenAI native search" className="rounded border border-border bg-bg px-2 py-1" value={state?.mode ?? "off"} disabled={!state || saving || busy} onChange={e => void change(e.target.value as NativeSearchMode)}>
          <option value="off">Off</option><option value="auto" disabled={!!state?.reason}>Auto</option>
        </select>
      </label>
      {state?.reason && <p role="status">{state.reason}</p>}
      {target.kind === "group" && <p>Auto uses eligible bots&apos; enabled search tools. Off disables native search for every speaker. The call limit is shared across speakers.</p>}
      <p className="text-muted">{SEARCH_COST_NOTICE}</p>
      <p className="text-muted">{state?.maxCalls ? `At most ${state.maxCalls} hosted calls per reply. ` : ""}Other enabled search tools remain independent. No automatic fallback.</p>
    </div>
  </details>;
}
