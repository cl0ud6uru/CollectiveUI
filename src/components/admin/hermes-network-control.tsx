'use client';
import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { networkLabels, type NetworkMode, type NetworkStatus } from '@/docker-hermes/network';
import type { DockerNetworks } from '@/lib/docker-hermes/network';

export function useHermesNetworks(enabled: boolean) {
  const [value, setValue] = useState<DockerNetworks | null>(null), [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/hermes/network', { cache: 'no-store' }); const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Network status is unavailable.');
      setValue(data); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Network status is unavailable.'); }
  }, []);
  useEffect(() => { let active = true; if (enabled) queueMicrotask(() => { if (active) void refresh(); }); return () => { active = false; }; }, [enabled, refresh]);
  useEffect(() => {
    if (!value || !Object.values(value.owners).some(s => s.changing)) return;
    const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer);
  }, [value, refresh]);
  const status = (owner: string): NetworkStatus | null => value ? value.owners[owner] ?? { mode: value.defaultMode,
    onlineMode: value.defaultMode === 'proxy' ? 'proxy' : 'internet', actual: 'absent', running: false, revision: 0, changing: false, receipt: null, error: null } : null;
  return { status, error, refresh };
}
export function HermesNetworkControl({ owner, name, enabled, status, reload }: { owner: string; name: string; enabled: boolean; status: NetworkStatus | null; reload: () => Promise<void> }) {
  const [change, setChange] = useState<{ mode: NetworkMode; revision: number; requestId: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  function select(mode: NetworkMode) {
    if (!status) return;
    setChange({ mode, revision: status.revision, requestId: crypto.randomUUID() }); setConfirmed(false); setError('');
  }
  async function apply() {
    if (!change || !confirmed || pending) return;
    setPending(true); setError('');
    try {
      const res = await fetch('/api/admin/hermes/network', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, request: { ...change, confirmRestart: true } }) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'The request could not be confirmed.');
      setChange(null); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'The request could not be confirmed. Reload status before retrying the same request.'); await reload(); }
    finally { setPending(false); }
  }
  const blocked = !enabled || !status || status.changing || status.actual === 'unknown' || (!!status.error && status.receipt?.state !== 'rolled_back');
  return <div className="min-w-48 space-y-1">
    <label className="inline-flex min-h-11 items-center gap-2">
      <input type="checkbox" className="h-4 w-4 accent-[var(--fg)]" checked={!!status && status.mode !== 'none'} disabled={blocked}
        onChange={e => select(e.target.checked ? status!.onlineMode : 'none')} aria-label={`Internet access for ${name}`} />
      <span>{status ? networkLabels[status.mode] : 'Checking network…'}</span>
    </label>
    {status && <p className="text-xs text-muted">{status.changing ? 'Changing safely…' : status.actual === 'absent' ? 'Policy saved · runtime not created' : status.actual === 'unknown' ? 'Actual runtime network unconfirmed' : `${networkLabels[status.actual]} · ${status.running ? 'running' : 'stopped'}`}</p>}
    {status?.error && <p role="alert" className="text-xs text-danger">{status.error}</p>}
    {status?.receipt && !status.changing && <p role="status" className="text-xs text-muted">Last change: {status.receipt.state.replace('_', ' ')}</p>}
    {status?.mode === 'proxy' && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => select('internet')}>Use Standard Internet…</Button>}
    <Dialog open={!!change} onOpenChange={open => { if (!open && !pending) setChange(null); }}>
      <DialogContent title={`Change Internet access for ${name}`} description="This policy applies to every native Hermes profile owned by this person.">
        <div className="space-y-4 text-sm">
          <p>New policy: <strong>{change ? networkLabels[change.mode] : ''}</strong>. Existing runtimes are safely replaced and verified using the same retained storage. All profiles must be idle; pending sign-in must finish or be cancelled first.</p>
          <p>Sessions, bots, skills, memory and profile identities are retained. A running runtime restarts. A stopped runtime remains stopped. A failed or interrupted change leaves it stopped for review.</p>
          {change?.mode === 'internet' && <p className="rounded-xl border border-amber-500/40 p-3">Standard Internet uses a dedicated Docker bridge with no published ports. Outbound access can also reach private networks, the Docker host and metadata services where the host permits it. Use an operator-managed restricted proxy when those destinations must be blocked.</p>}
          {change?.mode === 'proxy' && <p>The existing restricted proxy policy is preserved. An operator must provide and maintain its reviewed per-user proxy network.</p>}
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={confirmed} disabled={pending} onChange={e => setConfirmed(e.target.checked)} />I approve this policy and any required runtime restart.</label>
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex gap-2"><Button disabled={!confirmed || pending} onClick={() => void apply()}>{pending ? 'Submitting…' : 'Apply network policy'}</Button><Button variant="ghost" disabled={pending} onClick={() => setChange(null)}>Cancel</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
