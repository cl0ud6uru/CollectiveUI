"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HermesTeamControls, type HermesTeamMode, type HermesTeamView } from "./hermes-team-controls";

/** The server resolves all runtime/profile bindings from the current person and bot. */
export function HermesTeamChatControls({ botId, conversationId, started, busy }: {
  botId: string;
  conversationId: string;
  started: boolean;
  busy: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<{ scope: string; view: HermesTeamView } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const scope = `${botId}:${started ? conversationId : "new"}`;
  const base = `/api/bots/${encodeURIComponent(botId)}/team`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const query = started ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
        const response = await fetch(`${base}${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load this Team Bot’s status.");
        if (!controller.signal.aborted) { setStatus({ scope, view: data as HermesTeamView }); setError(""); }
      } catch (err) {
        if (!controller.signal.aborted) { setStatus(null); setError(err instanceof Error ? err.message : "Could not load this Team Bot’s status."); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, document.hidden ? 30000 : 5000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, conversationId, started, scope, attempt]);

  async function openMode(mode: HermesTeamMode) {
    const response = await fetch(`${base}/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not open this conversation mode.");
    if (typeof data.conversationId !== "string" || !data.conversationId.length) throw new Error("The server did not confirm a conversation. Try again.");
    router.push(`/c/${encodeURIComponent(data.conversationId)}`);
  }

  const view = status?.scope === scope ? status.view : null;
  if (view) return <HermesTeamControls view={view} busy={busy} onOpenMode={openMode} />;
  return <section aria-label="Hermes Team Bot status" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-muted">
    {error ? <div className="space-y-2 rounded-xl border border-border p-3"><p role="alert">{error}</p><button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div> : <p role="status">Preparing Team Bot controls…</p>}
  </section>;
}
