'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Pending = { flow: string; authorizationUrl: string; expiresAt: number };
type Result = Partial<Pending> & { status: string; message?: string; duplicate?: boolean; error?: string };
export function NativeMcpOAuth({ connectionId, sessionId, profile, name, disabled }: { connectionId: string; sessionId: string; profile: string; name: string; disabled: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const held = useRef<Pending | null>(null);
  const blocked = useRef(disabled);
  const endpoint = `/api/hermes/${encodeURIComponent(connectionId)}/mcp-oauth`;
  const request = useCallback(async (input: Record<string, unknown>, keepalive = false): Promise<Result> => {
    const response = await fetch(endpoint, { method: 'POST', cache: 'no-store', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, input }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check authorization. Check its outcome in Hermes.');
    return result;
  }, [endpoint, sessionId]);
  // Scope changes, panel closure and unmount stop polling and attempt cleanup
  // against the original owner/chat binding. Provider grants are never revoked.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const flow = held.current;
      held.current = null;
      if (flow) void request({ operation: 'cancel', flow: flow.flow }, true).catch(() => {});
    };
  }, [request]);
  const cancel = useCallback(async (failure?: string) => {
    const flow = held.current;
    if (!flow) return;
    held.current = null;
    setPending(null);
    setBusy(true);
    if (failure) setMessage(failure);
    const reportCleanup = (outcome: string) => { if (active.current) setMessage(failure ? `${failure} ${outcome}` : outcome); };
    try {
      const result = await request({ operation: 'cancel', flow: flow.flow });
      reportCleanup(result.message || 'Stopped waiting. Cancellation does not revoke a grant already issued.');
    } catch { reportCleanup('Could not confirm cancellation. Authorization may still complete; check Hermes or the provider.'); }
    finally { if (active.current) setBusy(false); }
  }, [request]);
  useEffect(() => {
    blocked.current = disabled;
    if (disabled && held.current) void cancel();
  }, [disabled, cancel]);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (Date.now() >= pending!.expiresAt) { if (!stopped) await cancel(); return; }
      try {
        const result = await request({ operation: 'poll', flow: pending!.flow });
        if (stopped || !active.current) return;
        setMessage(result.message || 'Waiting for authorization.');
        if (result.status === 'approved') { held.current = null; setPending(null); return; }
        if (result.status === 'error') { await cancel(result.message || 'Hermes could not complete authorization. Check its outcome in Hermes before starting again.'); return; }
        timer = setTimeout(poll, 1500);
      } catch {
        if (!stopped && active.current) await cancel('Could not verify authorization. Check Hermes before starting again.');
      }
    }
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pending, request, cancel]);
  async function start() {
    if (!confirm(`Authorize “${name}” for Hermes profile “${profile}”? The provider will ask for consent. Hermes may save OAuth credentials for other clients using this profile. Closing or cancelling cannot revoke a grant already approved.`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await request({ operation: 'start', requestId: crypto.randomUUID(), name, confirmed: true });
      if (result.flow && result.authorizationUrl && result.expiresAt) {
        const flow = { flow: result.flow, authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt };
        if (!active.current || blocked.current) { void request({ operation: 'cancel', flow: flow.flow }, true).catch(() => {}); return; }
        held.current = flow; setPending(flow);
        setMessage('Open the provider sign-in, then return here. Your browser must be able to reach the HTTPS Hermes dashboard callback.');
      } else if (active.current) setMessage(result.message || 'The outcome is uncertain. Check Hermes before starting again.');
    } catch (error) { if (active.current) setMessage(error instanceof Error ? error.message : 'Could not start authorization. Check Hermes before trying again.'); }
    finally { if (active.current) setBusy(false); }
  }
  return <div className="space-y-2">
    {!pending && <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void start()}>Authorize MCP OAuth</Button>}
    {pending && <><a className="underline" href={pending.authorizationUrl} target="_blank" rel="noopener noreferrer">Open provider sign-in</a><Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel authorization</Button><p className="text-xs text-muted">Cancellation stops waiting; it cannot revoke a grant already approved. Manage saved grants in Hermes or at the provider.</p></>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}
