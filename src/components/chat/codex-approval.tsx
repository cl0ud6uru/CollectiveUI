'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
export function CodexApproval({ data, readOnly }: { data: { id: string; label: string; state: string }; readOnly?: boolean }) {
  const [busy, setBusy] = useState(false), [state, setState] = useState(data.state), [error, setError] = useState('');
  const pending = data.state === 'pending' && state === 'pending';
  async function decide(decision: 'decline' | 'cancel') {
    setBusy(true); setError('');
    try { const r = await fetch(`/api/me/codex/approvals/${encodeURIComponent(data.id)}`, { method: 'POST', headers: { 'x-codex-decision': decision } });
      const result = await r.json(); if (!r.ok) throw new Error(result.error); setState(decision);
    } catch (e) { setError(e instanceof Error ? e.message : 'Decision failed.'); } finally { setBusy(false); }
  }
  return <div className="my-3 space-y-2 rounded-xl border border-border p-3 text-sm">
    <p>{data.label}</p><p className="text-muted">This pilot runs commands and edits files within your workspace. Broader permissions are unavailable. Deny to let Codex try another approach, or stop this turn.</p>
    {pending && !readOnly ? <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void decide('decline')}>Deny</Button><Button variant="outline" disabled={busy} onClick={() => void decide('cancel')}>Stop</Button></div> : <p role="status">{pending ? 'Awaiting the caller’s decision' : (data.state !== 'pending' ? data.state : state) === 'decline' ? 'Denied' : 'Stopped'}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
