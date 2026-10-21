'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/input';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';

type Panel = 'projects' | 'files' | 'schedules' | 'plugins' | 'plugin-selection' | 'system';
type Row = Record<string, unknown>;
type Result = { projects?: Row[]; activeId?: string; schedules?: Row[]; plugins?: Row[]; pluginSelection?: { name: string; selected: boolean | null; operatorSelected: boolean | null; startupSelected: boolean | null; loadedState: 'unreported' }; entries?: { name: string; path: string; directory: boolean }[]; workspaceId?: string; projectName?: string; available?: boolean; action?: 'list' | 'read'; path?: string; content?: string; sha256?: string; truncated?: boolean; [key: string]: unknown };
type EditDraft = { connectionId: string; profile: string; workspaceId: string; sessionId: string; path: string; sha256: string; content: string };
const labels: Record<Panel, string> = { projects: 'Projects', files: 'Directories', schedules: 'Schedules', plugins: 'Plugins', 'plugin-selection': 'Plugin preferences', system: 'System' };
const fieldLabels: Record<string, string> = { id: 'ID', nextRun: 'Next run', lastStatus: 'Last result', cpuCount: 'CPU cores', cpuPercent: 'CPU usage (%)', uptimeSeconds: 'Uptime (seconds)' };
const fieldLabel = (key: string) => fieldLabels[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2).toLocaleString()} MiB`;
type PreparedProject = { confirmation: string; action: 'create' | 'select' | 'schedule' | 'plugin-selection' | 'file-edit'; name?: string; enabled?: boolean; profile: string; title: string; content?: string; path?: string; bytes?: number; connectionId?: string; sessionId?: string; workspaceId?: string; expectedSha256?: string };
export function NativeOperations({ connectionId, profiles, nativeSession }: { connectionId: string; profiles: RemoteHermesProfile[]; nativeSession: { id: string; profile: string; title: string } | null }) {
  const [profile, setProfile] = useState(nativeSession?.profile ?? profiles[0]?.name ?? '');
  const [panel, setPanel] = useState<Panel>('projects');
  const [directory, setDirectory] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [resultScope, setResultScope] = useState('');
  const [error, setError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [prepared, setPrepared] = useState<PreparedProject | null>(null);
  const [mutating, setMutating] = useState(false);
  const sessionScope = JSON.stringify([connectionId, profile, nativeSession?.profile ?? null, nativeSession?.id ?? null]);
  const queryScope = JSON.stringify([sessionScope, panel, directory, selectedFile]);
  const currentResult = resultScope === queryScope ? result : null;
  const currentFileTarget = currentResult?.action === 'read' && nativeSession && profile === nativeSession.profile && currentResult.workspaceId && currentResult.path && currentResult.sha256
    ? { connectionId, profile, workspaceId: currentResult.workspaceId, sessionId: nativeSession.id, path: currentResult.path, sha256: currentResult.sha256 }
    : null;
  const preparedFileMatches = prepared?.action !== 'file-edit' || !!currentFileTarget && prepared.connectionId === currentFileTarget.connectionId &&
    prepared.profile === currentFileTarget.profile && prepared.workspaceId === currentFileTarget.workspaceId && prepared.sessionId === currentFileTarget.sessionId &&
    prepared.path === currentFileTarget.path && prepared.expectedSha256 === currentFileTarget.sha256;
  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ profile, panel,
      ...(panel === 'plugin-selection' && nativeSession ? { sessionId: nativeSession.id } : {}),
      ...(panel === 'files' && nativeSession ? { sessionId: nativeSession.id, action: selectedFile ? 'read' : 'list', ...(workspaceId ? { workspaceId } : {}), ...(selectedFile ? { path: selectedFile } : directory ? { path: directory } : {}) } : {}) });
    fetch(`/api/hermes/${encodeURIComponent(connectionId)}/operations?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Could not load this Hermes panel.'); return value as Result; })
      .then(value => { if (!controller.signal.aborted) { setResult(value); setResultScope(queryScope); setError(''); if (value.workspaceId) setWorkspaceId(value.workspaceId); } })
      .catch(e => { if (!controller.signal.aborted) { setResult(null); setResultScope(queryScope); setError(e instanceof Error ? e.message : 'Could not load this Hermes panel.'); } });
    return () => controller.abort();
  }, [connectionId, profile, panel, directory, workspaceId, selectedFile, nativeSession, revision, queryScope]);
  const reset = () => { setResult(null); setError(''); };
  async function projectRequest(input: { operation: 'prepare'; action: 'create'; name: string } | { operation: 'prepare'; action: 'select'; projectId: string } | { operation: 'prepare'; action: 'pause' | 'resume'; scheduleId: string } | { operation: 'prepare'; action: 'plugin-selection'; enabled: boolean } | { operation: 'confirm'; confirmation: string } | { operation: 'prepare'; action: 'file-edit'; workspaceId: string; path: string; expectedSha256: string; content: string } | { operation: 'confirm-file-edit'; confirmation: string; content: string }) {
    if (!nativeSession) return;
    if (input.operation === 'prepare' && input.action === 'file-edit' && (!currentFileTarget || input.workspaceId !== currentFileTarget.workspaceId || input.path !== currentFileTarget.path || input.expectedSha256 !== currentFileTarget.sha256)) {
      setError('The selected file belongs to a different workspace view. Reload it before reviewing an edit.'); return;
    }
    if (input.operation === 'confirm-file-edit' && (!prepared || prepared.action !== 'file-edit' || !preparedFileMatches || !currentFileTarget)) {
      setPrepared(null); setError('The workspace target changed after review. Reload the file and review the edit again.'); return;
    }
    setMutating(true); setError('');
    try {
      const response = await fetch(`/api/hermes/${encodeURIComponent(connectionId)}/operations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: nativeSession.id, input }), cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not change this Hermes project.');
      if (input.operation === 'prepare') {
        setPrepared({ confirmation: value.confirmation, action: input.action === 'file-edit' ? 'file-edit' : value.action, name: value.name, enabled: value.enabled, profile: value.profile, title: value.title,
          ...(input.action === 'file-edit' ? { connectionId, sessionId: nativeSession.id, workspaceId: input.workspaceId, expectedSha256: input.expectedSha256, path: input.path, content: input.content, bytes: value.bytes } : {}) });
      } else {
        setPrepared(null); setResult(value as Result); setProjectName(''); setRevision(r => r + 1);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change this Hermes project.'); }
    finally { setMutating(false); }
  }
  const editText = currentResult?.action === 'read' && typeof currentResult.path === 'string' && typeof currentResult.sha256 === 'string'
    ? editDraft?.connectionId === connectionId && editDraft.profile === profile && editDraft.workspaceId === currentResult.workspaceId &&
      editDraft.sessionId === nativeSession?.id && editDraft.path === currentResult.path && editDraft.sha256 === currentResult.sha256 ? editDraft.content : currentResult.content ?? ''
    : '';
  const rows = currentResult?.projects ?? currentResult?.schedules ?? currentResult?.plugins;
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Select aria-label="Hermes workspace profile" value={profile} onChange={e => { reset(); setPrepared(null); setEditDraft(null); setProfile(e.target.value); setDirectory(''); setWorkspaceId(''); setSelectedFile(''); }}>{profiles.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</Select>
      <Button variant="outline" onClick={() => { reset(); setRevision(r => r + 1); }}>Refresh</Button></div>
    <nav aria-label="Hermes workspace panels" className="flex flex-wrap gap-2">{(Object.keys(labels) as Panel[]).map(p => <Button key={p} variant={panel === p ? 'primary' : 'outline'} onClick={() => { reset(); setPrepared(null); setEditDraft(null); setPanel(p); setDirectory(''); setWorkspaceId(''); setSelectedFile(''); }}>{labels[p]}</Button>)}</nav>
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
    {panel === 'plugins' && <p className="text-sm text-muted-foreground">Inventory status describes native configuration, not whether a plugin is loaded. Runtime loaded state is unreported. Reviewed ordinary plugin selections are available separately under Plugin preferences.</p>}
    {panel === 'plugin-selection' && <section aria-label="Plugin selection controls" className="space-y-3 rounded-md border p-3">
      <p className="text-sm">This panel stores a pending selection separately from native configuration. Explicit local operator confirmation authorizes subsequent native initializations, including automatic worker starts, to use it. This panel never confirms locally, activates, reloads or restarts plugins. Runtime loaded state: unreported.</p>
      <p className="text-sm text-muted-foreground">Once confirmed locally, the operator selection overrides the native allow/deny selection for this reviewed package at initialization until an operator clears the separate preference. Native configuration files stay unchanged.</p>
      <p className="text-sm text-muted-foreground">Only the reviewed bundled teams_pipeline 0.1.0 package is eligible. Other packages, changed source, alias collisions and managed installs stay unsupported. All work in this native profile must be idle.</p>
      <p className="text-sm text-muted-foreground">Eligibility is checked again at initialization; changed or shadowed packages keep their native behavior.</p>
      {currentResult?.pluginSelection && <>
        <p>Stored preference for {currentResult.pluginSelection.name}: {currentResult.pluginSelection.selected === null ? 'follow native configuration' : currentResult.pluginSelection.selected ? 'pending enabled' : 'pending disabled'}.</p>
        <p className="text-sm">Operator-confirmed selection: {currentResult.pluginSelection.operatorSelected === null ? 'follow native configuration' : currentResult.pluginSelection.operatorSelected ? 'enabled' : 'disabled'}.</p>
        <p className="text-sm">Process-start selection: {currentResult.pluginSelection.startupSelected === null ? 'follow native configuration' : currentResult.pluginSelection.startupSelected ? 'enabled' : 'disabled'}. This is not proof of loaded state.</p>
        <div className="flex flex-wrap gap-2">{[true, false].map(enabled => <Button key={String(enabled)} variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating || currentResult.pluginSelection?.selected === enabled}
          onClick={() => void projectRequest({ operation: 'prepare', action: 'plugin-selection', enabled })}>Review {enabled ? 'enable' : 'disable'} preference</Button>)}</div>
      </>}
    </section>}
    {prepared && preparedFileMatches && <section role="region" aria-labelledby="project-confirm-title" aria-describedby="project-confirm-description" className="space-y-2 rounded-md border border-amber-500 p-3">
      <h3 id="project-confirm-title" className="font-medium">{prepared.action === 'file-edit' ? 'Confirm workspace file save' : 'Confirm profile-wide Hermes change'}</h3>
      <p id="project-confirm-description" className="text-sm">{prepared.action === 'file-edit' ? `Save the reviewed ${prepared.bytes ?? 0}-byte edit to “${prepared.path}” in project “${currentResult?.projectName}” from chat “${prepared.title}”. The current file digest is checked again, and this confirmation is sent once. If the outcome is unclear, reload the file before another edit.` : prepared.action === 'create' ? `Create empty project “${prepared.name}”` : prepared.action === 'select' ? `Make “${prepared.name}” the active project` : prepared.action === 'plugin-selection' ? `Store the ${prepared.enabled ? 'enabled' : 'disabled'} preference for “${prepared.name}”. It stays pending until explicit local operator confirmation authorizes later native initializations, including automatic worker starts; no plugin will be activated or reloaded here, and loaded state remains unreported` : `${prepared.enabled ? 'Resume' : 'Pause'} schedule “${prepared.name}”`}{prepared.action === 'schedule' && prepared.enabled ? '; it may run soon and use model usage' : ''}{prepared.action !== 'file-edit' && <> in profile “{prepared.profile}”, reviewed from chat “{prepared.title}”. This profile is shared with other Hermes clients.</>}</p>
      <div className="flex gap-2"><Button onClick={() => void (prepared.action === 'file-edit' ? projectRequest({ operation: 'confirm-file-edit', confirmation: prepared.confirmation, content: prepared.content ?? '' }) : projectRequest({ operation: 'confirm', confirmation: prepared.confirmation }))} disabled={mutating}>Confirm {prepared.action === 'file-edit' ? 'file save' : 'Hermes change'}</Button><Button variant="outline" onClick={() => setPrepared(null)} disabled={mutating}>Cancel</Button></div>
    </section>}
    {!profile && <p>No Hermes profiles are available.</p>}
    {profile && !error && !currentResult && <p role="status">Loading {labels[panel].toLowerCase()}…</p>}
    {currentResult && panel === 'files' && <div className="space-y-3">{currentResult.available === false ? <p role="status">No eligible, explicitly selected local project workspace is available for this chat.</p> : <>
      <p className="text-sm text-muted-foreground">Small text files in {currentResult.projectName}. Only the selected chat’s persisted local project workspace is available; hidden and sensitive paths stay excluded.</p>
      {currentResult.action === 'read' ? <><div className="flex items-center gap-2"><Button variant="outline" onClick={() => { reset(); setPrepared(null); setEditDraft(null); setSelectedFile(''); }}>Back to files</Button><span className="break-all text-sm">{currentResult.path}</span></div>
        <Textarea key={`${connectionId}:${profile}:${currentResult.workspaceId}:${nativeSession?.id}:${currentResult.path}:${currentResult.sha256}`} aria-label={`Edit ${currentResult.path}`} value={editText} maxLength={256 * 1024} rows={20} disabled={!nativeSession || profile !== nativeSession.profile || mutating} onChange={event => { setEditDraft({ connectionId, profile, workspaceId: currentResult.workspaceId!, sessionId: nativeSession!.id, path: currentResult.path!, sha256: currentResult.sha256!, content: event.target.value }); setPrepared(current => current?.action === 'file-edit' ? null : current); }} />
        <p className="text-xs text-muted-foreground">Existing UTF-8 files only, up to 256 KiB. Saving requires a fresh content-digest match; the editor will not create files or retry an uncertain write.</p>
        <Button variant="outline" disabled={!currentFileTarget || mutating || editText === currentResult.content} onClick={() => void projectRequest({ operation: 'prepare', action: 'file-edit', workspaceId: currentResult.workspaceId!, path: currentResult.path!, expectedSha256: currentResult.sha256!, content: editText })}>Review save</Button></>
        : <><div className="flex items-center gap-2"><span className="break-all text-sm">{currentResult.path || '.'}</span>{currentResult.path && currentResult.path !== '.' && <Button variant="outline" onClick={() => { reset(); setPrepared(null); setEditDraft(null); setSelectedFile(''); setDirectory(currentResult.path!.includes('/') ? currentResult.path!.slice(0, currentResult.path!.lastIndexOf('/')) : '.'); }}>Parent directory</Button>}</div>
          <ul className="space-y-1">{currentResult.entries?.map(e => <li key={e.path}>{e.directory ? <button className="text-sm underline" onClick={() => { reset(); setPrepared(null); setEditDraft(null); setSelectedFile(''); setDirectory(e.path); }}>{e.name}/</button> : <button className="text-sm text-muted-foreground underline" onClick={() => { reset(); setPrepared(null); setEditDraft(null); setSelectedFile(e.path); }}>{e.name}</button>}</li>)}</ul>{!currentResult.entries?.length && <p>No visible entries.</p>}{currentResult.truncated && <p className="text-sm text-muted-foreground">Showing the first 100 visible entries.</p>}</>}
    </>}</div>}
    {rows && <div className="space-y-2">{rows.map((r, i) => <article className="rounded-md border p-3 text-sm" key={String(r.id ?? r.name ?? i)}>{Object.entries(r).map(([key, value]) => <div key={key} className="break-all"><span className="text-muted-foreground">{fieldLabel(key)}: </span>{Array.isArray(value) ? value.map((v: Row) => String(v.path)).join(', ') : typeof value === 'boolean' ? value ? 'yes' : 'no' : String(value ?? '—')}</div>)}{panel === 'projects' && <div className="mt-2 flex items-center gap-2">{result?.activeId === r.id && <span aria-current="true" className="text-xs text-muted-foreground">Active project</span>}{r.archived !== true && result?.activeId !== r.id && <Button variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating} onClick={() => void projectRequest({ operation: 'prepare', action: 'select', projectId: String(r.id) })}>Review as active project</Button>}</div>}{panel === 'schedules' && (r.state === 'scheduled' || r.state === 'paused' || r.state === 'error') && <div className="mt-2"><Button variant="outline" disabled={!nativeSession || profile !== nativeSession.profile || mutating} onClick={() => void projectRequest({ operation: 'prepare', action: r.state === 'scheduled' ? 'pause' : 'resume', scheduleId: String(r.id) })}>Review {r.state === 'scheduled' ? 'pause' : 'resume'}</Button></div>}</article>)}{!rows.length && <p>No {labels[panel].toLowerCase()} listed.</p>}</div>}
    {currentResult && panel === 'system' && <dl className="grid gap-2 text-sm">{Object.entries(currentResult).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{fieldLabel(key)}</dt><dd>{value && typeof value === 'object' ? Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${fieldLabel(k)}: ${k === 'percent' ? `${Number(v).toLocaleString()}%` : bytes(Number(v))}`).join(' · ') || 'Unavailable' : value === undefined || value === '' ? 'Unavailable' : String(value)}</dd></div>)}</dl>}
  </div>;
}
