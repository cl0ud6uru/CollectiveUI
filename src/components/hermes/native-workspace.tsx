'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/chat/markdown';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';
import type { NativePrompt, NativeSessionView } from '@/lib/remote-hermes/view';
import { NativeAdministration } from './native-administration';
import { parseNativeInput, type NativeCommandCatalog } from '@/lib/remote-hermes/commands';
import { insertCommandIntoDraft } from '@/lib/chat/composer-commands';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { sessionYoloCompatible, yoloStatusText, type YoloConfirmation } from '@/lib/remote-hermes/yolo-contract';

type Saved = { id: string; storedId: string; title: string; profile: string; status: string };
type Snapshot = NativeSessionView & { admissionAllowed: boolean; yoloAllowed?: boolean };
type Browse = { sessions: { id: string; title?: string; offset?: number }[]; linked: Saved[]; nextOffset?: number; hasMore?: boolean };
type Operation = Record<string, unknown>;

export function NativeWorkspace({ connectionId, profiles, saved, allowed, initialSession, initialError }: {
  connectionId: string; profiles: RemoteHermesProfile[]; saved: Saved[]; allowed: boolean; initialSession: string | null; initialError: string;
}) {
  const [profile, setProfile] = useState(saved.find(s => s.id === initialSession)?.profile ?? profiles[0]?.name ?? saved[0]?.profile ?? 'default');
  const [sessionId, setSessionId] = useState(initialSession);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [browse, setBrowse] = useState<Browse>({ sessions: [], linked: saved });
  const [older, setOlder] = useState<NativeSessionView['messages']>([]);
  const [historyOffset, setHistoryOffset] = useState(0); const [historyMore, setHistoryMore] = useState(true);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [text, setText] = useState(''); const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState(initialError); const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<{ title: string; text: string } | null>(null);
  const [catalog, setCatalog] = useState<NativeCommandCatalog | null>(null);
  const [showCommands, setShowCommands] = useState(false); const [commandSearch, setCommandSearch] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [yoloDialog, setYoloDialog] = useState<{ confirmation?: YoloConfirmation } | null>(null);
  const [yoloError, setYoloError] = useState('');
  const [yoloExpired, setYoloExpired] = useState(false);
  const yoloGeneration = useRef(0);
  const yoloDraft = useRef<string | null>(null);
  const commandAttempt = useRef<{ key: string; attachments: File[]; requestId: string } | null>(null);
  const actionPending = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const endpoint = `/api/hermes/${encodeURIComponent(connectionId)}`;
  const enabled = snapshot?.admissionAllowed ?? allowed;
  const request = useCallback(async (input: Operation, attachments: File[] = [], suffix = '') => {
    let response: Response;
    if (attachments.length) {
      const body = new FormData(); body.set('request', JSON.stringify(input));
      attachments.forEach(file => body.append('files', file));
      response = await fetch(endpoint, { method: 'POST', body });
    } else response = await fetch(endpoint + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Hermes could not complete this operation.');
    return data;
  }, [endpoint]);
  const loadBrowse = useCallback(async (signal?: AbortSignal, offset = 0) => {
    if (!allowed) return;
    const generation = selection.current;
    const response = await fetch(`${endpoint}?${new URLSearchParams({ operation: 'browse', profile, offset: String(offset) })}`, { cache: 'no-store', signal });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load Hermes conversations.');
    if (!signal?.aborted && generation === selection.current) setBrowse(previous => ({ ...data, sessions: offset ? [...previous.sessions, ...data.sessions.filter((item: { id: string }) => !previous.sessions.some(s => s.id === item.id)).map((item: { id: string }) => ({ ...item, offset }))] : data.sessions.map((item: { id: string }) => ({ ...item, offset })) }));
  }, [allowed, endpoint, profile]);
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => { void loadBrowse(abort.signal).catch(e => { if (!abort.signal.aborted) setError(e.message); }); }, 0);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [loadBrowse]);
  useEffect(() => {
    if (!sessionId) return;
    const generation = selection.current;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`${endpoint}?${new URLSearchParams({ operation: 'snapshot', sessionId: sessionId! })}`, { cache: 'no-store', signal: abort.signal });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not recover this Hermes conversation.');
        if (!abort.signal.aborted && generation === selection.current) setSnapshot(data);
      } catch (e) { if (!abort.signal.aborted && generation === selection.current) setError(e instanceof Error ? e.message : 'Connection interrupted.'); }
      finally { if (!abort.signal.aborted && generation === selection.current) timer = setTimeout(poll, document.hidden ? 5000 : 1000); }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [endpoint, sessionId]);
  useEffect(() => {
    if (!sessionId || !allowed) return;
    const abort = new AbortController(), generation = selection.current;
    void fetch(`${endpoint}?${new URLSearchParams({ operation: 'catalog', sessionId })}`, { cache: 'no-store', signal: abort.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Hermes command discovery is unavailable.');
        if (!abort.signal.aborted && generation === selection.current) setCatalog(data); })
      .catch(e => { if (!abort.signal.aborted && generation === selection.current) setError(e.message); });
    return () => abort.abort();
  }, [allowed, endpoint, sessionId]);
  async function action(input: Operation, attachments: File[] = [], suffix = '') {
    if (actionPending.current || busy) return;
    actionPending.current = true;
    const generation = selection.current;
    setBusy(true); setError('');
    try { const result = await request({ sessionId, ...input }, attachments, suffix); return generation === selection.current ? result : undefined; }
    catch (e) { if (generation === selection.current) setError(e instanceof Error ? e.message : 'Hermes operation failed.'); }
    finally { actionPending.current = false; setBusy(false); }
  }
  function select(id: string | null, selectedProfile = profile) {
    selection.current++;
    setOlder([]); setHistoryOffset(0); setHistoryMore(true); setHistoryBusy(false);
    setSnapshot(null); setSessionId(id); setProfile(selectedProfile); setDetails(null); setError('');
    setCatalog(null); setShowCommands(false); setCommandSearch(''); setCommandIndex(0); commandAttempt.current = null;
    closeYolo();
    setText(''); setFiles([]); if (fileInput.current) fileInput.current.value = '';
    if (selectedProfile !== profile) setBrowse({ sessions: [], linked: saved });
    const url = new URL(location.href);
    if (id) url.searchParams.set('session', id); else url.searchParams.delete('session');
    history.replaceState(null, '', url);
  }
  async function open(storedId?: string, offset = 0) {
    const result = await action({ operation: 'open', profile, storedId, offset });
    if (result?.id) { select(result.id); setSnapshot({ ...result, admissionAllowed: enabled }); await loadBrowse().catch(() => {}); }
  }
  async function send(operation: 'submit' | 'steer' | 'queue' | 'command') {
    if (operation === 'command' && files.length) { setError('Remove attachments before running a command. Your draft and files have been kept.'); return; }
    if (parseNativeInput(text).kind === 'shell') { setError('! is CLI shell syntax, not a remote command. Use /yolo to inspect approval status.'); return; }
    const parsed = parseNativeInput(text);
    if (operation === 'command' && parsed.name === '/yolo' && ['', 'status', 'on', 'off'].includes(parsed.args ?? '')) {
      setShowCommands(false); setYoloError(''); setError(''); yoloDraft.current = text;
      if (parsed.args === 'on' || parsed.args === 'off') await prepareYolo(parsed.args);
      else setYoloDialog({});
      return;
    }
    const key = `${sessionId}:${operation}:${text}`;
    if (commandAttempt.current?.key !== key || commandAttempt.current.attachments !== files) commandAttempt.current = { key, attachments: files, requestId: crypto.randomUUID() };
    const result = await action({ operation, text, requestId: commandAttempt.current.requestId }, operation === 'submit' ? files : []);
    if (result) {
      commandAttempt.current = null; setShowCommands(false);
      setText(typeof result.prefill === 'string' ? result.prefill : '');
      if (operation === 'submit') { setFiles([]); if (fileInput.current) fileInput.current.value = ''; }
      if (result.output) setDetails({ title: 'Hermes command', text: typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2) });
    }
  }
  function closeYolo() { ++yoloGeneration.current; setYoloDialog(null); setYoloError(''); yoloDraft.current = null; }
  const yoloReady = !!snapshot?.yoloAllowed && sessionYoloCompatible(snapshot) && !snapshot.running && !snapshot.uncertain && !snapshot.queuePending && !snapshot.queued && !snapshot.prompts.length && enabled;
  async function prepareYolo(value: 'on' | 'off') {
    const generation = ++yoloGeneration.current;
    setYoloDialog({}); setYoloError(''); setYoloExpired(false);
    if (!yoloReady) { setYoloError('Session changes are unavailable. Check the administrator policy, runtime compatibility and pending work.'); return; }
    const result = await action({ input: { operation: 'prepare', value } }, [], '/yolo');
    if (generation === yoloGeneration.current && result?.confirmation) setYoloDialog({ confirmation: result as YoloConfirmation });
  }
  async function confirmYolo() {
    const confirmation = yoloDialog?.confirmation;
    if (!confirmation || !yoloReady || yoloExpired) return;
    const generation = yoloGeneration.current;
    const result = await action({ input: { operation: 'confirm', confirmation: confirmation.confirmation } }, [], '/yolo');
    if (generation === yoloGeneration.current && result) {
      const initiatingDraft = yoloDraft.current;
      closeYolo(); if (initiatingDraft !== null && text === initiatingDraft) setText(''); commandAttempt.current = null;
      setDetails({ title: 'Hermes session approval mode', text: result.output });
      if (typeof result.effectiveBypass === 'boolean') setSnapshot(s => s ? { ...s, yolo: result.effectiveBypass } : s);
    }
  }
  useEffect(() => {
    const expiresAt = yoloDialog?.confirmation?.expiresAt;
    if (!expiresAt) return;
    const timer = setTimeout(() => setYoloExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [yoloDialog]);
  async function loadOlder() {
    if (!sessionId || historyBusy) return;
    setHistoryBusy(true); setError('');
    const generation = selection.current;
    try {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ operation: 'history', sessionId, offset: String(historyOffset) })}`, { cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load older messages.');
      // A returned-to chat is a new selection too; discard its departed request.
      if (generation !== selection.current) return;
      setOlder(previous => [...data.messages.filter((m: { id: string }) => !previous.some(p => p.id === m.id)), ...previous]);
      setHistoryOffset(data.nextOffset); setHistoryMore(data.hasMore);
    } catch (e) { if (generation === selection.current) setError(e instanceof Error ? e.message : 'Could not load older messages.'); }
    finally { if (generation === selection.current) setHistoryBusy(false); }
  }
  async function inspect(operation: 'catalog' | 'context') {
    if (!sessionId) return;
    const generation = selection.current;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ operation, sessionId })}`, { cache: 'no-store' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'This Hermes feature is unavailable.');
      if (generation === selection.current) {
        if (operation === 'catalog') { setCatalog(data); setShowCommands(true); }
        else setDetails({ title: 'Hermes context', text: JSON.stringify(data, null, 2) });
      }
    } catch (e) { if (generation === selection.current) setError(e instanceof Error ? e.message : 'Could not load Hermes information.'); }
    finally { setBusy(false); }
  }
  const parsed = parseNativeInput(text);
  const isCommand = parsed.kind === 'command' || text.trim() === '/';
  const canonicalCommand = catalog?.aliases?.[parsed.name ?? ''] ?? parsed.name;
  const activeCommand = isCommand && ['/stop', '/context', '/commands', '/yolo', '/approvals'].includes(canonicalCommand ?? '');
  const commandMatches = (catalog?.commands ?? []).filter(c => c.value.includes(isCommand ? (parsed.name ?? '/') : '/') && `${c.value} ${c.description}`.toLowerCase().includes(commandSearch.toLowerCase()));
  const completionMatches = commandMatches.filter(c => c.available && (!snapshot?.running || ['/stop', '/context', '/commands', '/yolo', '/approvals'].includes(c.value)));
  function chooseCommand(value: string) {
    const entry = catalog?.commands.find(c => c.value === value);
    if (!entry?.available || busy || !enabled || snapshot?.uncertain || (snapshot?.running && !['/stop', '/context', '/commands', '/yolo', '/approvals'].includes(value))) return;
    setText(insertCommandIntoDraft(text, value)); setShowCommands(false); setCommandSearch(''); setCommandIndex(0); textarea.current?.focus();
  }
  function sendDraft() { void send(isCommand ? 'command' : 'submit'); }
  return <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
    <aside className="space-y-3">
      <Link href="/hermes" className="text-sm text-muted underline">All Hermes connections</Link>
      <Select aria-label="Hermes profile" value={profile} disabled={busy || !enabled} onChange={e => select(null, e.target.value)}>
        {(profiles.length ? profiles : [...new Set(saved.map(s => s.profile))].map(name => ({ name, botTitle: '' }))).map(p => <option key={p.name} value={p.name}>{p.botTitle || p.name}</option>)}
      </Select>
      <Button disabled={busy || !enabled} onClick={() => void open()}>New Hermes chat</Button>
      <nav aria-label="Hermes conversations" className="max-h-[65vh] space-y-1 overflow-y-auto">
        {browse.linked.filter(s => s.profile === profile).map(s => <button key={s.id} disabled={busy} className={`block w-full rounded-lg p-2 text-left text-sm hover:bg-hover ${sessionId === s.id ? 'bg-surface-2' : ''}`} onClick={() => select(s.id, s.profile)}>{s.title || 'Hermes chat'}{s.status !== 'idle' && <span className="block text-xs text-muted">In progress</span>}</button>)}
        {browse.sessions.filter(s => !browse.linked.some(l => l.storedId === s.id)).map(s => <button key={s.id} disabled={busy || !enabled} className="block w-full rounded-lg p-2 text-left text-sm hover:bg-hover disabled:opacity-50" onClick={() => void open(s.id, s.offset ?? 0)}>{s.title || 'Saved Hermes chat'}</button>)}
      </nav>
      {browse.hasMore && <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => {
        setBusy(true); void loadBrowse(undefined, browse.nextOffset).catch(e => setError(e.message)).finally(() => setBusy(false));
      }}>Load more chats</Button>}
    </aside>
    <section className="min-w-0 space-y-4">
      {!enabled && <p role="status" className="rounded-lg border border-border p-3 text-sm">Personal remote Hermes is disabled. Active turns can finish; you can still answer their prompts or stop them.</p>}
      {error && <p role="alert" className="rounded-lg border border-danger p-3 text-sm">{error}</p>}
      {!sessionId ? <p className="text-muted">Choose a conversation or start a new Hermes chat.</p> : !snapshot ? <p role="status">Opening Hermes conversation…</p> : <>
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">{snapshot.title}</h2><span className="text-xs text-muted">{snapshot.model} · {snapshot.connection}</span>
          {(snapshot.yolo === true || snapshot.approvalMode === 'off') && <span role="status" className="text-sm text-danger">Hermes effective approval bypass is active</span>}
          <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => { yoloDraft.current = null; setError(''); setYoloError(''); setYoloDialog({}); }}>Approval mode</Button>
          <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => void inspect('catalog')}>Commands &amp; skills</Button>
          <Button size="sm" variant="outline" disabled={busy || !enabled} onClick={() => void inspect('context')}>Context</Button>
          {(snapshot.running || snapshot.uncertain) && <Button size="sm" variant="danger" disabled={busy} onClick={() => void action({ operation: 'stop' })}>Stop</Button>}
        </header>
        <NativeAdministration key={sessionId} connectionId={connectionId} sessionId={sessionId} allowed={enabled} running={snapshot.running || snapshot.uncertain || snapshot.queuePending || !!snapshot.queued} />
        {Object.keys(snapshot.usage).length > 0 && <p className="text-xs text-muted">{Object.entries(snapshot.usage).map(([k, v]) => `${k.replaceAll('_', ' ')}: ${v}`).join(' · ')}</p>}
        {snapshot.uncertain && <p role="status" className="text-sm">Hermes has not confirmed the last operation. This chat is being checked automatically. Start a new chat if its outcome cannot be recovered; sending again could repeat the work.</p>}
        <div aria-label="Hermes messages" className="space-y-5">
          {historyMore && <Button size="sm" variant="outline" disabled={historyBusy || (!enabled && !snapshot.running && !snapshot.uncertain)} onClick={() => void loadOlder()}>{historyBusy ? 'Loading history…' : historyOffset ? 'Load older messages' : 'Load conversation history'}</Button>}
          {[...older.filter(m => !snapshot.messages.some(current => current.id === m.id)), ...snapshot.messages].map(m => <article key={m.id} className="rounded-xl border border-border p-4"><p className="mb-2 text-xs font-medium text-muted">{m.role}</p><Markdown text={m.text} /></article>)}
          {snapshot.partial && <article className="rounded-xl border border-border p-4"><p className="mb-2 text-xs text-muted">Hermes</p><Markdown text={snapshot.partial} streaming={snapshot.running} /></article>}
          {snapshot.running && !snapshot.partial && <p role="status" className="text-sm text-muted">Hermes is working…</p>}
          {snapshot.tools.map(t => <details key={t.id} className="rounded-lg border border-border p-3 text-sm"><summary>{t.name} · {t.done ? 'Finished' : 'Running'}</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{t.detail}</pre></details>)}
        </div>
        {snapshot.prompts.map(p => <PromptCard key={p.id} prompt={p} busy={busy} answer={async answer => { await action({ operation: 'answer', requestId: p.id, answer }); }} />)}
        {snapshot.queued && <p className="text-sm text-muted">Queued: {snapshot.queued}</p>}
        {snapshot.queuePending && !snapshot.queued && <p role="status" className="text-sm text-muted">Checking the next-message reservation…</p>}
        {details && <details open className="rounded-lg border border-border p-3"><summary>{details.title}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{details.text}</pre></details>}
        <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={e => { e.preventDefault(); sendDraft(); }}>
          <Textarea ref={textarea} aria-label="Message Hermes" value={text} maxLength={64000} rows={3} placeholder={snapshot.running ? 'A correction or your next message…' : 'Message Hermes, or enter a /command…'} onChange={e => { setText(e.target.value); setCommandIndex(0); setShowCommands(e.target.value.trim().startsWith('/') && !e.target.value.trim().startsWith('//')); }} disabled={busy || !enabled || snapshot.uncertain}
            onKeyDown={e => {
              if (e.key === 'Escape') { setShowCommands(false); return; }
              if (showCommands && completionMatches.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setCommandIndex(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + completionMatches.length) % completionMatches.length); }
              if (showCommands && completionMatches.length && (e.key === 'Tab' || (e.key === 'Enter' && isCommand && parsed.name !== completionMatches[commandIndex]?.value))) { e.preventDefault(); chooseCommand(completionMatches[commandIndex]?.value ?? completionMatches[0].value); }
              else if (e.key === 'Enter' && !e.shiftKey && isCommand) { e.preventDefault(); if (!snapshot.running || activeCommand) sendDraft(); }
            }} />
          {showCommands && <div className="space-y-2 rounded-lg border border-border p-3" aria-label="Hermes command menu">
            <Input aria-label="Search Hermes commands" value={commandSearch} onChange={e => { setCommandSearch(e.target.value); setCommandIndex(0); }} onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }} />
            <p className="text-xs text-muted">Choose a command to fill your draft. Skills prepare a message for you to review and send. Session YOLO changes require administrator policy and a separate confirmation.</p>
            {catalog?.warning && <p role="status" className="text-sm">{catalog.warning}</p>}
            {!catalog && <p role="status">Command discovery is unavailable. Try Commands &amp; skills again.</p>}
            <div className="max-h-64 space-y-1 overflow-y-auto" role="list" aria-label="Remote Hermes commands">
              {commandMatches.map(c => <div key={c.value} role="listitem" className="text-sm">
                <button type="button" disabled={!c.available || busy || !enabled || snapshot.uncertain || (snapshot.running && !['/stop', '/context', '/commands', '/yolo', '/approvals'].includes(c.value))} className={`w-full rounded p-2 text-left disabled:opacity-50 ${c.value === completionMatches[commandIndex]?.value ? 'bg-surface-2' : ''}`} onClick={() => chooseCommand(c.value)}>
                  <span className="font-medium">{c.value}</span>{' '}<span className="block text-xs">{c.description}{!c.available ? ' · Unavailable here' : c.kind === 'skill' ? ' · Draft only' : ''}</span>
                </button>{!c.available && <p className="px-2 text-xs text-muted">{c.reason}</p>}
              </div>)}
            </div>
          </div>}
          <input ref={fileInput} aria-label="Attach files to Hermes" type="file" multiple disabled={busy || !enabled || snapshot.running || snapshot.uncertain} onChange={e => setFiles(Array.from(e.target.files ?? []))} className="text-sm" />
          {files.length > 0 && <p className="text-xs text-muted">{files.map(f => f.name).join(', ')}</p>}
          <div className="flex flex-wrap gap-2">
            {snapshot.running && !isCommand ? <><Button variant="outline" disabled={busy || !enabled || snapshot.uncertain || !text.trim() || files.length > 0} onClick={() => void send('steer')}>Steer current turn</Button><Button disabled={busy || !enabled || snapshot.uncertain || !text.trim() || files.length > 0 || !!snapshot.queued || snapshot.queuePending} onClick={() => void send('queue')}>Queue next message</Button></> : <Button type="submit" disabled={busy || !enabled || snapshot.uncertain || (snapshot.running && !activeCommand) || (!text.trim() && !files.length)}>{busy ? 'Sending…' : isCommand ? 'Run command' : 'Send'}</Button>}
          </div>
        </form>
      </>}
    </section>
    <Dialog open={!!yoloDialog} onOpenChange={open => { if (!open) closeYolo(); }}>
      <DialogContent title={yoloDialog?.confirmation ? `Confirm session YOLO ${yoloDialog.confirmation.value.toUpperCase()}` : 'Hermes session approval mode'} description="Only this native conversation's session flag is changed. Profile-wide and process settings remain separate.">
        <div className="space-y-3 text-sm">
          <p>Connection: {connectionId}. Profile: {yoloDialog?.confirmation?.profile || snapshot?.profile}. Conversation: {yoloDialog?.confirmation?.title || snapshot?.title}.</p>
          {snapshot && <p role="status">{yoloStatusText(snapshot)}</p>}
          <p>Enabling YOLO bypasses recoverable Hermes approval prompts and can change computer-use permission mode. Other native clients sharing this conversation are affected and can change it while you confirm; this UI cannot lock them.</p>
          <p>Session OFF cannot revoke inherited profile or process bypass. No profile-wide setting is changed.</p>
          {!snapshot?.yoloAllowed && <p role="status">Session YOLO changes are disabled by your administrator. Status inspection remains available.</p>}
          {snapshot && !sessionYoloCompatible(snapshot) && <p role="status">This runtime is unavailable for changes. Verified Hermes 0.21.5 with native desktop contract 8 and a matching profile is required.</p>}
          {snapshot && (snapshot.running || snapshot.uncertain || snapshot.queuePending || snapshot.queued || snapshot.prompts.length > 0) && <p role="status">Finish pending prompts, queued work and uncertain operations before changing the session flag.</p>}
          {yoloError && <p role="alert">{yoloError}</p>}
          {error && <p role="alert">{error}</p>}
          {yoloDialog?.confirmation ? <>
            <p>This confirmation expires in one minute.</p>
            {yoloExpired && <p role="status">Confirmation expired. Cancel and request a new confirmation.</p>}
            <Button variant={yoloDialog.confirmation.value === 'on' ? 'danger' : 'primary'} disabled={busy || !yoloReady || yoloExpired} onClick={() => void confirmYolo()}>Confirm session YOLO {yoloDialog.confirmation.value.toUpperCase()}</Button>
          </> : <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy || !yoloReady} onClick={() => void prepareYolo('on')}>Enable session YOLO…</Button>
            <Button variant="outline" disabled={busy || !yoloReady} onClick={() => void prepareYolo('off')}>Disable session YOLO…</Button>
          </div>}
          <Button variant="outline" onClick={closeYolo}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
