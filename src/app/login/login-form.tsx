"use client";

import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@collective/webauthn-browser";
import { securityPost, type SecurityResult } from "@/lib/auth/security-client";
import { useActionState, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { signIn as completeSignIn } from "next-auth/react";
import { entraLogin, ldapLogin } from "./actions";
import { useReportLoginMood } from "./login-mood";

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function LoginForm({
  callbackUrl,
  entra,
  ldap,
  local = false,
  error,
}: {
  callbackUrl: string;
  entra: boolean;
  ldap: boolean;
  local?: boolean;
  error?: string;
}) {
  const [ldapError, action, pending] = useActionState(ldapLogin, null);
  const [showLdap, setShowLdap] = useState(!entra);
  useReportLoginMood(pending ? "working" : (ldapError ?? error) ? "attention" : "idle");

  if (!entra && !ldap && !local) {
    return (
      <div className="rounded-xl border border-border p-4 text-sm text-muted">
        Sign-in is not available yet. Please contact your administrator.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(error || ldapError) && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {ldapError ?? error}
        </div>
      )}
      {local && <LocalLogin callbackUrl={callbackUrl} />}
      {entra && (
        <form action={entraLogin}>
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <Button type="submit" variant="outline" className="login-sso h-12 w-full text-base">
            <MicrosoftLogo /> Continue with Microsoft
          </Button>
        </form>
      )}
      {entra && ldap && (
        <button
          type="button"
          aria-expanded={showLdap}
          aria-controls="company-login"
          onClick={() => setShowLdap((s) => !s)}
          className="mx-auto flex min-h-11 items-center gap-1 text-sm text-muted hover:text-fg"
        >
          Sign in with company username <ChevronDown className={`h-4 w-4 transition ${showLdap ? "rotate-180" : ""}`} />
        </button>
      )}
      {ldap && (
        <form id="company-login" hidden={!showLdap} action={action} className="space-y-4" aria-busy={pending}>
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <div><Label htmlFor="username">Company username</Label><Input id="username" name="username" placeholder="you@company.com" autoComplete="username" autoCapitalize="none" spellCheck={false} required className="h-12 rounded-xl px-4" /></div>
          <div><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" placeholder="Enter your password" autoComplete="current-password" required className="h-12 rounded-xl px-4" /></div>
          <Button type="submit" className="login-primary h-12 w-full text-base" disabled={pending}>
            {pending && <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />} {pending ? "Signing in…" : "Continue"}
          </Button>
        </form>
      )}
    </div>
  );
}

function LocalLogin({ callbackUrl }: { callbackUrl: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [flow, setFlow] = useState("");
  const [replenished, setReplenished] = useState<SecurityResult>();
  const [savedCodes, setSavedCodes] = useState(false);
  const [recovery, setRecovery] = useState(false);
  useReportLoginMood(pending ? "working" : error ? "attention" : "idle");
  const endpoint = "/api/auth/local-security";
  async function complete(ticket: string, mustChangePassword = false) {
    const result = await completeSignIn("local", { ticket, redirect: false, redirectTo: "/" });
    if (!result?.ok || result.error) throw new Error("Unable to sign in");
    // A full navigation also clears any cached UI from the previous identity/session.
    // The target is navigation only; the proxy/session layer independently enforces password changes.
    window.location.assign(mustChangePassword ? "/account/password" : callbackUrl);
  }
  async function password(form: FormData) {
    setPending(true); setError("");
    try {
      const result = await securityPost(endpoint, flow ? { action: "password-finish", flow, code: form.get("code"), recovery } :
        { action: "password-begin", username: form.get("username"), password: form.get("password") });
      if (result.codes) { setReplenished(result); setFlow(""); }
      else if (result.ticket) await complete(result.ticket, result.mustChangePassword);
      else setFlow(result.flow!);
    } catch { setError("Unable to sign in. Check your credentials or try again later."); setFlow(""); }
    finally { setPending(false); }
  }
  async function passkey() {
    setPending(true); setError(""); setFlow("");
    try {
      const options = await securityPost(endpoint, { action: "passkey-begin" });
      const response = await startAuthentication({ optionsJSON: options.options as PublicKeyCredentialRequestOptionsJSON });
      const result = await securityPost(endpoint, { action: "passkey-finish", flow: options.flow, response });
      await complete(result.ticket!, result.mustChangePassword);
    } catch { setError("Passkey sign-in was not completed. Try again, use another passkey, or use your password and a recovery code."); }
    finally { setPending(false); }
  }
  if (replenished?.codes) return <section className="space-y-4" aria-live="polite">
    <h3 className="text-xl font-semibold">Save your new recovery codes</h3>
    <p>Your final recovery code was used. A fresh set is shown once below, and previous sessions were revoked. Save it to replace a lost authenticator after signing in.</p>
    <ul aria-label="New recovery codes" className="space-y-2 rounded-lg border border-border p-3 font-mono text-xs">{replenished.codes.map(c => <li className="break-all" key={c}>{c}</li>)}</ul>
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={savedCodes} onChange={e => setSavedCodes(e.target.checked)} />I saved these new recovery codes securely</label>
    {error && <p role="alert">{error}</p>}
    <Button disabled={!savedCodes || pending} onClick={async () => {
      setPending(true);
      try { await complete(replenished.ticket!, replenished.mustChangePassword); }
      catch { setError("The sign-in ticket expired. Start again with your password and one of the new codes you saved."); }
      finally { setPending(false); }
    }}>Continue to account</Button>
    <button type="button" className="min-h-11 underline" disabled={!savedCodes || pending} onClick={() => { setReplenished(undefined); setError(""); }}>Start sign-in again</button>
  </section>;
  return <div className="space-y-4">
    <form action={password} className="space-y-4" aria-label="Local account" aria-busy={pending}>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {flow ? <>
        <p role="status">Password verified. Enter an authenticator app code or a saved recovery code to finish signing in.</p>
        <div><Label htmlFor="factor-code">{recovery ? "Recovery code" : "Authenticator code"}</Label><Input id="factor-code" name="code" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} autoFocus maxLength={recovery ? 44 : 6} required /></div>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={recovery} onChange={e => setRecovery(e.target.checked)} />Use a recovery code</label>
        <Button type="submit" disabled={pending} className="w-full">Verify and sign in</Button>
        <button type="button" className="min-h-11 text-sm underline" disabled={pending} onClick={() => setFlow("")}>Start again</button>
      </> : <>
        <div><Label htmlFor="local-username">Local username or email</Label><Input id="local-username" name="username" autoComplete="username webauthn" autoCapitalize="none" spellCheck={false} maxLength={254} required className="h-12 rounded-xl px-4" /></div>
        <div><Label htmlFor="local-password">Local password</Label><Input id="local-password" name="password" type="password" autoComplete="current-password" maxLength={256} required className="h-12 rounded-xl px-4" /></div>
        <Button type="submit" disabled={pending} className="login-primary h-12 w-full text-base">{pending ? "Signing in…" : "Sign in with local account"}</Button>
      </>}
      <p className="text-xs text-muted">Lost a device? Use another passkey, or your password and a recovery code. For a lost password, contact your administrator. Password resets keep your security factors.</p>
    </form>
    <Button type="button" variant="outline" disabled={pending} onClick={passkey} className="h-12 w-full">Sign in with a passkey</Button>
  </div>;
}
