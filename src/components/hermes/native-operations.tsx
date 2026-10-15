'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/input';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';

type Panel = 'projects' | 'files' | 'schedules' | 'plugins' | 'system';
type Row = Record<string, unknown>;
type Result = { projects?: Row[]; activeId?: string; schedules?: Row[]; plugins?: Row[]; entries?: { name: string; path: string; directory: boolean }[]; workspaceId?: string; projectName?: string; available?: boolean; action?: 'list' | 'read'; path?: string; content?: string; sha256?: string; truncated?: boolean; [key: string]: unknown };
const labels: Record<Panel, string> = { projects: 'Projects', files: 'Directories', schedules: 'Schedules', plugins: 'Plugins', system: 'System' };
const fieldLabels: Record<string, string> = { id: 'ID', nextRun: 'Next run', lastStatus: 'Last result', cpuCount: 'CPU cores', cpuPercent: 'CPU usage (%)', uptimeSeconds: 'Uptime (seconds)' };
const fieldLabel = (key: string) => fieldLabels[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2).toLocaleString()} MiB`;
type PreparedProject = { confirmation: string; action: 'create' | 'select' | 'schedule' | 'file-edit'; name?: string; enabled?: boolean; profile: string; title: string; content?: string; path?: string; bytes?: number };
export function NativeOperations({ connectionId, profiles, nativeSession }: { connectionId: string; profiles: RemoteHermesProfile[]; nativeSession: { id: string; profile: string; title: string } | null }) {
  const [profile, setProfile] = useState(nativeSession?.profile ?? profiles[0]?.name ?? '');
  const [panel, setPanel] = useState<Panel>('projects');
  const [directory, setDirectory] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [editDraft, setEditDraft] = useState<{ path: string; sha256: string; content: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [prepared, setPrepared] = useState<PreparedProject | null>(null);
  const [mutating, setMutating] = useState(false);
  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ profile, panel,
      ...(panel === 'files' && nativeSession ? { sessionId: nativeSession.id, action: selectedFile ? 'read' : 'list', ...(workspaceId ? { workspaceId } : {}), ...(selectedFile ? { path: selectedFile } : directory ? { path: directory } : {}) } : {}) });
    fetch(`/api/hermes/${encodeURIComponent(connectionId)}/operations?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Could not load this Hermes panel.'); return value as Result; })
      .then(value => { if (!controller.signal.aborted) { setResult(value); setError(''); if (value.workspaceId) setWorkspaceId(value.workspaceId); } })
      .catch(e => { if (!controller.signal.aborted) { setResult(null); setError(e instanceof Error ? e.message : 'Could not load this Hermes panel.'); } });
    return () => controller.abort();
  }, [connectionId, profile, panel, directory, workspaceId, selectedFile, nativeSession, revision]);
  const reset = () => { setResult(null); setError(''); };
  async function projectRequest(input: { operation: 'prepare'; action: 'create'; name: string } | { operation: 'prepare'; action: 'select'; projectId: string } | { operation: 'prepare'; action: 'pause' | 'resume'; scheduleId: string } | { operation: 'confirm'; confirmation: string } | { operation: 'prepare'; action: 'file-edit'; workspaceId: string; path: string; expectedSha256: string; content: string } | { operation: 'confirm-file-edit'; confirmation: string; content: string }) {
    if (!nativeSession) return;
    setMutating(true); setError('');
    try {
      const response = await fetch(`/api/hermes/${encodeURIComponent(connectionId)}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: nativeSession.id, input }), cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not change this Hermes project.');
      if (input.operation === 'prepare') {
        setPrepared({ confirmation: value.confirmation, action: value.action, name: value.name, enabled: value.enabled, profile: value.profile, title: value.title,
          ...(input.action === 'file-edit' ? { path: input.path, content: input.content, bytes: value.bytes } : {}) });
      } else {
        setPrepared(null); setResult(value as Result); setProjectName(''); setRevision(r => r + 1);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change this Hermes project.'); }
    finally { setMutating(false); }
  }
  const editText = result?.action === 'read' && typeof result.path === 'string' && typeof result.sha256 === 'string'
    ? editDraft?.path === result.path && editDraft.sha256 === result.sha256 ? editDraft.content : result.content ?? ''
    : '';
  const rows = result?.projects ?? result?.schedules ?? result?.plugins;
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Select aria-label="Hermes workspace profile" value={profile} onChange={e => { reset(); setPrepared(null); setProfile(e.target.value); setDirectory(''); setWorkspaceId(''); setSelectedFile(''); }}>{profiles.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</Select>
      <Button variant="outline" onClick={() => { reset(); setRevision(r => r + 1); }}>Refresh</Button></div>
    <nav aria-label="Hermes workspace panels" className="flex flex-wrap gap-2">{(Object.keys(labels) as Panel[]).map(p => <Button key={p} variant={panel === p ? 'primary' : 'outline'} onClick={() => { reset(); setPanel(p); setDirectory(''); setWorkspaceId(''); setSelectedFile(''); }}>{labels[p]}</Button>)}</nav>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <p className="text-sm text-muted-foreground">Hermes profiles are shared native account contexts, not portal tenant boundaries. Project selection changes the active project for this entire profile and may affect other native clients.</p>
    {panel === 'projects' && <section aria-label="Project controls" className="space-y-3 rounded-md border p-3">
      {!nativeSession && <p className="text-sm" role="status">Open a saved Hermes chat first to enable confirmed project changes.</p>}
      {nativeSession && profile !== nativeSession.profile && <p className="text-sm" role="status">Confirmed changes are available only for the selected chat’s profile ({nativeSession.profile}).</p>}
      <p className="text-sm text-muted-foreground">Changes require an idle selected chat. New projects are created empty; adding workspace folders is not available here. Schedule resumption can run soon and use model usage.</p>
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (nativeSession && projectName.trim()) void projectRequest({ operation: 'prepare', action: 'create', name: projectName.trim() }); }}>
        <input aria-label="New project name" value={projectName} maxLength={80} onChange={e => setProjectName(e.target.value)} placeholder="Project name" className="rounded-md border bg-background px-3 py-2 text-sm" />
        <Button type="submit" variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || !projectName.trim() || mutating}>Review empty project creation</Button>
      </form>
    </section>}
    {prepared && <section role="region" aria-labelledby="project-confirm-title" aria-describedby="project-confirm-description" className="space-y-2 rounded-md border border-amber-500 p-3">
      <h3 id="project-confirm-title" className="font-medium">{prepared.action === 'file-edit' ? 'Confirm workspace file save' : 'Confirm profile-wide Hermes change'}</h3>
      <p id="project-confirm-description" className="text-sm">{prepared.action === 'file-edit' ? `Save the reviewed ${prepared.bytes ?? 0}-byte edit to “${prepared.path}” in project “${result?.projectName}” from chat “${prepared.title}”. The current file digest is checked again, and this confirmation is sent once. If the outcome is unclear, reload the file before another edit.` : prepared.action === 'create' ? `Create empty project “${prepared.name}”` : prepared.action === 'select' ? `Make “${prepared.name}” the active project` : `${prepared.enabled ? 'Resume' : 'Pause'} schedule “${prepared.name}”`}{prepared.action !== 'file-edit' && prepared.enabled ? '; it may run soon and use model usage' : ''}{prepared.action !== 'file-edit' && <> in profile “{prepared.profile}”, reviewed from chat “{prepared.title}”. This profile is shared with other Hermes clients.</>}</p>
      <div className="flex gap-2"><Button onClick={() => void (prepared.action === 'file-edit' ? projectRequest({ operation: 'confirm-file-edit', confirmation: prepared.confirmation, content: prepared.content ?? '' }) : projectRequest({ operation: 'confirm', confirmation: prepared.confirmation }))} disabled={mutating}>Confirm {prepared.action === 'file-edit' ? 'file save' : 'Hermes change'}</Button><Button variant="outline" onClick={() => setPrepared(null)} disabled={mutating}>Cancel</Button></div>
    </section>}
    {!profile && <p>No Hermes profiles are available.</p>}
    {profile && !error && !result && <p role="status">Loading {labels[panel].toLowerCase()}…</p>}
    {result && panel === 'files' && <div className="space-y-3">{result.available === false ? <p role="status">No eligible, explicitly selected local project workspace is available for this chat.</p> : <>
      <p className="text-sm text-muted-foreground">Small text files in {result.projectName}. Only the selected chat’s persisted local project workspace is available; hidden and sensitive paths stay excluded.</p>
      {result.action === 'read' ? <><div className="flex items-center gap-2"><Button variant="outline" onClick={() => { reset(); setPrepared(null); setSelectedFile(''); }}>Back to files</Button><span className="break-all text-sm">{result.path}</span></div>
        <Textarea aria-label={`Edit ${result.path}`} value={editText} maxLength={256 * 1024} rows={20} disabled={!nativeSession || profile !== nativeSession.profile || mutating} onChange={event => { setEditDraft({ path: result.path!, sha256: result.sha256!, content: event.target.value }); setPrepared(current => current?.action === 'file-edit' ? null : current); }} />
        <p className="text-xs text-muted-foreground">Existing UTF-8 files only, up to 256 KiB. Saving requires a fresh content-digest match; the editor will not create files or retry an uncertain write.</p>
        <Button variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating || !result.workspaceId || !result.sha256 || editText === result.content} onClick={() => void projectRequest({ operation: 'prepare', action: 'file-edit', workspaceId: result.workspaceId!, path: result.path!, expectedSha256: result.sha256!, content: editText })}>Review save</Button></>
        : <><div className="flex items-center gap-2"><span className="break-all text-sm">{result.path || '.'}</span>{result.path && result.path !== '.' && <Button variant="outline" onClick={() => { reset(); setSelectedFile(''); setDirectory(result.path!.includes('/') ? result.path!.slice(0, result.path!.lastIndexOf('/')) : '.'); }}>Parent directory</Button>}</div>
          <ul className="space-y-1">{result.entries?.map(e => <li key={e.path}>{e.directory ? <button className="text-sm underline" onClick={() => { reset(); setSelectedFile(''); setDirectory(e.path); }}>{e.name}/</button> : <button className="text-sm text-muted-foreground underline" onClick={() => { reset(); setSelectedFile(e.path); }}>{e.name}</button>}</li>)}</ul>{!result.entries?.length && <p>No visible entries.</p>}{result.truncated && <p className="text-sm text-muted-foreground">Showing the first 100 visible entries.</p>}</>}
    </>}</div>}
    {rows && <div className="space-y-2">{rows.map((r, i) => <article className="rounded-md border p-3 text-sm" key={String(r.id ?? r.name ?? i)}>{Object.entries(r).map(([key, value]) => <div key={key} className="break-all"><span className="text-muted-foreground">{fieldLabel(key)}: </span>{Array.isArray(value) ? value.map((v: Row) => String(v.path)).join(', ') : typeof value === 'boolean' ? value ? 'yes' : 'no' : String(value ?? '—')}</div>)}{panel === 'projects' && <div className="mt-2 flex items-center gap-2">{result?.activeId === r.id && <span aria-current="true" className="text-xs text-muted-foreground">Active project</span>}{r.archived !== true && result?.activeId !== r.id && <Button variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating} onClick={() => void projectRequest({ operation: 'prepare', action: 'select', projectId: String(r.id) })}>Review as active project</Button>}</div>}{panel === 'schedules' && (r.state === 'scheduled' || r.state === 'paused' || r.state === 'error') && <div className="mt-2"><Button variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating} onClick={() => void projectRequest({ operation: 'prepare', action: r.state === 'scheduled' ? 'pause' : 'resume', scheduleId: String(r.id) })}>Review {r.state === 'scheduled' ? 'pause' : 'resume'}</Button></div>}</article>)}{!rows.length && <p>No {labels[panel].toLowerCase()} listed.</p>}</div>}
    {result && panel === 'system' && <dl className="grid gap-2 text-sm">{Object.entries(result).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{fieldLabel(key)}</dt><dd>{value && typeof value === 'object' ? Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${fieldLabel(k)}: ${k === 'percent' ? `${Number(v).toLocaleString()}%` : bytes(Number(v))}`).join(' · ') || 'Unavailable' : value === undefined || value === '' ? 'Unavailable' : String(value)}</dd></div>)}</dl>}
  </div>;
}
