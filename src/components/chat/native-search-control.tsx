"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { SEARCH_COST_NOTICE, type NativeSearchMode } from "@/lib/native-search-policy";
import type { TargetOption } from "./types";

export function NativeSearchControl({ target, conversationId, started, busy, onChange }: {
  target: TargetOption; conversationId: string; started: boolean; busy: boolean;
  onChange: (mode: NativeSearchMode | null, pending: boolean) => void;
}) {
  const [state, setState] = useState<{ mode: NativeSearchMode; reason: string | null; maxCalls?: number; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const errorDescription = useId();
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    request.current = abort;
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
      if (!abort.signal.aborted) {
        setState({ mode: "off", reason: error.message, error: "Search settings could not be verified." });
        onChange("off", true);
      }
    });
    return () => abort.abort();
  }, [conversationId, started, target.id, target.kind, onChange]);

  async function change(mode: NativeSearchMode) {
    if (!state) return;
    const current = request.current;
    setSaving(true); onChange(state.mode, true);
    try {
      if (started) {
        const response = await fetch("/api/chat/native-search", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, mode }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not save search setting.");
      }
      if (current?.signal.aborted) return;
      setState({ ...state, mode }); onChange(mode, false);
    } catch (err) {
      if (current?.signal.aborted) return;
      const reason = err instanceof Error ? err.message : "Could not save search setting.";
      // A lost response can follow a committed write. Never send with an unverified mode.
      setState({ ...state, reason, error: "Search settings could not be saved or verified." });
      onChange(state.mode, true);
    }
    finally { if (!current?.signal.aborted) setSaving(false); }
  }
  return <Dialog>
    <DialogTrigger asChild>
      <button type="button" aria-label="Tools" aria-describedby={state?.error ? errorDescription : undefined} title={state?.error ? "Search settings need verification" : undefined} className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm text-muted hover:bg-hover hover:text-fg">
        <SlidersHorizontal className="h-4 w-4" aria-hidden />Tools
        {state?.error && <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden />}
      </button>
    </DialogTrigger>
    {state?.error && <span id={errorDescription} className="sr-only">Search settings need verification. Open Tools to reload before sending.</span>}
    <DialogContent title="Tools" description="Search settings for this chat." className="max-w-sm">
      <div className="space-y-3 text-sm">
        <label className="flex items-center justify-between gap-3"><span className="min-w-0 font-medium">OpenAI native search</span>
          <select aria-label="OpenAI native search" className="shrink-0 rounded-lg border border-border bg-bg px-2 py-2 text-base" value={state?.mode ?? "off"} disabled={!state || !!state.error || saving || busy} onChange={e => void change(e.target.value as NativeSearchMode)}>
            <option value="off">Off</option><option value="auto" disabled={!!state?.reason}>Auto</option>
          </select>
        </label>
        {!state ? <p role="status">Checking availability…</p> : state.reason ? <p role="status" className="text-muted">{state.reason}</p> : <p className="text-muted">Auto lets the model search when needed. You don&apos;t need to enable it for each message.</p>}
        {state?.error && <p role="alert" className="text-danger">{state.error} <button type="button" className="underline" onClick={() => window.location.reload()}>Reload before sending</button>.</p>}
        {target.kind === "group" && <p className="text-xs text-muted">Auto uses each eligible bot&apos;s enabled search tool. Off applies to every speaker; the call limit is shared.</p>}
        {!state?.reason && <p className="text-xs text-muted">{SEARCH_COST_NOTICE}{state?.maxCalls ? ` Limit: ${state.maxCalls} calls per reply.` : ""}</p>}
        <p className="text-xs text-muted">External web search uses your administrator&apos;s SearXNG, Brave or Bing provider. Its bot setting is separate; there is no automatic fallback.</p>
      </div>
    </DialogContent>
  </Dialog>;
}
