'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ConnectionView } from '@/personal-codex/contracts';

const labels: Record<ConnectionView['state'], string> = {
  unavailable: 'Legacy personal Codex runtime unavailable.', not_started: 'No legacy Codex grant is saved.',
  stopped: 'The legacy private workspace is stopped.', signed_out: 'The legacy native Codex sign-in has ended.',
  uncertain: 'A legacy native sign-in may still be active.', pending: 'A legacy sign-in is in progress.', confirm: 'A legacy account change needs confirmation.',
  connected: 'Legacy native Codex is connected.', changed: 'The legacy native account changed.',
};

/** Cleanup controls for a native Codex grant saved by an older release. */
export function PersonalCodexConnection() {
  const [view, setView] = useState<ConnectionView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh(signal?: AbortSignal) {
    const r = await fetch('/api/me/codex', { cache: 'no-store', signal });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not load legacy Codex status.');
    if (!signal?.aborted) setView(data);
  }
  useEffect(() => {
    const ac = new AbortController();
    const timer = setTimeout(() => { void refresh(ac.signal).catch(e => { if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load legacy Codex status.'); }); }, 0);
    return () => { clearTimeout(timer); ac.abort(); };
  }, []);
  useEffect(() => {
    if (!['pending', 'uncertain'].includes(view?.state ?? '')) return;
    const ac = new AbortController(), timer = setInterval(() => { void refresh(ac.signal).catch(() => {}); }, 3000);
    return () => { clearInterval(timer); ac.abort(); };
  }, [view?.state]);
  async function act(action: 'cancel' | 'disconnect') {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/me/codex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Legacy cleanup failed.');
      setView(data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Legacy cleanup failed.'); } finally { setBusy(false); }
  }
  return <details className="rounded-xl border border-border px-4 py-3">
    <summary className="cursor-pointer text-sm font-medium">Legacy Codex connection cleanup</summary>
    <div className="mt-3 space-y-3">
      <p role="status" className="text-sm">{view ? labels[view.state] : error ? 'Legacy Codex status unavailable.' : 'Checking legacy Codex status…'}</p>
      {view?.email && <p className="break-all text-sm">{view.email}{view.planType ? ` · ${view.planType}` : ''}</p>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2">
        {view && ['pending', 'uncertain'].includes(view.state) && <Button variant="outline" disabled={busy} onClick={() => void act('cancel')}>Cancel legacy sign-in</Button>}
        {view && (['connected', 'changed', 'confirm', 'stopped'].includes(view.state) || (view.state === 'signed_out' && !!view.email)) && <Button variant="outline" disabled={busy} onClick={() => void act('disconnect')}>Remove legacy grant</Button>}
        {(error || !view) && <Button variant="outline" disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError(e instanceof Error ? e.message : 'Could not load legacy Codex status.')); }}>Retry legacy status</Button>}
      </div>
      <p className="text-xs text-muted">New sign-ins use the ChatGPT account controls above. This cleanup is only for grants saved by an older version.</p>
    </div>
  </details>;
}
