'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ConnectionView } from '@/personal-codex/contracts';

const labels: Record<ConnectionView['state'], string> = {
  unavailable: 'Personal Codex requires an approved runtime installation.', not_started: 'Connect your ChatGPT account to create your private Codex workspace.',
  stopped: 'Your private workspace is retained. Start the runtime to reconnect.', signed_out: 'Your Codex runtime is ready to connect.',
  uncertain: 'A prior native sign-in may still be active. Cancel it before starting another sign-in.', pending: 'Finish sign-in on OpenAI’s page, then return here.', confirm: 'Confirm the signed-in account below belongs to you.',
  connected: 'Connected for all of your Codex bots.', changed: 'The native account changed. Disconnect before connecting a different account.',
};
export function PersonalCodexConnection() {
  const [view, setView] = useState<ConnectionView>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function refresh(signal?: AbortSignal) {
    const r = await fetch('/api/me/codex', { cache: 'no-store', signal });
    const data = await r.json(); if (!r.ok) throw new Error(data.error); if (!signal?.aborted) setView(data);
  }
  useEffect(() => {
    const ac = new AbortController();
    void fetch('/api/me/codex', { cache: 'no-store', signal: ac.signal }).then(async r => {
      const data = await r.json(); if (!r.ok) throw new Error(data.error);
      if (!ac.signal.aborted) setView(data);
    }).catch(e => { if (!ac.signal.aborted) setError(e.message); });
    return () => ac.abort();
  }, []);
  useEffect(() => {
    if (!['pending', 'uncertain'].includes(view?.state ?? '')) return;
    const ac = new AbortController(), timer = setInterval(() => { void refresh(ac.signal).catch(() => {}); }, 3000);
    return () => { clearInterval(timer); ac.abort(); };
  }, [view?.state]);
  async function act(action: 'connect' | 'confirm' | 'cancel' | 'disconnect' | 'start') {
    setBusy(true); setError('');
    try { const r = await fetch('/api/me/codex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error); setView(data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed. Reload before retrying.'); } finally { setBusy(false); }
  }
  return <section id="personal-codex" aria-labelledby="personal-codex-title" className="space-y-4 rounded-2xl border border-border p-5">
    <h2 id="personal-codex-title" className="font-semibold">Connect ChatGPT for Codex</h2>
    <p className="text-sm text-muted">Connect once for all your Codex bots. Use your own ChatGPT subscription account matching your CollectiveUI email. Your workspace and Codex history are private to you and retained when you delete a bot or disconnect. Model access depends on your plan.</p>
    <p role="status" className="text-sm">{view?.state === 'signed_out' && view.email ? 'Native sign-in ended. Disconnect the saved connection before signing in again.' : view ? labels[view.state] : 'Checking connection…'}</p>
    {view?.canConnect === false && <p className="text-sm text-muted">New personal ChatGPT connections are disabled by your organization. You can still cancel or disconnect your own connection.</p>}
    {view?.email && <p className="break-all text-sm">{view.email} · {view.planType} · Workspace {view.workspaceId}</p>}
    {view?.login && <div className="space-y-2 rounded-xl bg-surface-2 p-4"><p>Enter <strong className="select-all font-mono">{view.login.userCode}</strong> on OpenAI’s page.</p><a href={view.login.verificationUrl} target="_blank" rel="noreferrer" className="text-accent underline">Open ChatGPT sign-in</a><p className="text-xs text-muted">Only enter this code if you started sign-in here. Codex stores and refreshes your sign-in inside your private runtime.</p></div>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {view && view.canConnect !== false && ['not_started', 'signed_out'].includes(view.state) && !view.email && <Button disabled={busy} onClick={() => void act('connect')}>Connect ChatGPT</Button>}
      {view?.state === 'stopped' && <Button disabled={busy} onClick={() => void act('start')}>Start my Codex runtime</Button>}
      {view?.state === 'confirm' && view.canConnect !== false && <Button disabled={busy} onClick={() => void act('confirm')}>Confirm my account</Button>}
      {view && ['pending', 'uncertain'].includes(view.state) && <Button variant="outline" disabled={busy} onClick={() => void act('cancel')}>Cancel sign-in</Button>}
      {view && (['connected', 'changed', 'confirm', 'stopped'].includes(view.state) || (view.state === 'signed_out' && !!view.email)) && <Button variant="outline" disabled={busy} onClick={() => void act('disconnect')}>Disconnect ChatGPT</Button>}
      <Button variant="outline" disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>Refresh</Button>
    </div>
    <p className="text-xs text-muted">CollectiveUI login and other ChatGPT model connections are separate. Hermes keeps its own native sign-in grant; manage its profiles below. No account credentials are copied between engines.</p>
  </section>;
}
