'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mountMcpApp } from '@/lib/mcp/app-host';
import type { AppActionReply, AppView } from '@/lib/mcp/apps-contract';

async function appRequest(id: string, body?: unknown, actionsOnly = false, signal?: AbortSignal) {
  const response = await fetch(`/api/mcp-apps/${encodeURIComponent(id)}${actionsOnly ? '?actions=1' : ''}`, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    cache: 'no-store', signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The widget is unavailable.');
  return data as { view: AppView; actions: AppActionReply[]; action: AppActionReply };
}

export function McpAppHost({ id }: { id: string }) {
  const [view, setView] = useState<AppView | null>(null);
  const [actions, setActions] = useState<AppActionReply[]>([]);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const waiting = useRef(new Map<string, { resolve: (result: AppView['result']) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const alive = useRef(true);
  const teardown = useRef<(() => Promise<void>) | null>(null);
  const updateAction = useCallback((action: AppActionReply) => {
    setActions(previous => [...previous.filter(a => a.id !== action.id), action].slice(-100));
    const waiter = waiting.current.get(action.id);
    if (waiter && ['done', 'error', 'denied'].includes(action.status)) {
      clearTimeout(waiter.timer); waiting.current.delete(action.id);
      if (action.result) waiter.resolve(action.result);
      else waiter.reject(new Error('The widget request was denied.'));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    void appRequest(id, undefined, false, abort.signal).then(data => { if (!abort.signal.aborted) { setView(data.view); setActions(data.actions); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    const poll = setInterval(() => {
      void appRequest(id, undefined, true, abort.signal).then(data => data.actions.forEach(updateAction)).catch(e => {
        if (!abort.signal.aborted) { setError(e.message); setView(null); }
      });
    }, 20000);
    const pending = waiting.current;
    return () => {
      alive.current = false; abort.abort(); clearInterval(poll);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Widget closed.')); }
      pending.clear();
    };
  }, [id, reload, updateAction]);

  useLayoutEffect(() => {
    if (!view || !frame.current) return;
    let disposed = false;
    let cleanup: (() => Promise<void>) | undefined;
    const mounted = mountMcpApp(frame.current, view, {
      ready: () => { if (!disposed) setReady(true); },
      error: message => { if (!disposed) { setError(message); setView(null); } },
      close: () => { if (!disposed) { setError('The widget was closed.'); setView(null); } },
      callTool: async (name, input) => {
        if (disposed) throw new Error('Widget closed.');
        const { action } = await appRequest(id, { operation: 'call', id: crypto.randomUUID(), name, arguments: input });
        if (disposed) throw new Error('Widget closed.');
        updateAction(action);
        if (action.result) return action.result;
        if (action.status !== 'pending') throw new Error('The widget request is unavailable or already running.');
        return new Promise<AppView['result']>((resolve, reject) => {
          const timer = setTimeout(() => { waiting.current.delete(action.id); reject(new Error('Widget approval timed out.')); }, 150000);
          waiting.current.set(action.id, { resolve, reject, timer });
        });
      },
    });
    void mounted.then(fn => { cleanup = fn; if (disposed) void fn(); else teardown.current = fn; }).catch(() => {});
    void mounted.catch(() => { if (!disposed) { setError('The widget sandbox could not be initialized.'); setView(null); } });
    // Layout cleanup sends the official teardown request before React removes the iframe.
    return () => { disposed = true; teardown.current = null; if (cleanup) void cleanup(); };
  }, [id, view, updateAction]);

  const decide = async (action: AppActionReply, approve: boolean) => {
    setBusy(action.id);
    try { const data = await appRequest(id, { operation: 'decide', id: action.id, approve }); if (alive.current) updateAction(data.action); }
    catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : 'The request could not be completed.'); setView(null); } }
    finally { if (alive.current) setBusy(null); }
  };
  return <section aria-label="Interactive tool widget" className="my-3 overflow-hidden rounded-xl border border-border">
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
      <span className="text-sm font-medium">{view?.title ?? 'Tool widget'}</span>
      <button className="rounded px-2 py-1 text-xs underline" onClick={async () => { await teardown.current?.(); setView(null); setReady(false); setError(''); setReload(x => x + 1); }}>Reload widget</button>
    </div>
    {error ? <p role="alert" className="p-3 text-sm">{error} The saved text result is still available.</p> : <>
      {!ready && <p role="status" className="p-3 text-sm text-muted">Loading widget…</p>}
      {view && <iframe ref={frame} title={view.title} className="w-full border-0" style={{ height: 320 }} />}
    </>}
    {actions.filter(a => a.status === 'pending').map(action => <div key={action.id} className="space-y-2 border-t border-border p-3">
      <p className="font-medium">Approval required: {action.tool}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(action.input, null, 2)}</pre>
      <div className="flex gap-2">
        <button className="rounded border border-border px-3 py-2" disabled={!!busy || !!error} onClick={() => void decide(action, true)}>Allow once</button>
        <button className="rounded border border-border px-3 py-2" disabled={!!busy || !!error} onClick={() => void decide(action, false)}>Deny</button>
      </div>
    </div>)}
    {actions.filter(a => a.status !== 'pending').slice(-5).map(action => <p role="status" key={action.id} className="border-t border-border px-3 py-2 text-xs text-muted">
      {action.tool}: {({ running: 'Running; it will not be retried automatically', done: 'Completed', denied: 'Denied', error: 'Failed' } as const)[action.status as Exclude<AppActionReply['status'], 'pending'>]}
    </p>)}
  </section>;
}
