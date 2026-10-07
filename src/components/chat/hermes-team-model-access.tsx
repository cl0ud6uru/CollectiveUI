"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import type { TeamModelPolicyMode } from "@/lib/hermes-team/model-policy";

type Choice = "default" | "personal";
export type HermesTeamModelView = {
  modelChoice: Choice;
  definitionVersion: number;
  modelPolicyMode: TeamModelPolicyMode;
  personalAllowed: boolean;
  personalRequired: boolean;
  modelAccessAvailable: boolean;
  modelAccessReason: string;
  personalConnection: { state: "unavailable" | "connected" | "connection_needed"; message: string };
  connectAvailable: boolean;
  connectReason: string;
};
export type HermesTeamModelSummary = {
  modelPolicyMode?: TeamModelPolicyMode;
  personalAllowed?: boolean;
  personalRequired?: boolean;
  modelAccessReason?: string;
};

function confirmedView(value: HermesTeamModelView): HermesTeamModelView {
  if (!value || typeof value !== "object") throw new Error("Model settings were not confirmed. Refresh before choosing a connection.");
  if (!["default", "personal"].includes(value.modelChoice) || !Number.isSafeInteger(value.definitionVersion) || value.definitionVersion < 1
    || !["admin_provided", "admin_default_personal_allowed", "personal_required"].includes(value.modelPolicyMode)
    || typeof value.personalAllowed !== "boolean" || typeof value.personalRequired !== "boolean" || typeof value.modelAccessAvailable !== "boolean"
    || typeof value.modelAccessReason !== "string" || typeof value.connectAvailable !== "boolean" || typeof value.connectReason !== "string"
    || !value.personalConnection || !["unavailable", "connected", "connection_needed"].includes(value.personalConnection.state) || typeof value.personalConnection.message !== "string")
    throw new Error("Model settings were not confirmed. Refresh before choosing a connection.");
  return value;
}

/** Choice belongs to the authorized conversation, including each maintainer's own Admin conversation. */
export function HermesTeamModelAccess(props: {
  botId: string; conversationId: string; mode: "member" | "admin"; started: boolean; busy: boolean;
  summary: HermesTeamModelSummary;
  onPrepareConversation: (mode: "member" | "admin") => Promise<string>;
  onNavigate: (conversationId: string) => void;
  onChanged: () => void;
  onBusyChange: (operationId: string, pending: boolean) => void;
  /** No public authentication action is installed until its account-specific method is verified. */
  onConnect?: () => Promise<void>;
}) {
  return <ModelAccess key={`${props.botId}:${props.started ? props.conversationId : "new"}:${props.mode}`} {...props} />;
}

