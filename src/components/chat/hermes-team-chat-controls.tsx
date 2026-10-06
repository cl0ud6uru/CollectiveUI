"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HermesTeamControls, type HermesTeamMode, type HermesTeamView } from "./hermes-team-controls";
import type { HermesTeamUpdateInput, HermesTeamResolveInput, HermesTeamUpdateReview, HermesTeamUpdateResult } from "./hermes-team-updates";
import type { HermesTeamRevision } from "./hermes-team-restore";
import type { HermesTeamRolloutStatus } from "./hermes-team-rollout";
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
  const [updateError, setUpdateError] = useState<{ scope: string; message: string } | null>(null);
  const automaticAttempts = useRef(new Set<string>());
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
  async function loadRevisions(): Promise<HermesTeamRevision[]> {
    const result = await publicationRequest("revisions");
    if (!Array.isArray(result.revisions)) throw new Error("The server did not confirm the published version list. Try again.");
    return result.revisions;
  }
  async function captureRollback(targetRevision: number): Promise<HermesTeamReview> {
    const query = started ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    const response = await fetch(`${base}${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? "Could not confirm the current Team Bot version."), { status: response.status });
    return publicationRequest("rollback/capture", { targetRevision, expectedRevision: data.publishedRevision }) as Promise<HermesTeamReview>;
  }
  async function publish(input: HermesTeamPublishInput): Promise<{ revision: number }> {
    const result = await publicationRequest("publish", input);
    setAttempt(value => value + 1);
    return result;
  }

  async function loadUpdates(targetRevision?: number): Promise<HermesTeamUpdateReview> {
    return publicationRequest(`updates${targetRevision === undefined ? "" : `?targetRevision=${targetRevision}`}`) as Promise<HermesTeamUpdateReview>;
  }
  async function update(path: string, input: HermesTeamUpdateInput | HermesTeamResolveInput | { requestId: string }): Promise<HermesTeamUpdateResult> {
    if (status?.scope === scope) automaticAttempts.current.add(`${scope}:${status.view.publishedRevision}`);
    const result = await publicationRequest(path, input);
    setAttempt(value => value + 1); setUpdateError(null);
    return result;
  }
  const view = status?.scope === scope ? status.view : null;
  // Inventory capability and idle state must both be confirmed before an automatic member update.
  useEffect(() => {
    if (busy || !view?.enabled || view.mode !== "member" || !["ready", "connection_needed"].includes(view.state) || view.installedRevision === view.publishedRevision) return;
    const key = `${scope}:${view.publishedRevision}`;
    if (automaticAttempts.current.has(key)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${base}/updates`, { cache: "no-store", signal: controller.signal });
        const preview = await response.json() as HermesTeamUpdateReview & { error?: string };
        if (!response.ok) throw new Error(preview.error ?? "Native member updates are unavailable. Your content is preserved.");
        if (controller.signal.aborted || preview.nativeUpdatesSupported !== true || preview.pendingRequestId || !["ready", "connection_needed"].includes(preview.state) || preview.installedRevision === preview.targetRevision) return;
        automaticAttempts.current.add(key);
        const applied = await fetch(`${base}/updates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedInstalledRevision: preview.installedRevision, targetRevision: preview.targetRevision, requestId: crypto.randomUUID() }) });
        const result = await applied.json();
        if (!applied.ok) throw new Error(result.error ?? "Your update needs recovery. Open Team updates to resume its saved request.");
        if (!controller.signal.aborted) { setAttempt(value => value + 1); setUpdateError(result.status === "needs_attention" ? { scope, message: "Your team update needs recovery. Open Team updates to resume its saved request." } : null); }
      } catch (err) { if (!controller.signal.aborted) setUpdateError({ scope, message: err instanceof Error ? err.message : "Member updates are unavailable. Your content is preserved." }); }
    })();
    return () => controller.abort();
  }, [base, scope, busy, view?.enabled, view?.mode, view?.state, view?.installedRevision, view?.publishedRevision]);
  if (view) return <>
    <HermesTeamControls view={view} busy={busy} onOpenMode={openMode} onPrepareCapture={prepareCapture} onCapture={capture} onPublish={publish}
      onLoadRollout={() => publicationRequest("publish") as Promise<HermesTeamRolloutStatus>} onLoadRevisions={loadRevisions} onCaptureRollback={captureRollback}
      onLoadUpdates={loadUpdates} onApplyUpdate={input => update("updates", input)} onResolveUpdate={input => update("updates/resolve", input)}
      onRollbackUpdate={input => update("updates", input)} onCancelUpdate={requestId => update("updates/cancel", { requestId })} />
    {updateError?.scope === scope && view.mode === "member" && <p role="alert" className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-danger">{updateError.message}</p>}
  </>;
  return <section aria-label="Hermes Team Bot status" className="mx-auto w-full max-w-3xl px-4 py-2 text-sm text-muted">
    {error ? <div className="space-y-2 rounded-xl border border-border p-3"><p role="alert">{error}</p><button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div> : <p role="status">Preparing Team Bot controls…</p>}
  </section>;
}
