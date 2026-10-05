'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';

type Panel = 'projects' | 'files' | 'schedules' | 'plugins' | 'system';
type Row = Record<string, unknown>;
type Result = { projects?: Row[]; schedules?: Row[]; plugins?: Row[]; entries?: { name: string; path: string; directory: boolean }[]; roots?: string[]; directory?: string; [key: string]: unknown };
const labels: Record<Panel, string> = { projects: 'Projects', files: 'Directories', schedules: 'Schedules', plugins: 'Plugins', system: 'System' };
const fieldLabels: Record<string, string> = { id: 'ID', nextRun: 'Next run', lastStatus: 'Last result', cpuCount: 'CPU cores', cpuPercent: 'CPU usage (%)', uptimeSeconds: 'Uptime (seconds)' };
const fieldLabel = (key: string) => fieldLabels[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2).toLocaleString()} MiB`;
export function NativeOperations({ connectionId, profiles }: { connectionId: string; profiles: RemoteHermesProfile[] }) {
  const [profile, setProfile] = useState(profiles[0]?.name ?? '');
  const [panel, setPanel] = useState<Panel>('projects');
  const [directory, setDirectory] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
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
  const rows = result?.projects ?? result?.schedules ?? result?.plugins;
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Select aria-label="Hermes workspace profile" value={profile} onChange={e => { reset(); setProfile(e.target.value); setDirectory(''); }}>{profiles.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</Select>
      <Button variant="outline" onClick={() => { reset(); setRevision(r => r + 1); }}>Refresh</Button></div>
    <nav aria-label="Hermes workspace panels" className="flex flex-wrap gap-2">{(Object.keys(labels) as Panel[]).map(p => <Button key={p} variant={panel === p ? 'primary' : 'outline'} onClick={() => { reset(); setPanel(p); setDirectory(''); }}>{labels[p]}</Button>)}</nav>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!profile && <p>No Hermes profiles are available.</p>}
    {profile && !error && !result && <p role="status">Loading {labels[panel].toLowerCase()}…</p>}
    {result && panel === 'files' && <div className="space-y-3"><div className="flex flex-wrap gap-2">{result.roots?.map(root => <Button key={root} variant="outline" onClick={() => { reset(); setDirectory(root); }}>{root}</Button>)}</div><p className="break-all text-sm">{result.directory}</p>
      {result.directory && result.roots && !result.roots.includes(result.directory) && <Button variant="outline" onClick={() => { reset(); setDirectory(result.directory!.slice(0, result.directory!.lastIndexOf('/')) || '/'); }}>Parent directory</Button>}
      <ul className="space-y-1">{result.entries?.map(e => <li key={e.path}>{e.directory ? <button className="text-sm underline" onClick={() => { reset(); setDirectory(e.path); }}>{e.name}/</button> : <span className="text-sm text-muted-foreground">{e.name}</span>}</li>)}</ul>{!result.entries?.length && <p>No visible entries.</p>}</div>}
    {rows && <div className="space-y-2">{rows.map((r, i) => <article className="rounded-md border p-3 text-sm" key={String(r.id ?? r.name ?? i)}>{Object.entries(r).map(([key, value]) => <div key={key} className="break-all"><span className="text-muted-foreground">{fieldLabel(key)}: </span>{Array.isArray(value) ? value.map((v: Row) => String(v.path)).join(', ') : typeof value === 'boolean' ? value ? 'yes' : 'no' : String(value ?? '—')}</div>)}</article>)}{!rows.length && <p>No {labels[panel].toLowerCase()} listed.</p>}</div>}
    {result && panel === 'system' && <dl className="grid gap-2 text-sm">{Object.entries(result).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{fieldLabel(key)}</dt><dd>{value && typeof value === 'object' ? Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${fieldLabel(k)}: ${k === 'percent' ? `${Number(v).toLocaleString()}%` : bytes(Number(v))}`).join(' · ') || 'Unavailable' : value === undefined || value === '' ? 'Unavailable' : String(value)}</dd></div>)}</dl>}
  </div>;
}