function PromptCard({ prompt, busy, answer }: { prompt: NativePrompt; busy: boolean; answer: (value: Operation) => Promise<void> }) {
  const [value, setValue] = useState(''); const [identifier, setIdentifier] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <form className="space-y-3 rounded-xl border border-border bg-surface-2 p-4" onSubmit={e => {
    e.preventDefault();
    const response = prompt.method === 'clarify' ? prompt.questions.length ? { answers } : { answer: value }
      : { value: prompt.method === 'vault.save_login' ? JSON.stringify({ identifier, password: value }) : value };
    setValue(''); setIdentifier(''); void answer(response);
  }}>
    <p className="font-medium">{prompt.title}</p>
    {prompt.command && <pre className="whitespace-pre-wrap break-words text-sm">{prompt.command}</pre>}
    {prompt.method === 'approval' ? <div className="flex gap-2"><Button disabled={busy} onClick={() => void answer({ choice: 'once' })}>Allow once</Button><Button variant="outline" disabled={busy} onClick={() => void answer({ choice: 'deny' })}>Deny</Button></div> : <>
      {prompt.questions.length ? prompt.questions.map(q => <label key={q.id} className="block space-y-2 text-sm">{q.question}<Input aria-label={q.question} value={answers[q.id] ?? ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} list={`choices-${prompt.id}-${q.id}`} required /><datalist id={`choices-${prompt.id}-${q.id}`}>{q.choices.map(c => <option key={c} value={c} />)}</datalist></label>) : <>
        {prompt.method === 'vault.save_login' && <Input aria-label="Hermes login username" placeholder="Username" value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="off" required />}
        <Input aria-label={prompt.method === 'clarify' ? 'Answer Hermes' : 'Protected value for Hermes'} type={prompt.method === 'clarify' ? 'text' : 'password'} value={value} onChange={e => setValue(e.target.value)} autoComplete="off" required />
      </>}
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Answer Hermes</Button><Button variant="outline" disabled={busy} onClick={() => { setValue(''); setIdentifier(''); void answer(prompt.method === 'clarify' ? { answers: {} } : { value: '' }); }}>Skip</Button></div>
      {prompt.method !== 'clarify' && <p className="text-xs text-muted">Sent only to this Hermes prompt. This portal does not save it.</p>}
    </>}
  </form>;
}