function ModelAccess({ conversationId, mode, started, busy, summary, onPrepareConversation, onNavigate, onChanged, onBusyChange, onConnect }: Parameters<typeof HermesTeamModelAccess>[0]) {
  const [view, setView] = useState<HermesTeamModelView | null>(null), [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [draft, setDraft] = useState<{ snapshot: string; choice: Choice } | null>(null);
  const held = useRef(false), epoch = useRef(0), alive = useRef(true), preparedId = useRef<string | null>(null);
  const busyClaim = useRef<{ id: string; release: () => void } | null>(null);
  const base = (id: string) => `/api/conversations/${encodeURIComponent(id)}/team/model`;
  const snapshot = view ? `${view.definitionVersion}:${view.modelChoice}` : "new";
  const choice = draft?.snapshot === snapshot ? draft.choice : view?.modelChoice ?? "default";
  const policy = view?.modelPolicyMode ?? summary.modelPolicyMode;
  const personalRequired = view?.personalRequired ?? summary.personalRequired ?? policy === "personal_required";
  const personalAllowed = view?.personalAllowed ?? summary.personalAllowed ?? false;
  const canChoose = policy === "admin_default_personal_allowed" && personalAllowed && !personalRequired;

  async function read(id: string, signal?: AbortSignal) {
    const response = await fetch(base(id), { cache: "no-store", signal }), result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error ?? "Your model settings could not be checked."), { status: response.status });
    return confirmedView(result);
  }
  function claimBusy() {
    const id = crypto.randomUUID();
    const claim = { id, release: () => onBusyChange(id, false) };
    busyClaim.current = claim; onBusyChange(id, true);
    return claim;
  }
  function releaseBusy(claim: NonNullable<typeof busyClaim.current>) {
    if (busyClaim.current?.id === claim.id) busyClaim.current = null;
    claim.release();
  }
  useEffect(() => { alive.current = true; return () => {
    alive.current = false;
    busyClaim.current?.release(); busyClaim.current = null;
  }; }, []);
  useEffect(() => {
    if (!summary.modelPolicyMode) return;
    const candidate = started ? conversationId : preparedId.current;
    if (!candidate) return;
    const id = candidate;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const readEpoch = epoch.current;
      try {
        if (!held.current) {
          const next = await read(id, abort.signal);
          if (!abort.signal.aborted && readEpoch === epoch.current) { setView(next); setError(""); setUncertain(false); }
        }
      } catch (err) {
        if (!abort.signal.aborted && readEpoch === epoch.current) { setView(null); setError(err instanceof Error ? err.message : "Your model settings could not be checked."); }
      } finally { if (!abort.signal.aborted) timer = setTimeout(() => void load(), document.hidden ? 30000 : 5000); }
    }
    void load(); return () => { abort.abort(); clearTimeout(timer); };
    // read has no mutable state: the authorized conversation is this effect's scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, started, attempt, summary.modelPolicyMode]);

  async function save(target?: Choice) {
    if (held.current || busy || uncertain || !policy || started && !view) return;
    const desired = target ?? choice;
    held.current = true; epoch.current++; setPending(true); setError(""); setNotice(""); const claim = claimBusy();
    try {
      const id = started ? conversationId : preparedId.current ?? await onPrepareConversation(mode);
      if (!alive.current) return;
      if (!started) preparedId.current = id;
      const current = started ? view! : await read(id);
      if (!alive.current) return;
      if (desired === "personal" && !current.personalAllowed) throw new Error("This bot’s model policy changed. Refresh before choosing a connection.");
      if (desired !== current.modelChoice) {
        const response = await fetch(base(id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelChoice: desired, expectedChoice: current.modelChoice, expectedDefinitionVersion: current.definitionVersion }) });
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error ?? "Your model choice was not confirmed. Refresh before trying again."), { status: response.status });
        if (result.modelChoice !== desired) throw new Error("Your model choice was not confirmed. Refresh before trying again.");
      }
      if (!alive.current) return;
      // A stored choice is not proof of model access. Read its current authorized readiness separately.
      const next = await read(id);
      if (!alive.current) return;
      epoch.current++; setView(next); setNotice("Model choice saved for this chat."); setUncertain(false); onChanged();
      if (!started) onNavigate(id);
    } catch (err) {
      if (alive.current) { epoch.current++; setView(null); setUncertain(true); setError(err instanceof Error ? err.message : "Your model choice was not confirmed. Refresh before trying again."); }
    } finally { held.current = false; releaseBusy(claim); if (alive.current) setPending(false); }
  }
  async function connect() {
    if (held.current || busy || !view?.connectAvailable || !onConnect) return;
    held.current = true; epoch.current++; setPending(true); const claim = claimBusy(); setError("");
    try { await onConnect(); if (alive.current) { setView(null); setAttempt(value => value + 1); } }
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : "Your connection setup was not confirmed."); }
    finally { held.current = false; releaseBusy(claim); if (alive.current) { epoch.current++; setPending(false); } }
  }
  const personal = personalAllowed && (personalRequired || choice === "personal");
  const needsDefault = policy === "admin_provided" && view?.modelChoice === "personal";
  const locked = busy || pending || uncertain || started && !view;
  const source = personalRequired || view?.modelChoice === "personal" ? "Your ChatGPT" : "Admin-provided model";
  if (!policy) return null;
  return <section aria-label="Team Bot model access" className="mx-auto min-w-0 w-full max-w-3xl px-4 py-2 text-sm">
    <div className="min-w-0 space-y-2 wrap-anywhere rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Model access</h3>{(started || error) && <Button size="sm" variant="outline" disabled={pending} onClick={() => {
        setView(null);
        if (!started && !preparedId.current) { setError(""); setUncertain(false); onChanged(); }
        else setAttempt(value => value + 1);
      }}>Refresh model settings</Button>}</div>
      {started && !view && !error && <p role="status" className="text-xs text-muted">Checking this chat’s model access…</p>}
      {policy && (!started || view) && !error && <>
        <p className="text-xs text-muted">{personalRequired ? "Your ChatGPT connection is required for this bot’s replies and learning." : canChoose ? "Use the admin’s model or your own ChatGPT. Your choice applies only to this chat." : "This bot uses the model provided by your admin."}</p>
        {canChoose && <label className="block space-y-1 text-xs"><span>Model for this chat</span><Select aria-label="Model for this chat" value={choice} disabled={locked} onChange={event => setDraft({ snapshot, choice: event.target.value as Choice })}><option value="default">Admin-provided model</option><option value="personal">My ChatGPT</option></Select></label>}
        {view && <p className="text-xs text-muted">Current model: {source}. <span>{view.modelAccessAvailable ? "Model access verified." : view.modelAccessReason}</span></p>}
        {!started && <p className="text-xs text-muted">{summary.modelAccessReason || "Model setup is unavailable until your admin verifies a supported connection."}</p>}
        {personal && <div className="space-y-2 border-t border-border pt-2"><p className="text-xs text-muted">{view?.personalConnection.message || "ChatGPT setup is unavailable until your admin verifies a supported connection."}</p><Button size="sm" disabled={busy || pending || !view?.connectAvailable || !onConnect} onClick={() => void connect()}>Connect ChatGPT</Button>{(!view?.connectAvailable || !onConnect) && <p className="text-xs text-muted">{view?.connectReason || "Your admin needs to verify ChatGPT setup before it is available."}</p>}</div>}
        {needsDefault && <><p className="text-xs text-muted">Your previous personal choice is unavailable under this bot’s current policy.</p><Button size="sm" disabled={locked} onClick={() => void save("default")}>Use admin-provided model</Button></>}
        {(!started || canChoose) && <Button size="sm" disabled={locked || started && choice === view?.modelChoice} onClick={() => void save()}>{pending ? "Saving model choice…" : started ? "Save model choice" : mode === "admin" ? "Open Admin chat" : "Open private chat"}</Button>}
      </>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}{notice && <p role="status" className="text-xs text-muted">{notice}</p>}
    </div>
  </section>;
}
