"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersonalCodexConnection } from "@/components/settings/personal-codex-connection";
import type { AccountSetupView, CompanionSignInView } from "@/personal-codex/contracts";

type Backend = { state: string; reason?: string };
type SignInView = CompanionSignInView;
type BrowserSetupView = AccountSetupView;
export type ChatGPTAccountView = {
  allowed: boolean;
  reason: string | null;
  credential: { email: string | null; planType: string | null; status: string; migrationRequired: boolean } | null;
  backends: { native: Backend; codex: Backend };
  onboarding: { state: "ready" | "blocked"; reason: string | null };
  setup?: BrowserSetupView;
  signIn?: SignInView | null;
  deviceSetup?: { eligible: boolean; reason: string | null; runtime: AccountSetupView["runtime"]; canPrepareRuntime: boolean };
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
  const [signInConsent, setSignInConsent] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const launchUrlRef = useRef<string | null>(null);
  const [canReopenCompanion, setCanReopenCompanion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (keepError = false) => {
    setLoading(true);
    if (!keepError) setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || `Could not load your ChatGPT account (${response.status}).`);
      const nextView = data as ChatGPTAccountView;
      if (nextView.signIn && nextView.signIn.state !== "created") {
        launchUrlRef.current = null;
        setCanReopenCompanion(false);
      }
      setView(nextView);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the ChatGPT account service.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function mutate(body: { action: "disconnect-native" }) {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "The ChatGPT account action could not be completed.");
      const revocationUnconfirmed = data.revocationConfirmed === false;
      if (revocationUnconfirmed) setError("The account was disconnected here, but OpenAI did not confirm revocation. Review active ChatGPT sessions in your OpenAI account.");
      await refresh(revocationUnconfirmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The ChatGPT account action could not be completed.");
      void refresh(true);
    } finally { setBusy(false); }
  }

  async function beginSignIn() {
    // Open synchronously in the user's click handler so the eventual local-app
    // navigation still has browser user activation after the authenticated POST.
    const launchWindow = window.open("about:blank", "_blank");
    if (!launchWindow) {
      setError("Your browser blocked the local sign-in window. Allow pop-ups for this site and retry.");
      return;
    }
    launchWindow.opener = null;
    setSignInBusy(true); setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "begin-sign-in", accepted: true, consentVersion: 1, enableCodex: false }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "The local sign-in app could not be opened.");
      const launchUrl = new URL(data.launchUrl);
      const launchOrigin = launchUrl.searchParams.get("origin");
      const attempt = launchUrl.searchParams.get("attempt");
      const ticket = launchUrl.searchParams.get("ticket");
      if (launchUrl.protocol !== "collectiveui-chatgpt:" || launchUrl.hostname !== "connect" ||
          launchUrl.pathname !== "" || launchUrl.username || launchUrl.password || launchUrl.port || launchUrl.hash ||
          launchUrl.searchParams.size !== 3 || launchOrigin !== window.location.origin ||
          !launchOrigin?.startsWith("https://") ||
          !attempt || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt) || !ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
        throw new Error("The sign-in service returned an invalid local-app launch link. Retry or contact your administrator.");
      }
      // Keep the capability only in this click handler. Never render, persist, or log it.
      launchUrlRef.current = launchUrl.href;
      setCanReopenCompanion(true);
      launchWindow.location.href = launchUrl.href;
      setView(current => current ? { ...current, signIn: { state: "created", expiresAt: data.expiresAt } } : current);
      setSignInConsent(false);
    } catch (cause) {
      launchWindow.close();
      setError(cause instanceof Error ? cause.message : "The local sign-in app could not be opened.");
    } finally { setSignInBusy(false); }
  }

  async function cancelSignIn() {
    setSignInBusy(true); setError(null);
    try {
      const response = await fetch("/api/me/chatgpt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel-sign-in" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.message || "The sign-in attempt could not be cancelled.");
      launchUrlRef.current = null; setCanReopenCompanion(false);
      setSignInConsent(false);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The sign-in attempt could not be cancelled."); }
    finally { setSignInBusy(false); }
  }

  function reopenCompanion() {
    const launchUrl = launchUrlRef.current;
    if (!launchUrl) return;
    const opened = window.open(launchUrl, "_blank");
    if (!opened) setError("Your browser blocked the local sign-in app. Allow pop-ups for this site and retry.");
    else opened.opener = null;
  }

  const setup = view?.setup;
  const signedIn = view?.backends.native.state === "connected" && !view.credential?.migrationRequired;
  const companionReady = setup?.authentication.state === "companion_ready";
  const waitingSignIn = !!view?.signIn && ["created", "paired", "receiving"].includes(view.signIn.state);
  useEffect(() => {
    if (!waitingSignIn) return;
    const timer = setInterval(() => { void refresh(true); }, 1500);
    return () => clearInterval(timer);
  }, [waitingSignIn, refresh]);
  return <section id="chatgpt-account" aria-labelledby="chatgpt-account-title" className="space-y-4 rounded-2xl border border-border p-5">
    <div>
      <h2 id="chatgpt-account-title" className="font-semibold">ChatGPT account</h2>
      <p className="mt-1 text-sm text-muted">Connect your ChatGPT account to stock Codex or Native CollectiveUI. Each connection has its own sign-in and status.</p>
    </div>
    <PersonalCodexConnection setup={view?.deviceSetup} />
    <h3 className="font-medium">Native CollectiveUI</h3>
    <p role="status" className="text-sm">{loading ? "Checking your ChatGPT account…" : view ? messageFor(view) : "Your ChatGPT account status could not be loaded."}</p>
    {view?.credential && <p className="text-sm">{view.credential.email || "ChatGPT account"}{view.credential.planType ? ` · ${view.credential.planType}` : ""}</p>}
    {view?.allowed && <div aria-label="ChatGPT setup status" className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <dl className="grid gap-2 sm:grid-cols-2">
        <div><dt className="text-muted">Account eligibility</dt><dd>{setup?.eligible ? "Ready" : "Attention required"}</dd></div>
        <div><dt className="text-muted">ChatGPT sign-in</dt><dd>{signedIn ? "Connected" : view.signIn?.state === "complete" ? "Sign-in completed" : view.signIn?.state === "needs_attention" ? "Needs attention" : view.signIn?.state === "expired" ? "Link expired" : view.signIn?.state === "cancelled" ? "Cancelled" : companionReady ? "Local sign-in app ready" : "Local sign-in app required"}</dd></div>
      </dl>
      {setup?.reason && view.credential && <p className="text-muted">{setup.reason}</p>}
      {!signedIn && <p id="chatgpt-companion-status" className="text-muted">{view?.signIn?.reason || setup?.authentication.reason || "A supported local sign-in app is required to connect ChatGPT."}</p>}
      {!signedIn && companionReady && !waitingSignIn && <div className="space-y-3">
        <label className="flex items-start gap-2"><input type="checkbox" checked={signInConsent} disabled={signInBusy || busy || loading} onChange={event => setSignInConsent(event.target.checked)} className="mt-1" /><span>I authorize this installation to use my ChatGPT account for Native CollectiveUI.</span></label>
        <Button disabled={!signInConsent || signInBusy || busy || loading} aria-describedby="chatgpt-companion-status" onClick={() => void beginSignIn()}>{view.signIn && ["expired", "cancelled", "needs_attention"].includes(view.signIn.state) ? "Retry local sign-in" : view.credential ? "Reconnect ChatGPT" : "Connect ChatGPT"}</Button>
      </div>}
      {!signedIn && !companionReady && <Button disabled aria-describedby="chatgpt-companion-status">{view.credential ? "Reconnect ChatGPT" : "Connect ChatGPT"}</Button>}
      {!signedIn && !companionReady && setup?.authentication.downloadUrl && <a className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm" href={setup.authentication.downloadUrl}>Get the local sign-in app</a>}
      {waitingSignIn && <div className="flex flex-wrap items-center gap-2"><p role="status" className="text-sm">{view?.signIn?.state === "receiving" ? "The local app is returning your sign-in. This may take a moment." : "Waiting for the local sign-in app to finish…"}</p>{view?.signIn?.state === "created" && canReopenCompanion && <Button variant="outline" onClick={reopenCompanion}>Open local sign-in app</Button>}<Button variant="outline" disabled={signInBusy} onClick={() => void cancelSignIn()}>Cancel sign-in</Button></div>}
    </div>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {view?.credential && <Button variant="outline" disabled={busy || loading} onClick={() => { if (window.confirm("Disconnect your Native CollectiveUI ChatGPT account?")) void mutate({ action: "disconnect-native" }); }}>Disconnect Native ChatGPT</Button>}
      {(error || !view) && <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Retry</Button>}
      {view && !error && <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Refresh status</Button>}
    </div>
  </section>;
}
