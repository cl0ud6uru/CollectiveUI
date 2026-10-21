'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AccountSetupView, ConnectionView } from '@/personal-codex/contracts';

export type DeviceSetupView = { eligible: boolean; reason: string | null; runtime: AccountSetupView['runtime']; canPrepareRuntime: boolean };
const deviceUrl = 'https://auth.openai.com/codex/device';
const labels: Record<ConnectionView['state'], string> = {
  unavailable: 'Stock Codex is unavailable in this installation.', not_started: 'Connect your ChatGPT account to stock Codex.',
  stopped: 'Your private Codex workspace is stopped.', signed_out: 'Stock Codex is signed out. Connect again to continue.',
  uncertain: 'Checking the device sign-in. If it cannot finish, cancel and retry.', pending: 'Finish signing in on the official OpenAI page, then return here.',
  confirm: 'OpenAI verified this account. Confirm it belongs to you before connecting it to your CollectiveUI account.',
  connected: 'Your ChatGPT account is connected to stock Codex.', changed: 'The runtime account changed. Disconnect before connecting another account.',
  expired: 'The device code expired. Connect again to get a new code.',
  failed: 'OpenAI sign-in did not finish. Connect again or retry the status check.',
};
type Action = { action: 'connect'; accepted: true; consentVersion: 1 } |
  { action: 'confirm'; accepted: true; consentVersion: 1; expected: { email: string; workspaceId: string } } |
  { action: 'cancel' | 'disconnect' | 'start' | 'refresh' };

/** Browser device authorization is independent of the Native CollectiveUI companion. */
export function PersonalCodexConnection({ setup, initialView }: { setup?: DeviceSetupView; initialView?: ConnectionView } = {}) {
  const [view, setView] = useState<ConnectionView | undefined>(initialView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [confirmedIdentity, setConfirmedIdentity] = useState('');
  const sequence = useRef(0);
  const mutating = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (mutating.current) return;
    const current = ++sequence.current;
    const response = await fetch('/api/me/codex', { cache: 'no-store', signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load stock Codex status.');
    if (!signal?.aborted && current === sequence.current) setView(data);
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => { void refresh(ac.signal).catch(cause => { if (!ac.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load stock Codex status.'); }); }, 0);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [refresh]);
  useEffect(() => {
    if (!['pending', 'uncertain'].includes(view?.state ?? '')) return;
    const ac = new AbortController();
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void refresh(ac.signal).catch(cause => { if (!ac.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not check device sign-in.'); }).finally(() => { reading = false; });
    }, 1500);
    return () => { clearInterval(timer); ac.abort(); };
  }, [view?.state, refresh]);

  async function act(body: Action, reconnect = false) {
    mutating.current = true; ++sequence.current;
    setBusy(true); setError(''); setConfirmedIdentity('');
    const post = async (input: Action) => {
      const response = await fetch('/api/me/codex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The stock Codex action could not be completed.');
      setView(data);
    };
    try {
      if (reconnect) await post({ action: 'disconnect' });
      await post(body);
      if (body.action === 'connect') setConsent(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The stock Codex action could not be completed.');
    } finally { mutating.current = false; setBusy(false); }
  }
  const identity = view?.email && view.workspaceId ? JSON.stringify([view.email, view.workspaceId]) : '';
  const waiting = view?.state === 'pending' || view?.state === 'uncertain';
  const review = view?.state === 'confirm';
  const connected = view?.state === 'connected';
  const saved = !!view?.email && ['connected', 'changed', 'signed_out', 'stopped'].includes(view.state);
  const canConnect = view?.canConnect !== false && !!setup?.eligible && !!setup.canPrepareRuntime && view?.state !== 'unavailable';
  const login = view?.login;
  const validLogin = login?.verificationUrl === deviceUrl && /^[A-Z0-9-]{4,32}$/.test(login.userCode);

  return <section aria-labelledby="stock-codex-title" className="space-y-3 rounded-xl border border-border p-4">
    <h3 id="stock-codex-title" className="font-medium">Stock Codex</h3>
    <p className="text-sm text-muted">Sign in using OpenAI’s device page. This connection uses your private Codex workspace.</p>
    <p role="status" className="text-sm">{view ? view.reason || labels[view.state] : error ? 'Stock Codex status unavailable.' : 'Checking stock Codex status…'}</p>
    {setup?.reason && !setup.eligible && <p className="text-sm text-muted">{setup.reason}</p>}
    {setup && !setup.canPrepareRuntime && setup.runtime.reason && <p className="text-sm text-muted">{setup.runtime.reason}</p>}
    {view?.email && <dl className="space-y-1 break-all text-sm">
      <div><dt className="inline text-muted">OpenAI account: </dt><dd className="inline">{view.email}</dd></div>
      {view.workspaceId && <div><dt className="inline text-muted">Account / workspace: </dt><dd className="inline">{view.workspaceId}</dd></div>}
      {view.planType && <div><dt className="inline text-muted">Plan: </dt><dd className="inline">{view.planType}</dd></div>}
    </dl>}
    {waiting && validLogin && <div className="space-y-2 rounded-lg bg-surface-2 p-3">
      <p className="text-sm">Enter this code on the OpenAI page:</p>
      <p aria-label="OpenAI device code" className="font-mono text-xl font-semibold tracking-wider">{login.userCode}</p>
      <a href={deviceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center rounded-lg border px-3 text-sm">Open OpenAI device sign-in</a>
      {login.expiresAt && <p className="text-xs text-muted">Code expires {new Date(login.expiresAt).toLocaleTimeString()}. If it expires, cancel and connect again.</p>}
      <p className="text-xs text-muted">Keep this page open. After sign-in, you will review the verified account here.</p>
    </div>}
    {review && identity && <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmedIdentity === identity} disabled={busy} onChange={event => setConfirmedIdentity(event.target.checked ? identity : '')} className="mt-1" /><span>I confirm this verified OpenAI account belongs to me and authorize connecting it to my signed-in CollectiveUI account.</span></label>
      <Button disabled={busy || confirmedIdentity !== identity} onClick={() => void act({ action: 'confirm', accepted: true, consentVersion: 1, expected: { email: view!.email!, workspaceId: view!.workspaceId! } })}>Confirm stock Codex account</Button>
    </div>}
    {canConnect && !waiting && !review && view?.state !== 'changed' && <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} className="mt-1" /><span>I authorize this installation to prepare my private Codex workspace and use my ChatGPT account for stock Codex.</span></label>
      <Button disabled={busy || !consent} onClick={() => { window.open(deviceUrl, '_blank', 'noopener,noreferrer'); void act({ action: 'connect', accepted: true, consentVersion: 1 }, saved); }}>{busy ? 'Preparing device sign-in…' : saved ? 'Reconnect stock Codex' : view?.state === 'expired' ? 'Retry stock Codex sign-in' : 'Connect stock Codex'}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {(waiting || review || view?.state === 'expired') && <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'cancel' })}>Cancel Codex sign-in</Button>}
      {saved && <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'disconnect' })}>Disconnect stock Codex</Button>}
      {view?.state === 'stopped' && saved && <Button variant="outline" disabled={busy} onClick={() => void act({ action: 'start' })}>Start Codex workspace</Button>}
      <Button variant="outline" disabled={busy} onClick={() => { setError(''); void refresh().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load stock Codex status.')); }}>{error || !view ? 'Retry Codex status' : 'Refresh Codex status'}</Button>
    </div>
    {connected && <p className="text-xs text-muted">Native CollectiveUI sign-in is managed separately below.</p>}
  </section>;
}
