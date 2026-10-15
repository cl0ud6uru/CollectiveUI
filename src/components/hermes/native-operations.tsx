'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';

type Panel = 'projects' | 'files' | 'schedules' | 'plugins' | 'system';
type Row = Record<string, unknown>;
type Result = { projects?: Row[]; activeId?: string; schedules?: Row[]; plugins?: Row[]; entries?: { name: string; path: string; directory: boolean }[]; roots?: string[]; directory?: string; [key: string]: unknown };
const labels: Record<Panel, string> = { projects: 'Projects', files: 'Directories', schedules: 'Schedules', plugins: 'Plugins', system: 'System' };
const fieldLabels: Record<string, string> = { id: 'ID', nextRun: 'Next run', lastStatus: 'Last result', cpuCount: 'CPU cores', cpuPercent: 'CPU usage (%)', uptimeSeconds: 'Uptime (seconds)' };
const fieldLabel = (key: string) => fieldLabels[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2).toLocaleString()} MiB`;
type PreparedProject = { confirmation: string; action: 'create' | 'select'; name?: string; profile: string; title: string };
export function NativeOperations({ connectionId, profiles, nativeSession }: { connectionId: string; profiles: RemoteHermesProfile[]; nativeSession: { id: string; profile: string; title: string } | null }) {
  const [profile, setProfile] = useState(nativeSession?.profile ?? profiles[0]?.name ?? '');
  const [panel, setPanel] = useState<Panel>('projects');
  const [directory, setDirectory] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [prepared, setPrepared] = useState<PreparedProject | null>(null);
  const [mutating, setMutating] = useState(false);
  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ profile, panel, ...(directory && panel === 'files' ? { path: directory } : {}) });
    fetch(`/api/hermes/${encodeURIComponent(connectionId)}/operations?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Could not load this Hermes panel.'); return value as Result; })
      .then(value => { if (!controller.signal.aborted) { setResult(value); setError(''); } })
      .catch(e => { if (!controller.signal.aborted) { setResult(null); setError(e instanceof Error ? e.message : 'Could not load this Hermes panel.'); } });
    return () => controller.abort();
  }, [connectionId, profile, panel, directory, revision]);
  const reset = () => { setResult(null); setError(''); };
  async function projectRequest(input: { operation: 'prepare'; action: 'create'; name: string } | { operation: 'prepare'; action: 'select'; projectId: string } | { operation: 'confirm'; confirmation: string }) {
    if (!nativeSession) return;
    setMutating(true); setError('');
    try {
      const response = await fetch(`/api/hermes/${encodeURIComponent(connectionId)}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: nativeSession.id, input }), cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not change this Hermes project.');
      if (input.operation === 'prepare') {
        setPrepared({ confirmation: value.confirmation, action: value.action, name: value.name, profile: value.profile, title: value.title });
      } else {
        setPrepared(null); setResult(value as Result); setProjectName(''); setRevision(r => r + 1);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change this Hermes project.'); }
    finally { setMutating(false); }
  }
  const rows = result?.projects ?? result?.schedules ?? result?.plugins;
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Select aria-label="Hermes workspace profile" value={profile} onChange={e => { reset(); setPrepared(null); setProfile(e.target.value); setDirectory(''); }}>{profiles.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</Select>
      <Button variant="outline" onClick={() => { reset(); setRevision(r => r + 1); }}>Refresh</Button></div>
    <nav aria-label="Hermes workspace panels" className="flex flex-wrap gap-2">{(Object.keys(labels) as Panel[]).map(p => <Button key={p} variant={panel === p ? 'primary' : 'outline'} onClick={() => { reset(); setPanel(p); setDirectory(''); }}>{labels[p]}</Button>)}</nav>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <p className="text-sm text-muted-foreground">Hermes profiles are shared native account contexts, not portal tenant boundaries. Project selection changes the active project for this entire profile and may affect other native clients.</p>
    {panel === 'projects' && <section aria-label="Project controls" className="space-y-3 rounded-md border p-3">
      {!nativeSession && <p className="text-sm" role="status">Open a saved Hermes chat first to enable confirmed project changes.</p>}
      {nativeSession && profile !== nativeSession.profile && <p className="text-sm" role="status">Project changes are available only for the selected chat’s profile ({nativeSession.profile}).</p>}
      <p className="text-sm text-muted-foreground">Changes require an idle selected chat. New projects are created empty; adding workspace folders is not available here.</p>
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (nativeSession && projectName.trim()) void projectRequest({ operation: 'prepare', action: 'create', name: projectName.trim() }); }}>
        <input aria-label="New project name" value={projectName} maxLength={80} onChange={e => setProjectName(e.target.value)} placeholder="Project name" className="rounded-md border bg-background px-3 py-2 text-sm" />
        <Button type="submit" variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || !projectName.trim() || mutating}>Review empty project creation</Button>
      </form>
      {prepared && <section role="region" aria-labelledby="project-confirm-title" aria-describedby="project-confirm-description" className="space-y-2 rounded-md border border-amber-500 p-3">
        <h3 id="project-confirm-title" className="font-medium">Confirm profile-wide project change</h3>
        <p id="project-confirm-description" className="text-sm">{prepared.action === 'create' ? `Create empty project “${prepared.name}”` : `Make “${prepared.name}” the active project`} in profile “{prepared.profile}”, reviewed from chat “{prepared.title}”. This profile is shared with other Hermes clients.</p>
        <div className="flex gap-2"><Button onClick={() => void projectRequest({ operation: 'confirm', confirmation: prepared.confirmation })} disabled={mutating}>Confirm project change</Button><Button variant="outline" onClick={() => setPrepared(null)} disabled={mutating}>Cancel</Button></div>
      </section>}
    </section>}
    {!profile && <p>No Hermes profiles are available.</p>}
    {profile && !error && !result && <p role="status">Loading {labels[panel].toLowerCase()}…</p>}
    {result && panel === 'files' && <div className="space-y-3"><div className="flex flex-wrap gap-2">{result.roots?.map(root => <Button key={root} variant="outline" onClick={() => { reset(); setDirectory(root); }}>{root}</Button>)}</div><p className="break-all text-sm">{result.directory}</p>
      {result.directory && result.roots && !result.roots.includes(result.directory) && <Button variant="outline" onClick={() => { reset(); setDirectory(result.directory!.slice(0, result.directory!.lastIndexOf('/')) || '/'); }}>Parent directory</Button>}
      <ul className="space-y-1">{result.entries?.map(e => <li key={e.path}>{e.directory ? <button className="text-sm underline" onClick={() => { reset(); setDirectory(e.path); }}>{e.name}/</button> : <span className="text-sm text-muted-foreground">{e.name}</span>}</li>)}</ul>{!result.entries?.length && <p>No visible entries.</p>}</div>}
    {rows && <div className="space-y-2">{rows.map((r, i) => <article className="rounded-md border p-3 text-sm" key={String(r.id ?? r.name ?? i)}>{Object.entries(r).map(([key, value]) => <div key={key} className="break-all"><span className="text-muted-foreground">{fieldLabel(key)}: </span>{Array.isArray(value) ? value.map((v: Row) => String(v.path)).join(', ') : typeof value === 'boolean' ? value ? 'yes' : 'no' : String(value ?? '—')}</div>)}{panel === 'projects' && <div className="mt-2 flex items-center gap-2">{result?.activeId === r.id && <span aria-current="true" className="text-xs text-muted-foreground">Active project</span>}{r.archived !== true && result?.activeId !== r.id && <Button variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating} onClick={() => void projectRequest({ operation: 'prepare', action: 'select', projectId: String(r.id) })}>Review as active project</Button>}</div>}</article>)}{!rows.length && <p>No {labels[panel].toLowerCase()} listed.</p>}</div>}
    {result && panel === 'system' && <dl className="grid gap-2 text-sm">{Object.entries(result).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{fieldLabel(key)}</dt><dd>{value && typeof value === 'object' ? Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${fieldLabel(k)}: ${k === 'percent' ? `${Number(v).toLocaleString()}%` : bytes(Number(v))}`).join(' · ') || 'Unavailable' : value === undefined || value === '' ? 'Unavailable' : String(value)}</dd></div>)}</dl>}
  </div>;
}
