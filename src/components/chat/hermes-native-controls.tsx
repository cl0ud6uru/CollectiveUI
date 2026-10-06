'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import type { ManagedPrompt, ManagedRunView } from '@/local-hermes/interactions';

export function HermesNativeControls({ conversationId }: { conversationId: string }) {
  const [view, setView] = useState<ManagedRunView | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [text, setText] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/native`, { cache: 'no-store', signal: abort.signal });
        const data = await res.json();
        if (!abort.signal.aborted && res.ok) setView(data.view ?? null);
        if (!res.ok && !abort.signal.aborted) setView(null);
      } catch { /* normal chat retains its replay when native inspection is unavailable */ }
      finally { if (!abort.signal.aborted) timer = setTimeout(poll, document.hidden ? 10000 : 2000); }
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [conversationId]);
  async function control(input: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/native`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Native control was not confirmed.');
      setNotice(input.operation === 'answer' ? 'Answer sent to Hermes.' : input.operation === 'queue' ? 'Next message accepted by Hermes.' : 'Correction sent to Hermes.');
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Native operation was not confirmed.'); return false; }
    finally { setBusy(false); }
  }
  if (!view) return null;
  return <section className="mx-auto w-full max-w-3xl space-y-3 px-4 py-2" aria-label="Native Hermes controls">
    <details open={view.prompts.length > 0} className="rounded-xl border border-border bg-surface p-3">
      <summary className="cursor-pointer text-sm">Native Hermes · {view.model || 'profile model'}{typeof view.usage.context_percent === 'number' && ` · ${view.usage.context_percent}% context`}{view.prompts.length > 0 && ' · Waiting for your answer'}</summary>
      <div className="mt-3 space-y-3">
        {Object.keys(view.usage).length > 0 && <p className="text-xs text-muted">{Object.entries(view.usage).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' · ')}</p>}
        {view.prompts.map(prompt => <NativeInput key={prompt.id} prompt={prompt} disabled={busy} submit={answer => control({ operation: 'answer', requestId: prompt.id, answer })} />)}
        {view.queued && <p className="text-sm">Queued in Hermes: {view.queued}</p>}
        {view.running && <div className="space-y-2">
          <Textarea aria-label="Correct or queue native Hermes work" rows={2} maxLength={4000} value={text} onChange={e => setText(e.target.value)} disabled={busy} placeholder="A correction or your next message…" />
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || !text.trim()} onClick={async () => { if (await control({ operation: 'steer', requestId: crypto.randomUUID(), text })) setText(''); }}>Steer current turn</Button><Button size="sm" disabled={busy || !text.trim() || !!view.queued} onClick={async () => { if (await control({ operation: 'queue', requestId: crypto.randomUUID(), text })) setText(''); }}>Queue in Hermes</Button></div>
          <p className="text-xs text-muted">Queued messages stay in Hermes’s native session. Stop in the chat cancels the active and queued work.</p>
        </div>}
        {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </details>
  </section>;
}
function NativeInput({ prompt, disabled, submit }: { prompt: ManagedPrompt; disabled: boolean; submit: (answer: Record<string, unknown>) => Promise<boolean | undefined> }) {
  const [value, setValue] = useState(''), [identifier, setIdentifier] = useState(''), [answers, setAnswers] = useState<Record<string, string>>({});
  return <form className="space-y-2 rounded-lg border border-border p-3" onSubmit={e => {
    e.preventDefault();
    const answer = prompt.method === 'clarify' ? prompt.single ? { answer: value } : { answers } : { value: prompt.method === 'vault.save_login' ? JSON.stringify({ identifier, password: value }) : value };
    setValue(''); setIdentifier(''); void submit(answer);
  }}>
    <p className="text-sm font-medium">{prompt.title}</p>
    {prompt.command && <pre className="whitespace-pre-wrap break-words text-xs">{prompt.command}</pre>}
    {prompt.method === 'clarify' ? prompt.single ? <><Input list={`${prompt.id}-choices`} aria-label={prompt.title} value={value} maxLength={4000} onChange={e => setValue(e.target.value)} required disabled={disabled} /><datalist id={`${prompt.id}-choices`}>{prompt.choices?.map(choice => <option key={choice} value={choice} />)}</datalist></> : prompt.questions.map(q => <label key={q.id} className="block text-sm">{q.question}<Input list={`${prompt.id}-${q.id}-choices`} maxLength={4000} aria-label={q.question} value={answers[q.id] ?? ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} required disabled={disabled} /><datalist id={`${prompt.id}-${q.id}-choices`}>{q.choices.map(choice => <option key={choice} value={choice} />)}</datalist></label>) : <>
      {prompt.method === 'vault.save_login' && <Input aria-label="Hermes login username" value={identifier} onChange={e => setIdentifier(e.target.value)} autoComplete="off" disabled={disabled} required />}
      <Input aria-label="Protected value for native Hermes" type="password" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" disabled={disabled} required />
      <p className="text-xs text-muted">Sent only to the pending native prompt. The portal does not save this value.</p>
    </>}
    <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled}>Answer Hermes</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => { setValue(''); setIdentifier(''); void submit(prompt.method === 'clarify' ? prompt.single ? { answer: '' } : { answers: {} } : { value: '' }); }}>Skip</Button></div>
  </form>;
}
