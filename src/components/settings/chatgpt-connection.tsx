"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersonalCodexConnection } from "@/components/settings/personal-codex-connection";
import type { AccountSetupView } from "@/personal-codex/contracts";

type Backend = { state: string; reason?: string };
export type ChatGPTAccountView = {
  allowed: boolean;
  reason: string | null;
  credential: { email: string | null; planType: string | null; status: string; migrationRequired: boolean } | null;
  backends: { native: Backend; codex: Backend };
  onboarding: { state: "ready" | "blocked"; reason: string | null };
  setup?: AccountSetupView;
};

function messageFor(view: ChatGPTAccountView) {
  if (!view.allowed) return view.reason || "ChatGPT account connections are disabled for your account.";
  if (view.credential?.migrationRequired) return "Your saved ChatGPT sign-in needs to be moved to the unified account service before it can be used.";
  if (view.credential) return view.backends.native.state === "connected" ? "Your ChatGPT account is connected." : view.backends.native.reason || "Your ChatGPT sign-in needs attention. Check its status before continuing.";
  return view.setup?.reason || "Connect once to use your ChatGPT account across supported backends.";
}

export function runtimeSetupLabel(setup?: AccountSetupView) {
  if (!setup) return "Could not check setup";
  const runtime = setup.runtime;
  if (runtime.state === "ready") return runtime.enrolled && runtime.runtimeState === "running" ? "Prepared" : "Ready to prepare";
  if (runtime.state === "operator_setup_required") return "Installation setup needed";
  if (runtime.state === "verification_required") return "Sandbox verification needed";
  if (runtime.state === "not_installed") return "Not installed";
  return "Could not verify setup";
}

/** One browser-safe account entry; resource consent and OpenAI sign-in are separate. */
export function ChatGPTConnection({ initialView }: { initialView?: ChatGPTAccountView } = {}) {
  const [view, setView] = useState<ChatGPTAccountView | null>(initialView ?? null);
  const [loading, setLoading] = useState(!initialView);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (keepError = false) => {
    setLoading(true);
    if (!keepError) setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Could not load your ChatGPT account (${response.status}).`);
      setView(data as ChatGPTAccountView);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the ChatGPT account service.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function mutate(body: { action: "prepare-runtime"; accepted: true; consentVersion: 1 } | { action: "disconnect" | "sync-token" }) {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "The ChatGPT account action could not be completed.");
      const revocationUnconfirmed = data.revocationConfirmed === false;
      if (revocationUnconfirmed) setError("The account was disconnected here, but OpenAI did not confirm revocation. Review active ChatGPT sessions in your OpenAI account.");
      if (body.action === "prepare-runtime") setConsent(false);
      await refresh(revocationUnconfirmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The ChatGPT account action could not be completed.");
      void refresh(true);
    } finally { setBusy(false); }
  }

  const setup = view?.setup;
  const prepared = setup?.runtime.state === "ready" && setup.runtime.enrolled && setup.runtime.runtimeState === "running";
  const canPrepare = setup?.canPrepareRuntime && !prepared;
  const signedIn = view?.backends.native.state === "connected" && !view.credential?.migrationRequired;
  return <section id="chatgpt-account" aria-labelledby="chatgpt-account-title" className="space-y-4 rounded-2xl border border-border p-5">
    <div>
      <h2 id="chatgpt-account-title" className="font-semibold">ChatGPT account</h2>
      <p className="mt-1 text-sm text-muted">Manage one ChatGPT sign-in for Native CollectiveUI and stock Codex.</p>
    </div>
    <p role="status" className="text-sm">{loading ? "Checking your ChatGPT account…" : view ? messageFor(view) : "Your ChatGPT account status could not be loaded."}</p>
    {view?.credential && <p className="text-sm">{view.credential.email || "ChatGPT account"}{view.credential.planType ? ` · ${view.credential.planType}` : ""}</p>}
    {view && <div className="grid gap-2 text-xs text-muted sm:grid-cols-2">
      {(["native", "codex"] as const).map((name) => <p key={name} className="rounded-lg bg-surface-2 p-3"><span className="font-medium text-foreground">{name === "native" ? "Native CollectiveUI" : "Stock Codex"}:</span> {view.backends[name].state}</p>)}
    </div>}
    {view?.allowed && <div aria-label="ChatGPT setup status" className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <dl className="grid gap-2 sm:grid-cols-3">
        <div><dt className="text-muted">Account eligibility</dt><dd>{setup?.eligible ? "Ready" : "Attention required"}</dd></div>
        <div><dt className="text-muted">Private Codex runtime</dt><dd>{runtimeSetupLabel(setup)}</dd></div>
        <div><dt className="text-muted">ChatGPT sign-in</dt><dd>{signedIn ? "Connected" : "Local sign-in app required"}</dd></div>
      </dl>
      {setup?.reason && view.credential && <p className="text-muted">{setup.reason}</p>}
      {setup?.runtime.reason && <p className="text-muted">{setup.runtime.reason}</p>}
      {!signedIn && <p id="chatgpt-companion-status" className="text-muted">{setup?.authentication.reason || "A supported local sign-in app is required to connect ChatGPT. It is not available in this installation yet."}</p>}
      {canPrepare && <div className="space-y-3">
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={consent} disabled={busy || loading} onChange={event => setConsent(event.target.checked)} className="mt-1" />
          <span>I authorize this installation to prepare my private Codex runtime. ChatGPT plan usage is authorized separately when I sign in.</span>
        </label>
        <Button disabled={!consent || busy || loading} onClick={() => void mutate({ action: "prepare-runtime", accepted: true, consentVersion: 1 })}>Prepare private runtime</Button>
      </div>}
      {!signedIn && <Button disabled aria-describedby="chatgpt-companion-status">{view.credential ? "Reconnect ChatGPT" : "Connect ChatGPT"}</Button>}
    </div>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {view?.allowed && ["not_connected", "stopped"].includes(view.backends.codex.state) && view.credential && !view.credential.migrationRequired && <Button variant="outline" disabled={busy || loading} onClick={() => void mutate({ action: "sync-token" })}>Enable stock Codex</Button>}
      {view?.credential && <Button variant="outline" disabled={busy || loading} onClick={() => { if (window.confirm("Disconnect your ChatGPT account?")) void mutate({ action: "disconnect" }); }}>Disconnect ChatGPT</Button>}
      {(error || !view) && <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Retry</Button>}
      {view && !error && <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Refresh status</Button>}
    </div>
    <PersonalCodexConnection />
  </section>;
}
