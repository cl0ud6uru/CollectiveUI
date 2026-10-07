'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PetArt } from '@/components/pets/pet-art';
import { DEFAULT_PET } from '@/lib/pets/shared';
import type { DockerStatus } from '@/docker-hermes/types';
import { enablePersonalHermes, finishPersonalHermes, linkPersonalHermesBot, personalHermesStatus, stopPersonalHermes } from '@/app/(chat)/settings/hermes-actions';
const labels: Record<DockerStatus['phase'], string> = { disabled: 'Not enabled', checking_image: 'Checking the pinned Hermes image', creating_storage: 'Preparing your private storage', starting_container: 'Starting your runtime', checking_native: 'Checking native Hermes', pairing: 'Pairing your starter bot', ready: 'Runtime running', stopping: 'Stopping safely', stopped: 'Stopped · data retained', error: 'Setup needs attention', interrupted: 'Setup was interrupted' };
const busy = (s?: DockerStatus | null) => !!s && !['disabled', 'ready', 'stopped', 'error', 'interrupted'].includes(s.phase);
export function PersonalHermes({ canCreate }: { canCreate: boolean }) {
  const [state, setState] = useState<DockerStatus | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const searchParams = useSearchParams();
  const requestedOpen = searchParams.get('section') === 'personal-hermes';
  const [open, setOpen] = useState(requestedOpen);
  useEffect(() => {
    let active = true;
    if (requestedOpen) queueMicrotask(() => { if (active) setOpen(true); });
    return () => { active = false; };
  }, [requestedOpen]);
  useEffect(() => {
    if (!open) return;
    let active = true, running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try { let s = await personalHermesStatus(); if (s.phase === 'pairing' && canCreate) { await finishPersonalHermes(); s = await personalHermesStatus(); } if (active) { setState(s); setError(''); } }
      catch (e) { if (active) { setState(null); setError(e instanceof Error ? e.message : 'Status unavailable'); } }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(refresh, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [open, canCreate]);
  function action(run: () => Promise<unknown>) {
    start(async () => { try { await run(); setState(await personalHermesStatus()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Operation failed'); } });
  }
  return <details open={open} className="rounded-xl border border-border p-4" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">Personal Hermes <span className="font-normal text-muted">· shared runtime and private profiles</span></summary>
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted">Enable once to create your private Hermes starter bot. Your bots share your own runtime, with separate native profiles.</p>
      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <PetArt pet={{ ...DEFAULT_PET, enabled: true }} state={busy(state) ? 'working' : state?.phase === 'error' ? 'attention' : 'idle'} size={52} fallback={<span>🌱</span>} />
        <span>{state ? labels[state.phase] : 'Checking runtime status…'}</span>
      </div>
      {(error || state?.error) && <p role="alert" className="text-danger">{error || state?.error}</p>}
      {state?.phase === 'ready' ? <>
        {state.network === 'none' && <p role="status" className="text-xs text-muted">Internet access is off. An administrator can turn it on in Admin → Managed Hermes.</p>}
        <p className="text-xs text-muted">{state.network === 'none' ? 'Next: ask an administrator to turn on Internet access in Admin → Managed Hermes. You can prepare your provider settings while offline.' : 'Next: open Set up / Hermes settings, save an API-key provider and model, test the connection, then click Start chatting. Native subscription login is separate from API-key setup.'}</p>
        <ul className="space-y-2">{state.bindings.map(b => <li key={b.botId} className="flex flex-wrap items-center gap-x-4 gap-y-1"><Link href={`/bots/${b.botId}`} className="underline">{b.name}</Link><Link href={`/bots/${b.botId}/settings`} className="text-muted underline" aria-label={`Hermes settings for ${b.name}`}>Set up / Hermes settings</Link></li>)}</ul>
        {canCreate && <div className="flex gap-3"><Link href="/bots/new" className="underline">Create a bot</Link></div>}
        {canCreate && state.unlinked.length > 0 && <details><summary className="cursor-pointer">Unlinked profiles ({state.unlinked.length})</summary><ul className="mt-2 space-y-2">{state.unlinked.map(p => <li key={p.name} className="flex items-center justify-between gap-3"><span>{p.name}</span><Button variant="ghost" disabled={pending} onClick={() => action(async () => { await linkPersonalHermesBot({ profile: p.name, identity: p.identity, name: p.name }); toast.success('Native profile added as a private bot'); })}>Add as bot</Button></li>)}</ul></details>}
      </> : canCreate && <Button disabled={pending || busy(state) || !state} onClick={() => action(enablePersonalHermes)}>{state?.phase === 'disabled' ? 'Enable Hermes' : 'Retry / start'}</Button>}
      {state && !['disabled', 'stopped'].includes(state.phase) && <Button variant="ghost" disabled={pending} onClick={() => action(stopPersonalHermes)}>{busy(state) ? 'Cancel setup' : 'Stop runtime'}</Button>}
      <p className="text-xs text-muted">Stopping keeps your native profiles, skills, memory and sessions. Personal bots cannot be shared or used in groups, templates or delegation.</p>
    </div>
  </details>;
}
