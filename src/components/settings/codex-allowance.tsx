'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { quotaStale, type CodexAllowanceView } from '@/lib/codex-allowance/contracts';
export function CodexAllowance({ initial }: { initial?: CodexAllowanceView }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [view, setView] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (initial) return;
    const abort = new AbortController();
    void fetch('/api/me/codex-allowance', { cache: 'no-store', signal: abort.signal }).then(async res => { if (res.ok) setView(await res.json()); }).catch(() => {});
    return () => abort.abort();
  }, [initial]);
  useEffect(() => {
    if (initial || !view?.state || !['ready', 'error'].includes(view.state)) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      void fetch('/api/me/codex-allowance', { cache: 'no-store', signal: abort.signal }).then(async response => {
        if (response.ok) setView(await response.json());
        else if (response.status === 401 || response.status === 403) setView({ state: 'unavailable', source: 'codex_app_server', windows: [], runtimeLabel: null, lastReadAt: null, message: 'Sign in again to read your allowance.' });
      }).catch(() => {});
    }, 30_000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [initial, view?.state]);
  async function refresh() {
    setBusy(true); setError('');
    try { const response = await fetch('/api/me/codex-allowance', { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Allowance refresh failed.'); setView(data); }
    catch (error) { setError(error instanceof Error ? error.message : 'Allowance refresh failed.'); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="codex-allowance-title" className="space-y-4 rounded-2xl border border-border p-5">
    <h2 id="codex-allowance-title" className="font-semibold">Personal Codex subscription allowance</h2>
    <p className="text-sm text-muted">Visible only to you. Subscription allowance is separate from OpenAI API dollars. Only windows reported by a supported authenticated Codex runtime appear here.</p>
    {!view && <p role="status" className="text-sm">Checking runtime connection…</p>}
    {view?.message && <p role="status" className="text-sm">{view.message}</p>}
    {view && (view.state === 'disabled' || view.state === 'unavailable') && <p className="text-sm text-muted">An operator must connect an isolated, authenticated per-user Codex app-server before this bar can report allowance. An organization billing key and existing response-header snapshots cannot supply it.</p>}
    {view?.runtimeLabel && <p className="text-xs text-muted">Runtime: {view.runtimeLabel} · Source: Codex app-server · Last full read: {view.lastReadAt ? new Date(view.lastReadAt).toLocaleString() : 'Never'}</p>}
    {view && (view.state === 'ready' || view.state === 'error') && !view.windows.length && <p className="text-sm">No allowance windows returned.</p>}
    {view?.windows.map(window => {
      const stale = quotaStale(window, clock); const percent = window.usedPercent.value;
      return <div key={`${window.limitId}:${window.kind}`} className="space-y-2 rounded-xl bg-surface-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="break-all font-medium">{window.limitName ?? window.limitId} · {window.kind}</span><span>{percent === null ? 'Usage unknown' : `${percent}% used`}{stale ? ' · Stale' : ''}</span></div>
        {percent !== null && <div role="progressbar" aria-label={`${window.limitName ?? window.limitId} ${window.kind} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)} aria-valuetext={`${percent}% used${stale ? ', stale observation' : ''}`} className="h-2 overflow-hidden rounded-full bg-border"><div className={stale ? 'h-full bg-muted' : 'h-full bg-accent'} style={{ width: `${Math.min(100, percent)}%` }} /></div>}
        <p className="text-xs text-muted">Reported window: {window.windowDurationMins.value === null ? 'unknown duration' : `${window.windowDurationMins.value} minutes`} · Reset: {window.resetsAt.value === null ? 'unknown' : new Date(window.resetsAt.value * 1000).toLocaleString()}</p>
        <p className="break-words text-xs text-muted">Usage source: {window.usedPercent.source} · Observed: {new Date(window.usedPercent.observedAt).toLocaleString()}</p>
        {(window.windowDurationMins.observedAt !== window.usedPercent.observedAt || window.resetsAt.observedAt !== window.usedPercent.observedAt) && <p className="text-xs text-muted">Window details last observed: duration {new Date(window.windowDurationMins.observedAt).toLocaleString()} ({window.windowDurationMins.source}) · reset {new Date(window.resetsAt.observedAt).toLocaleString()} ({window.resetsAt.source})</p>}
      </div>;
    })}
    {view && (view.state === 'ready' || view.state === 'error' || view.state === 'needs_auth') && <Button variant="outline" disabled={busy} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh Codex allowance'}</Button>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </section>;
}
