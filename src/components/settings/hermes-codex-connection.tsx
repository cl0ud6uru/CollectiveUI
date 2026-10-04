'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { codexStatus, type CodexStatus, type CodexAction } from '@/docker-hermes/oauth';

const messages: Record<CodexStatus['state'], string> = {
  disconnected: 'No subscription sign-in stored for this profile.',
  pending: 'Waiting for you to approve sign-in with OpenAI.',
  connected: 'Signed in to ChatGPT / Codex for this profile. Model access has not been tested.',
  cancelled: 'Sign-in cancelled. This profile is disconnected.',
  expired: 'The verification code expired. Start a new sign-in.',
  error: 'Sign-in could not complete. This can be an account requirement, expired approval, or an egress/connection failure. Start a new sign-in; the previous exchange will not be replayed.',
  interrupted: 'Sign-in was interrupted. Restart the runtime and start a new sign-in.',
  blocked: 'This runtime has no external network access. An operator must provide approved auth.openai.com egress for login/refresh and chatgpt.com egress for inference. No login request was sent.',
};

export function HermesCodexConnection({ botId, revision, canStart, onChanged, onPendingChange }: {
  botId: string; revision: string; canStart: boolean; onChanged: () => Promise<void>; onPendingChange: (v: boolean) => void;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState('');
  const serial = useRef(0), abort = useRef<AbortController | null>(null);
  const api = `/api/bots/${encodeURIComponent(botId)}/native/codex`;
  const request = useCallback(async (action?: CodexAction, reconcile = false) => {
    const id = ++serial.current; abort.current?.abort(); const control = new AbortController(); abort.current = control;
    setBusy(action?.action ?? 'load'); setError('');
    try {
      const res = await fetch(api, action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), signal: control.signal } : { cache: 'no-store', signal: control.signal });
      const data = await res.json(); if (id !== serial.current) return;
      if (!res.ok) throw new Error(data.error || 'Sign-in could not be confirmed. Reload before retrying.');
      const value = action ? data : data.status;
      if (!value) { setStatus(null); setError('Start your runtime and reload to connect this profile.'); return; }
      const next = codexStatus.parse(value); setStatus(next);
      if ((action || reconcile) && next.state !== 'pending') await onChanged();
    } catch (e) { if (id === serial.current) { setError(e instanceof Error ? e.message : 'Sign-in could not be confirmed. Reload before retrying.'); setStatus(null); } }
    finally { if (id === serial.current) setBusy(null); }
  }, [api, onChanged]);
  useEffect(() => {
    let mounted = true; const sequence = serial, active = abort;
    queueMicrotask(() => { if (mounted) void request(); });
    return () => { mounted = false; ++sequence.current; active.current?.abort(); };
  }, [request]);
  useEffect(() => {
    onPendingChange(status?.state === 'pending');
    return () => onPendingChange(false);
  }, [status?.state, onPendingChange]);
  useEffect(() => {
    if (status?.state !== 'pending' || !status.sessionId || busy || error) return;
    const timer = setTimeout(() => void request({ action: 'poll', sessionId: status.sessionId! }), Math.max(3000, Math.min(60000, (status.nextPollAt ?? Date.now()) - Date.now())));
    return () => clearTimeout(timer);
  }, [status, busy, error, request]);
  const pending = status?.state === 'pending';
  return <section className="rounded-2xl border border-border p-5 space-y-4" aria-labelledby="codex-title">
    <h2 id="codex-title" className="font-semibold">ChatGPT / Codex subscription</h2>
    <p className="text-sm text-muted">Use native Hermes device login with an OpenAI account that supports Codex. This is separate from your CollectiveUI login.</p>
    <p className="text-sm text-muted">Sign-in is saved in this profile. Default-profile sign-ins can be inherited by other profiles in your runtime. Disconnect blocks this profile’s subscription access; it does not revoke the grant at OpenAI.</p>
    {status && <p role="status" className="text-sm">{messages[status.state]}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {pending && <div className="rounded-xl bg-surface-2 p-4 space-y-3">
      <p className="text-sm">1. Open OpenAI and enter this verification code:</p>
      <p className="font-mono text-xl tracking-widest" aria-label="OpenAI verification code">{status.userCode}</p>
      <a href={status.verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-sm underline">Open OpenAI verification</a>
      <p className="text-sm">2. Approve only if you started this sign-in. Return here when finished.</p>
      <p className="text-xs text-muted">Code expires {status.expiresAt ? new Date(status.expiresAt).toLocaleTimeString() : 'in 15 minutes'}. All your profiles stay idle during sign-in. If approval never completes, reviewed auth egress or OpenAI device-code authorization may be required.</p>
      <Button variant="outline" disabled={busy === 'cancel'} onClick={() => void request({ action: 'cancel', sessionId: status.sessionId! })}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel sign-in'}</Button>
    </div>}
    {!pending && <>
      <p className="text-xs text-muted">Save this provider and model before signing in. All profiles must be idle. Reconnect replaces this profile’s previous login; cancel or failure leaves it disconnected. Native Hermes manages token refresh.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!!busy || !canStart || !!error} onClick={() => void request({ action: 'start', requestId: crypto.randomUUID(), revision })}>{busy === 'start' ? 'Starting sign-in…' : status?.state === 'connected' ? 'Reconnect with OpenAI' : 'Sign in with OpenAI'}</Button>
        <Button variant="outline" disabled={!!busy || !canStart || !!error} onClick={() => void request({ action: 'disconnect', revision })}>Disconnect this profile</Button>
      </div>
    </>}
    <Button variant="ghost" disabled={!!busy} onClick={() => void request(undefined, true)}>Reload sign-in status</Button>
    <p className="text-xs text-muted">Leaving this page pauses polling; return before expiry to finish, or cancel. Restarting the runtime discards unfinished sign-ins. A completed sign-in is not an inference or model-access test.</p>
  </section>;
}
