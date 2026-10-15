'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { RecoveryView } from '@/lib/remote-hermes/recovery-contract';

export function NativeRecovery({ connectionId, sessionId, disabled, onOpenChange, onApplied }: {
  connectionId: string; sessionId: string; disabled: boolean; onOpenChange(open: boolean): void; onApplied(): void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<RecoveryView | null>(null), [error, setError] = useState('');
  const pending = useRef(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (intent?.state !== 'prepared') return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, intent.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [intent]);
  function close() { if (pending.current) return; setOpen(false); onOpenChange(false); }
  async function request(operation: 'prepare' | 'confirm' | 'check') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    if (operation === 'prepare') { setExpired(false); setOpen(true); onOpenChange(true); }
    try {
      const response = await fetch(`/api/hermes/${encodeURIComponent(connectionId)}/recovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, sessionId, ...(operation === 'prepare' ? {} : { intentId: intent?.intentId }), ...(operation === 'confirm' ? { confirmed: true } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Recovery could not be verified. Reservations remain blocked.');
      setIntent(result); if (result.state === 'prepared') setExpired(false);
      if (result.state === 'applied') { setOpen(false); onOpenChange(false); onApplied(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Recovery is uncertain. Reservations remain blocked.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <>
    <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void request('prepare')}>Review recovery</Button>
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}><DialogContent title="Recover unresolved Hermes work">
      <p>This cancels unresolved work in this native conversation. Other conversations in this profile may pause while ownership is fenced. Completed output and conversation history remain; earlier external effects may be uncertain. Your message and protected answers will not be sent again.</p>
      {intent?.state === 'prepared' && <>
        <p className="mt-3">Profile: {intent.profile}. Reserved operations: {intent.reservationCount}. Confirm within one minute; any conversation or ownership change invalidates this confirmation.</p>
        <Button className="mt-3" variant="danger" disabled={busy || expired} onClick={() => void request('confirm')}>Cancel unresolved work and recover</Button>
      </>}
      {intent && ['pending', 'uncertain'].includes(intent.state) && <>
        <p role="status" className="mt-3">Native completion is unverified. Reservations remain blocked. Checking evidence uses the original recovery identity and does not send your work again.</p>
        <Button className="mt-3" variant="outline" disabled={busy} onClick={() => void request('check')}>Check recovery evidence</Button>
      </>}
      {expired && intent?.state === 'prepared' && <p role="status">Confirmation expired. Close this dialog and review recovery again.</p>}
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
      {busy && <p role="status">Checking verified native recovery…</p>}
    </DialogContent></Dialog>
  </>;
}
