"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { HermesTeamControls, type HermesTeamMode, type HermesTeamView } from "./hermes-team-controls";
import type { HermesTeamCaptureInventory, HermesTeamCaptureSelection, HermesTeamPublishInput, HermesTeamReview } from "./hermes-team-publication";

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
  async function publicationRequest(path: string, input?: unknown) {
    const response = await fetch(`${base}/${path}`, input === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 403 || response.status === 409) setAttempt(value => value + 1);
      throw Object.assign(new Error(data.error ?? "Resource review could not be confirmed. Try again."), { status: response.status });
    }
    return data;
  }
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

  async function prepareCapture(): Promise<HermesTeamCaptureInventory> {
    return publicationRequest("capture") as Promise<HermesTeamCaptureInventory>;
  }
  async function capture(selection: HermesTeamCaptureSelection): Promise<HermesTeamReview> {
    // A fresh authorized status prevents an old polling result from becoming the review's base.
    const query = started ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    const response = await fetch(`${base}${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? "Could not confirm the current Team Bot version."), { status: response.status });
    return publicationRequest("capture", { expectedRevision: data.publishedRevision, selection }) as Promise<HermesTeamReview>;
  }
  async function publish(input: HermesTeamPublishInput): Promise<{ revision: number }> {
    const result = await publicationRequest("publish", input);
    setAttempt(value => value + 1);
    return result;
  }

  const view = status?.scope === scope ? status.view : null;
  if (view) return <HermesTeamControls view={view} busy={busy} onOpenMode={openMode} onPrepareCapture={prepareCapture} onCapture={capture} onPublish={publish} />;
  return <section aria-label="Hermes Team Bot status" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-muted">
    {error ? <div className="space-y-2 rounded-xl border border-border p-3"><p role="alert">{error}</p><button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div> : <p role="status">Preparing Team Bot controls…</p>}
  </section>;
}
