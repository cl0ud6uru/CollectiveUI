'use client';
import { useEffect, useState } from 'react';
import type { NativeResources as Resources } from '@/docker-hermes/types';
import { Button } from '@/components/ui/button';
export function NativeResources({ botId, section }: { botId: string; section: 'Skills' | 'Memory' }) {
  const [data, setData] = useState<Resources | null>(null);
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      try {
        const res = await fetch(`/api/bots/${encodeURIComponent(botId)}/native`, { cache: 'no-store', signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Native resources unavailable');
        if (!controller.signal.aborted) { setData(body); setError(''); }
      } catch (e) { if (!controller.signal.aborted) { setData(null); setError(e instanceof Error ? e.message : 'Native resources unavailable'); } }
    }
    void read();
    return () => controller.abort();
  }, [botId, section, revision]);
  const items = section === 'Skills' ? data?.skills : data?.memories;
  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted">Native Hermes {section.toLowerCase()} · read only</p><Button variant="ghost" onClick={() => refresh(r => r + 1)}>Refresh</Button></div>
    <p className="text-xs text-muted">Hermes owns these resources. Refresh after the bot changes them in chat.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted">Reading the native profile…</p>}
    {items?.map(item => <details key={item.id} className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{'name' in item && typeof item.name === 'string' ? item.name : item.id}</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-muted">{item.content}</pre></details>)}
    {items?.length === 0 && <p className="text-sm text-muted">No native {section.toLowerCase()} found.</p>}
  </div>;
}
