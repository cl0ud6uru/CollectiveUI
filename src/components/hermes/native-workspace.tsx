'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Markdown } from '@/components/chat/markdown';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';
import type { NativePrompt, NativeSessionView } from '@/lib/remote-hermes/view';
import { NativeAdministration } from './native-administration';

type Saved = { id: string; storedId: string; title: string; profile: string; status: string };
type Snapshot = NativeSessionView & { admissionAllowed: boolean };
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
  const fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const endpoint = `/api/hermes/${encodeURIComponent(connectionId)}`;
  const enabled = snapshot?.admissionAllowed ?? allowed;
  const request = useCallback(async (input: Operation, attachments: File[] = []) => {
    let response: Response;
    if (attachments.length) {
      const body = new FormData(); body.set('request', JSON.stringify(input));
      attachments.forEach(file => body.append('files', file));
      response = await fetch(endpoint, { method: 'POST', body });
    } else response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
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
  async function action(input: Operation, attachments: File[] = []) {
    if (busy) return;
    const generation = selection.current;
    setBusy(true); setError('');
    try { const result = await request({ sessionId, ...input }, attachments); return generation === selection.current ? result : undefined; }
    catch (e) { if (generation === selection.current) setError(e instanceof Error ? e.message : 'Hermes operation failed.'); }
    finally { setBusy(false); }
  }
  function select(id: string | null, selectedProfile = profile) {
    selection.current++;
    setOlder([]); setHistoryOffset(0); setHistoryMore(true); setHistoryBusy(false);
    setSnapshot(null); setSessionId(id); setProfile(selectedProfile); setDetails(null); setError('');
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
    const result = await action({ operation, text, requestId: crypto.randomUUID() }, operation === 'submit' ? files : []);
    if (result) {
      setText(typeof result.prefill === 'string' ? result.prefill : '');
      if (operation === 'submit') { setFiles([]); if (fileInput.current) fileInput.current.value = ''; }
      if (result.output) setDetails({ title: 'Hermes command', text: typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2) });
    }
  }
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
      if (generation === selection.current) setDetails({ title: operation === 'catalog' ? 'Hermes commands and skills' : 'Hermes context', text: JSON.stringify(data, null, 2) });
    } catch (e) { if (generation === selection.current) setError(e instanceof Error ? e.message : 'Could not load Hermes information.'); }
    finally { setBusy(false); }
  }
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
        <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={e => { e.preventDefault(); void send(text.startsWith('/') && !files.length ? 'command' : 'submit'); }}>
          <Textarea aria-label="Message Hermes" value={text} maxLength={64000} rows={3} placeholder={snapshot.running ? 'A correction or your next message…' : 'Message Hermes, or enter a /command…'} onChange={e => setText(e.target.value)} disabled={busy || !enabled || snapshot.uncertain} />
          <input ref={fileInput} aria-label="Attach files to Hermes" type="file" multiple disabled={busy || !enabled || snapshot.running || snapshot.uncertain} onChange={e => setFiles(Array.from(e.target.files ?? []))} className="text-sm" />
          {files.length > 0 && <p className="text-xs text-muted">{files.map(f => f.name).join(', ')}</p>}
          <div className="flex flex-wrap gap-2">
            {snapshot.running ? <><Button variant="outline" disabled={busy || !enabled || snapshot.uncertain || !text.trim() || files.length > 0} onClick={() => void send('steer')}>Steer current turn</Button><Button disabled={busy || !enabled || snapshot.uncertain || !text.trim() || files.length > 0 || !!snapshot.queued || snapshot.queuePending} onClick={() => void send('queue')}>Queue next message</Button></> : <Button type="submit" disabled={busy || !enabled || snapshot.uncertain || (!text.trim() && !files.length)}>{busy ? 'Sending…' : text.startsWith('/') && !files.length ? 'Run command' : 'Send'}</Button>}
          </div>
        </form>
      </>}
    </section>
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
