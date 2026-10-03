"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@collective/webauthn-browser";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { securityPost, type SecurityResult } from "@/lib/auth/security-client";
import type { securitySummary, SecurityOperation } from "@/lib/auth/security";

type Summary = Awaited<ReturnType<typeof securitySummary>>;
const labels: Record<SecurityOperation, string> = { "add-passkey": "Add passkey", "add-totp": "Set up authenticator app", "remove-passkey": "Remove passkey", "remove-totp": "Remove authenticator app", recovery: "Regenerate recovery codes", disable: "Disable extra protection", password: "Change password" };
export function SecurityForm({ initial, passwordOnly = false }: { initial: Summary; passwordOnly?: boolean }) {
  const [op, setOp] = useState<SecurityOperation | "">(passwordOnly ? "password" : ""); const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const [result, setResult] = useState<SecurityResult>(); const [totp, setTotp] = useState<SecurityResult>(); const [qr, setQr] = useState("");
  const [recovery, setRecovery] = useState(!initial.totp && initial.passkeys.length > 0); const [password, setPassword] = useState(""); const [code, setCode] = useState("");
  const [value, setValue] = useState(""); const [confirm, setConfirm] = useState(""); const [ack, setAck] = useState(false);
  const [passkeyProof, setPasskeyProof] = useState("");
  const [passkeyStatus, setPasskeyStatus] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const protectedAccount = initial.totp || initial.passkeys.length > 0;
  const post = (body: Record<string, unknown>) => securityPost("/api/account/security", body);
  useEffect(() => { if (passkeyProof) stepRef.current?.focus(); }, [passkeyProof]);
  useEffect(() => { if (result?.signOut) resultRef.current?.focus(); }, [result]);
  function clearSetup() {
    setError(""); setTotp(undefined); setQr(""); setPassword(""); setCode("");
    setValue(""); setConfirm(""); setPasskeyProof(""); setPasskeyStatus("");
    setRecovery(!initial.totp && initial.passkeys.length > 0);
  }
  function select(next: SecurityOperation, id = "") {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearSetup(); setOp(next); setTarget(id);
  }
  function close() { if (!pending && !passwordOnly) { clearSetup(); setOp(""); setTarget(""); } }
  async function perform(passkey: boolean) {
    if (!op) return;
    setPending(true); setError("");
    try {
      if (op === "password" && value !== confirm) throw new Error("New passwords do not match.");
      let proof: string;
      if (passkey) {
        const start = await post({ action: "reauth-passkey-begin", op });
        const response = await startAuthentication({ optionsJSON: start.options as PublicKeyCredentialRequestOptionsJSON });
        proof = (await post({ action: "reauth-passkey-finish", flow: start.flow, response })).proof!;
      } else {
        const verified = await post({ action: "reauth-password", op, password, code, recovery });
        if (verified.recoveryRotated) { setResult(verified); setPassword(""); setCode(""); return; }
        proof = verified.proof!;
      }
      setPassword(""); setCode("");
      if (op === "add-passkey") {
        setPasskeyProof(proof);
      } else if (op === "add-totp") {
        const start = await post({ action: "totp-begin", proof });
        setTotp(start); setQr(await QRCode.toDataURL(start.uri!, { width: 220, margin: 2 }));
      } else setResult(await post({ action: "manage", op, proof, value: op === "remove-passkey" ? target : value }));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to complete. Start again."); }
    finally { setPending(false); }
  }
  async function createPasskey() {
    if (!passkeyProof || !value.trim() || pending) return;
    setPending(true); setError(""); setPasskeyStatus("Opening your browser’s passkey prompt…");
    // Keep the proof in memory only and discard it after every registration attempt.
    const proof = passkeyProof;
    let stage: "begin" | "browser" | "save" = "begin";
    try {
      const start = await post({ action: "register-begin", proof, value: value.trim() });
      stage = "browser";
      setPasskeyStatus("Follow your browser’s prompt to choose a device or security key and confirm it’s you.");
      const response = await startRegistration({ optionsJSON: start.options as PublicKeyCredentialCreationOptionsJSON });
      stage = "save";
      setPasskeyStatus("Saving your passkey…");
      setResult(await post({ action: "register-finish", flow: start.flow, response }));
    } catch {
      setPasskeyProof("");
      setError(stage === "browser"
        ? "Passkey setup wasn’t completed. If you closed the browser prompt or it timed out, verify your identity again to retry. You can choose this device, a phone or a security key."
        : stage === "begin"
          ? "Could not start passkey setup. Your verification may have expired. Verify your identity again to retry."
          : "Could not confirm that your passkey was saved. Close this dialog and refresh your passkey list before trying again.");
    } finally { setPending(false); setPasskeyProof(""); setPasskeyStatus(""); }
  }
  async function activate(form: FormData) {
    setPending(true); setError("");
    try { setResult(await post({ action: "totp-finish", flow: totp?.flow, code: form.get("code") })); setTotp(undefined); setQr(""); }
    catch { setError("Verification failed or expired. Start setup again with a fresh code."); setTotp(undefined); setQr(""); }
    finally { setPending(false); }
  }
  if (result?.signOut) return <section className="space-y-4" aria-live="polite">
    <h2 ref={resultRef} tabIndex={-1} className="text-xl font-semibold outline-none">Security updated</h2>
    <p>All sessions have been revoked. Sign in again using your current security methods.</p>
    {result.recoveryRotated && <p>Your final recovery code was used, so a new set was created. Save it and sign in again before retrying your requested security change.</p>}
    {result.codes && <>
      <h3 className="font-semibold">Save your recovery codes now</h3>
      <p>These codes are shown once. Store them privately, away from your devices. Each code works once alongside your password. Previous codes have been replaced.</p>
      <ul aria-label="Recovery codes" className="space-y-2 rounded-lg border border-border p-4 font-mono text-xs">{result.codes.map(c => <li key={c} className="break-all">{c}</li>)}</ul>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />I saved these recovery codes securely</label>
    </>}
    {(!result.codes || ack) && <Link className="inline-flex min-h-11 items-center underline" href="/login">Sign in again</Link>}
  </section>;
  const editor = op && <div className="space-y-5" aria-busy={pending}>
    {op === "add-passkey" && <ol aria-label="Passkey setup progress" className="grid grid-cols-2 gap-2 text-sm">
      <li aria-current={!passkeyProof ? "step" : undefined} className={`rounded-lg border p-3 ${!passkeyProof ? "border-fg bg-surface-2 font-medium" : "border-border text-muted"}`}>1. Confirm identity</li>
      <li aria-current={passkeyProof ? "step" : undefined} className={`rounded-lg border p-3 ${passkeyProof ? "border-fg bg-surface-2 font-medium" : "border-border text-muted"}`}>2. Create passkey</li>
    </ol>}
    {error && <p role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
    {op === "add-passkey" && passkeyProof ? <form key="create-passkey" onSubmit={e => { e.preventDefault(); void createPasskey(); }} className="space-y-4">
      <h3 ref={stepRef} tabIndex={-1} className="font-semibold outline-none">Choose where to save your passkey</h3>
      <p className="text-sm">Click <strong>Create passkey</strong> to open your browser’s prompt. Choose this device, a nearby phone or a security key, then follow its instructions.</p>
      <p className="text-sm text-muted">Your device may ask for your fingerprint, face or device PIN. Enter that only in the browser or device prompt.</p>
      <div>
        <Label htmlFor="passkey-name">Passkey name</Label>
        <Input id="passkey-name" value={value} onChange={e => setValue(e.target.value)} placeholder="My iPhone or backup key" maxLength={80} required disabled={pending} aria-describedby="passkey-name-hint" />
        <p id="passkey-name-hint" className="mt-2 text-sm text-muted">A label to help you recognize this passkey later.</p>
      </div>
      <p className="text-sm text-muted">Finish within five minutes of verification. After setup, save any recovery codes shown and sign in again.</p>
      <p role="status" className="text-sm font-medium">{passkeyStatus}</p>
      <Button className="min-h-11 w-full" disabled={pending || !value.trim()} type="submit">{pending ? "Creating passkey…" : "Create passkey"}</Button>
    </form> : totp ? <form action={activate} className="space-y-4">
      <p>Scan this QR code in your authenticator app, or enter the setup key manually. Setup expires in five minutes. Protection starts only after verification.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt="Authenticator setup QR code; manual setup key follows" width={220} height={220} />
      <Label htmlFor="totp-secret">Manual setup key</Label><Input id="totp-secret" readOnly value={totp.secret} className="font-mono" />
      <Label htmlFor="totp-activation">New authenticator code</Label><Input id="totp-activation" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
      <Button disabled={pending} type="submit">Verify and activate</Button>
    </form> : <form key="verify-identity" onSubmit={e => { e.preventDefault(); void perform(false); }} className="space-y-4">
      {op === "add-passkey" ? <>
        <h3 className="font-semibold">First, confirm it’s you</h3>
        <p className="text-sm">{initial.passkeys.length > 0
          ? "Use an existing passkey, or enter your CollectiveUI password and a verification code below. Then you’ll choose where to save your new passkey."
          : initial.totp
            ? "Enter your CollectiveUI password and a code from your authenticator app. Then you’ll choose where to save your passkey."
            : "Enter the password you use to sign in to CollectiveUI. Then you’ll choose where to save your passkey."}</p>
        {initial.passkeys.length > 0 && <>
          <Button className="min-h-11 w-full" variant="outline" disabled={pending} onClick={() => void perform(true)}>Use an existing passkey</Button>
          <p className="text-center text-sm text-muted">Or use your password and {initial.totp ? "authenticator or recovery code" : "a saved recovery code"}</p>
        </>}
      </> : <p>Verify your identity again for this change. Verification expires in five minutes. Completed changes sign out every session.</p>}
      {(op === "disable" || op === "remove-passkey") && <p className="text-sm">Verify your current password and a code before removing a sign-in method. If you forgot your password, use a passkey to change it first.</p>}
      {op === "disable" && <p role="note" className="font-semibold">This removes all passkeys, your authenticator app and recovery codes, returning this account to password-only sign-in.</p>}
      {op === "password" && <><div><Label htmlFor="new-security-password">New password</Label><Input id="new-security-password" type="password" autoComplete="new-password" value={value} onChange={e => setValue(e.target.value)} minLength={15} maxLength={256} required /></div><div><Label htmlFor="confirm-security-password">Confirm new password</Label><Input id="confirm-security-password" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></div></>}
      <div><Label htmlFor="reauth-password">Current password</Label><Input id="reauth-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} maxLength={256} required disabled={pending} /></div>
      {protectedAccount && <>
        <div><Label htmlFor="reauth-code">{recovery ? "Recovery code" : "Authenticator code"}</Label><Input id="reauth-code" value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} maxLength={44} required disabled={pending} /></div>
        {initial.totp ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={recovery} disabled={pending} onChange={e => { setRecovery(e.target.checked); setCode(""); }} />Use a recovery code</label> : <p className="text-sm text-muted">Enter one of the recovery codes you saved when you first set up account protection.</p>}
      </>}
      <div className="flex flex-wrap gap-2">
        <Button className={op === "add-passkey" ? "min-h-11 w-full" : "min-h-11"} disabled={pending} type="submit">{pending ? "Verifying…" : op === "add-passkey" ? "Continue to passkey setup" : "Verify and continue"}</Button>
        {initial.passkeys.length > 0 && op !== "add-passkey" && op !== "disable" && op !== "remove-passkey" && <Button variant="outline" type="button" disabled={pending || (op === "password" && !value)} onClick={() => void perform(true)}>Verify with a passkey</Button>}
      </div>
    </form>}
    {!passwordOnly && <Button className="min-h-11" variant="ghost" disabled={pending} onClick={close}>Cancel</Button>}
  </div>;
  return <div className="space-y-6" aria-busy={pending}>
    <p>Passkeys let you sign in with your device PIN or biometric verification. They may sync between devices. An authenticator app adds a code after your password.</p>
    <p className="rounded-lg border border-border p-4">{protectedAccount ? "Extra protection is active. Password-only sign-in is blocked." : "Your account currently uses a password. Adding a passkey or authenticator app will block password-only sign-in and provide recovery codes."}</p>
    {!passwordOnly && <><section className="space-y-3"><h2 className="text-xl font-semibold">Passkeys</h2>
      {initial.passkeys.length ? <ul className="space-y-3">{initial.passkeys.map(k => <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
        <div><p className="font-medium">{k.name}</p><p className="text-xs text-muted">{k.deviceType === "multiDevice" ? "Sync-capable passkey" : "Device passkey"} · {k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : "Not used yet"}</p></div>
        <Button variant="outline" disabled={pending || (!initial.totp && initial.passkeys.length === 1)} onClick={() => select("remove-passkey", k.id)}>Remove {k.name}</Button>
      </li>)}</ul> : <p>No passkeys enrolled.</p>}
      <Button disabled={pending || initial.passkeys.length >= 10} onClick={() => select("add-passkey")}>Add passkey</Button>
      <p className="text-sm text-muted">You can use this device, a nearby phone or a security key. Keep a second passkey or recovery codes for a lost device. Removing the last factor requires the explicit disable action below.</p>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Authenticator app</h2><p>{initial.totp ? "Enabled" : "Not enabled"}</p>
      <Button disabled={pending || (initial.totp && !initial.passkeys.length)} variant="outline" onClick={() => select(initial.totp ? "remove-totp" : "add-totp")}>{initial.totp ? "Remove authenticator app" : "Set up authenticator app"}</Button>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Recovery and password</h2><p>{initial.recoveryCount} recovery codes remaining.</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending || !protectedAccount} onClick={() => select("recovery")}>Regenerate recovery codes</Button><Button variant="outline" disabled={pending} onClick={() => select("password")}>Change password</Button><Button variant="outline" disabled={pending || !protectedAccount} onClick={() => select("disable")}>Disable extra protection</Button></div>
      <p className="text-sm text-muted">If you lose every factor and recovery code, contact your operator. A password reset preserves your factors; support cannot read your authenticator secret or bypass verification here.</p>
    </section>
    </>}
    {passwordOnly ? <section className="space-y-4 rounded-lg border border-border p-4"><h2 className="text-xl font-semibold">Change password</h2>{editor}</section> : <Dialog open={!!op} onOpenChange={open => { if (!open) close(); }}>
      <DialogContent
        title={op ? labels[op] : undefined}
        description={op === "add-passkey" ? "Set up a passkey to sign in with your device, phone or security key." : "Confirm your identity to update your account security."}
        className="max-h-[90dvh]"
        hideClose={pending}
        onPointerDownOutside={event => event.preventDefault()}
        onCloseAutoFocus={event => {
          event.preventDefault();
          requestAnimationFrame(() => (resultRef.current ?? triggerRef.current)?.focus());
        }}
      >{editor}</DialogContent>
    </Dialog>}
  </div>;
}
