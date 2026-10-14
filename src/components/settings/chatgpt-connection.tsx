"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersonalCodexConnection } from "@/components/settings/personal-codex-connection";

type Backend = { state: string; reason?: string };
type Setup = { instructions?: string; hostId: string; userId: string };
export type ChatGPTAccountView = {
  allowed: boolean;
  reason: string | null;
  credential: { email: string | null; planType: string | null; status: string; migrationRequired: boolean } | null;
  backends: { native: Backend; codex: Backend };
  onboarding: { state: "ready" | "blocked"; reason: string | null };
};

function messageFor(view: ChatGPTAccountView) {
  if (view.credential?.migrationRequired) return "Your saved ChatGPT sign-in needs to be moved to the unified account service before it can be used.";
  if (view.credential) return view.credential.status === "active" ? "Your ChatGPT account is connected." : "Your ChatGPT sign-in needs attention. Reconnect to continue.";
  if (!view.allowed) return view.reason || "ChatGPT account connections are disabled for your account.";
  if (view.onboarding.state === "blocked") return view.onboarding.reason || "Account sign-in is not available yet.";
  return "Connect once to use your ChatGPT account across supported backends.";
}

/** One browser-safe ChatGPT account entry shared by native and stock Codex. */
export function ChatGPTConnection() {
  const [view, setView] = useState<ChatGPTAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);

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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "ChatGPT sign-in could not be started.");
      if (typeof data.hostId !== "string" || typeof data.userId !== "string") throw new Error("The setup service did not return the required account identifiers. Retry or contact your administrator.");
      setSetup({ instructions: data.instructions, hostId: data.hostId, userId: data.userId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ChatGPT sign-in could not be started.");
      void refresh(true);
    } finally { setBusy(false); }
  }

  async function enableStockCodex() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync-token" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "Could not enable stock Codex.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not enable stock Codex."); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect your ChatGPT account?")) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "disconnect" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "Could not disconnect ChatGPT.");
      if (data.revocationConfirmed === false) setError("The account was disconnected here, but OpenAI did not confirm revocation. Review active ChatGPT sessions in your OpenAI account.");
      await refresh(data.revocationConfirmed === false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect ChatGPT.");
    } finally { setBusy(false); }
  }

  const canStart = view?.allowed;
  return <section id="chatgpt-account" aria-labelledby="chatgpt-account-title" className="space-y-4 rounded-2xl border border-border p-5">
    <div>
      <h2 id="chatgpt-account-title" className="font-semibold">ChatGPT account</h2>
      <p className="mt-1 text-sm text-muted">Manage one ChatGPT sign-in for Native CollectiveUI and stock Codex.</p>
    </div>
    <p role="status" className="text-sm">{loading ? "Checking your ChatGPT account…" : view ? messageFor(view) : "Your ChatGPT account status could not be loaded."}</p>
    {view && !view.allowed && view.reason && <p className="text-sm text-muted">{view.reason}</p>}
    {view?.credential && <p className="text-sm">{view.credential.email || "ChatGPT account"}{view.credential.planType ? ` · ${view.credential.planType}` : ""}{view.credential.status ? ` · ${view.credential.status}` : ""}</p>}
    {view && <div className="grid gap-2 text-xs text-muted sm:grid-cols-2">
      {(["native", "codex"] as const).map((name) => <p key={name} className="rounded-lg bg-surface-2 p-3"><span className="font-medium text-foreground">{name === "native" ? "Native CollectiveUI harness" : "Stock Codex"}:</span> {view.backends[name].state}{view.backends[name].reason ? ` · ${view.backends[name].reason}` : ""}</p>)}
    </div>}
    {view?.onboarding.state === "blocked" && view.onboarding.reason && <p className="text-sm text-muted">{view.onboarding.reason}</p>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {canStart && <Button disabled={busy || loading} onClick={() => void start()}>{view?.credential ? "Continue ChatGPT setup" : "Set up ChatGPT"}</Button>}
      {view?.allowed && ["not_connected", "stopped"].includes(view.backends.codex.state) && view.credential && <Button variant="outline" disabled={busy || loading} onClick={() => void enableStockCodex()}>Enable stock Codex</Button>}
      {view?.credential && <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>Disconnect ChatGPT</Button>}
      {(error || !view) && <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Retry</Button>}
      {view && !error && <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Refresh status</Button>}
    </div>
    {setup && <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <p className="font-medium">Finish ChatGPT setup</p>
      {setup.instructions && <p className="text-muted">{setup.instructions}</p>}
      <p>On the computer where you use ChatGPT, run:</p>
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs"><code>npm run chatgpt:sign-in -- --output ./chatgpt-profile.json</code></pre>
      <p className="text-xs text-muted">For reconnect, run <code>npm run chatgpt:sign-in -- --existing ./chatgpt-profile.json --output ./chatgpt-profile.json</code>. Transfer only your selected profile over your own secure SSH connection, preserving file permissions 0600. Keep the server&apos;s host ID unchanged. Never upload the profile in this browser.</p>
      <p>On the CollectiveUI server, import the profile:</p>
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs"><code>{`npm run chatgpt:import -- --user-id ${setup.userId} --file /protected/path/chatgpt-profile.json`}</code></pre>
      <Button variant="outline" disabled={busy} onClick={() => { setSetup(null); void refresh(); }}>I finished setup · Refresh status</Button>
    </div>}
    <PersonalCodexConnection />
  </section>;
}
