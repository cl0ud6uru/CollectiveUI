'use client';
import Link from 'next/link';
import { HermesCodexConnection } from './hermes-codex-connection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, KeyRound, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { personalHermesRuntimeHref, providerBlocker, profileProviders, profileUpdate, reasoningLevels, testMessages, type ProfileSettings, type ProfileTestResult, type ProfileValues } from '@/docker-hermes/settings';
import { connectivityMessages, type Connectivity } from '@/docker-hermes/network';
import type { DockerStatus } from '@/docker-hermes/types';

type State = { settings: ProfileSettings | null; runtime: Pick<DockerStatus, 'phase' | 'network'> };
export function HermesProfileSettings({ botId }: { botId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [provider, setProvider] = useState<ProfileValues['provider'] | ''>('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ProfileValues['reasoningEffort']>('');
  const [turns, setTurns] = useState('');
  const [credentialAction, setCredentialAction] = useState<'keep' | 'replace' | 'clear'>('keep');
  const [codexPending, setCodexPending] = useState(false);
  const [secret, setSecret] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<'load' | 'save' | 'test' | 'network' | null>('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mustReload, setMustReload] = useState(false);
  const request = useRef(0), controller = useRef<AbortController | null>(null);
  const api = `/api/bots/${encodeURIComponent(botId)}/native/settings`;
  const apply = useCallback((s: ProfileSettings) => {
    setProvider(s.provider ?? ''); setModel(s.model); setEffort(s.reasoningEffort); setTurns(s.maxTurns === null ? '' : String(s.maxTurns));
    setSecret(''); setCredentialAction('keep'); setConsent(false);
  }, []);
  const reload = useCallback(async () => {
    const serial = ++request.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setPending('load'); setError(''); setNotice(''); setSecret(''); setConsent(false);
    try {
      const res = await fetch(api, { cache: 'no-store', signal: abort.signal }); const data = await res.json();
      if (serial !== request.current) return;
      if (!res.ok) throw new Error(data.error || 'Settings could not be loaded.');
      setState(data); if (data.settings) apply(data.settings); setMustReload(false);
    } catch (e) { if (serial === request.current) { setError(e instanceof Error ? e.message : 'Settings unavailable.'); setMustReload(true); } }
    finally { if (serial === request.current) setPending(null); }
  }, [api, apply]);
  useEffect(() => {
    let mounted = true; const sequence = request, abort = controller;
    queueMicrotask(() => { if (mounted) void reload(); });
    return () => { mounted = false; ++sequence.current; abort.current?.abort(); };
  }, [reload]);
  const saved = state?.settings;
  const dirty = !!saved && (provider !== (saved.provider ?? '') || model !== saved.model || effort !== saved.reasoningEffort || turns !== (saved.maxTurns === null ? '' : String(saved.maxTurns)) || credentialAction !== 'keep');
  const lastTest = saved?.lastTest;
  const hasKey = !!provider && !!saved?.credentials[provider];
  const routeBlocker = saved && provider ? providerBlocker(saved, provider) : null;
  const saveBlocker = routeBlocker || (saved && !saved.advancedSupported ? 'This profile has advanced values outside the supported range. Ask an operator to reconcile them in native settings, then reload.' : null);
  const offline = state?.runtime.network === 'none';
  const signInBlocker = saveBlocker || (offline ? 'Sign-in is unavailable while this runtime is offline. Ask an administrator to turn on Internet access in Admin → Managed Hermes, then reload settings.' : dirty ? 'Save the selected provider and model before signing in.' : null);
  const testBlocked = !!pending || dirty || mustReload || offline || state?.runtime.phase !== 'ready';
  async function submit(operation: 'save' | 'test' | 'network') {
    if (!saved || pending || mustReload) return;
    let payload: unknown;
    if (operation === 'save') {
      if (saveBlocker) return;
      const parsed = profileUpdate.safeParse({ revision: saved.revision, provider, model, reasoningEffort: effort, maxTurns: turns === '' ? null : Number(turns),
        credential: credentialAction === 'replace' ? { action: 'replace', value: secret } : { action: credentialAction } });
      if (!parsed.success) { setError('Choose a provider and model ID, enter a valid API key when replacing, and use 1–1000 turns or leave it blank.'); return; }
      payload = { operation, settings: parsed.data };
    } else if (operation === 'network') {
      if (dirty || codexPending || state?.runtime.phase !== 'ready') return;
      payload = { operation, network: { revision: saved.revision } };
    } else {
      if (!consent || testBlocked) return;
      payload = { operation, test: { revision: saved.revision, requestId: crypto.randomUUID(), consent: true } };
    }
    const serial = ++request.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setPending(operation); setError(''); setNotice(''); setConsent(false);
    try {
      const res = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal });
      const data = await res.json(); if (serial !== request.current) return;
      setSecret('');
      if (!res.ok) throw new Error(data.error || 'The operation could not be confirmed.');
      if (operation === 'save') {
        apply(data); setState(s => s ? { ...s, settings: data } : s);
        setNotice(offline ? 'Saved in this native profile. An administrator can turn on Internet access in Admin → Managed Hermes before sign-in or testing.' : provider === 'openai-codex' ? 'Saved in this native profile. Next, sign in with OpenAI.' : 'Saved in this native profile. Start a new chat to use these defaults. Next, test the connection.');
      } else if (operation === 'network') {
        setState(s => s?.settings ? { ...s, settings: { ...s.settings, connectivity: data as Connectivity } } : s);
      } else {
        setState(s => s?.settings ? { ...s, settings: { ...s.settings, lastTest: data as ProfileTestResult } } : s);
      }
    } catch (e) {
      if (serial === request.current) { setError(e instanceof Error ? e.message : 'The operation could not be confirmed.'); setMustReload(true); setSecret(''); }
    } finally { if (serial === request.current) setPending(null); }
  }
  return <div className="space-y-5">
    <div className="rounded-2xl border border-border bg-surface p-5 space-y-3">
      <div className="flex items-center gap-2"><Settings2 size={18} /><h2 className="font-semibold">Your native profile</h2></div>
      <p className="text-sm text-muted">Choose the provider and model for this bot. Settings and API keys stay in its native Hermes profile.</p>
      <ol className="grid gap-2 text-sm sm:grid-cols-2" aria-label="Hermes setup steps">
        <li className="rounded-lg bg-surface-2 p-3">1. Runtime <strong className="block">{state?.runtime.phase === 'ready' ? 'Running' : state?.runtime.phase ?? 'Checking…'}</strong></li>
        <li className="rounded-lg bg-surface-2 p-3">2. Provider network <strong className="block">{offline ? 'Offline · access blocked' : saved?.connectivity?.code === 'reachable' ? 'Provider TLS reached' : state?.runtime.network === 'proxy' ? 'Restricted proxy · access unverified' : state?.runtime.network === 'internet' ? 'Standard Internet · access unverified' : 'Checking…'}</strong></li>
        <li className="rounded-lg bg-surface-2 p-3">3. Account <strong className="block">{saved?.provider && saved.credentials[saved.provider] ? saved.provider === 'openai-codex' ? 'Sign-in stored' : 'API key saved' : 'Setup needed'}</strong></li>
        <li className="rounded-lg bg-surface-2 p-3">4. Model access <strong className="block">{lastTest?.revision === saved?.revision && lastTest ? lastTest.code === 'verified' ? 'Verified' : 'Needs attention' : 'Not tested'}</strong></li>
      </ol>
      {offline && <p role="status" className="text-sm text-muted">This runtime has no external network access. You can save supported profile settings, but an administrator can turn on Internet access in Admin → Managed Hermes before sign-in and connection testing.</p>}
      <p className="text-xs text-muted">Provider, model and sign-in belong to this bot’s profile. Container resources and network access are shared by all your profiles. <Link className="underline" href={personalHermesRuntimeHref}>Manage your runtime</Link></p>
    </div>
    {error && <p role="alert" className="rounded-xl border border-danger/30 p-4 text-sm text-danger">{error} Reload to reconcile the saved state before trying again.</p>}
    {notice && <p role="status" className="text-sm flex gap-2"><Check size={18} className="shrink-0" />{notice}</p>}
    {pending === 'load' && <p role="status" className="text-sm text-muted">Loading native settings…</p>}
    {state && state.runtime.phase !== 'ready' && <p className="text-sm">Start your runtime in <Link href={personalHermesRuntimeHref} className="underline">Personal Hermes</Link>, then reload this page. Saved profile data is retained.</p>}
    {saved && <>
      <section aria-labelledby="hermes-network-title" className="rounded-2xl border border-border p-5 space-y-3">
        <h2 id="hermes-network-title" className="font-semibold">Check provider connectivity</h2>
        <p className="text-sm text-muted">Checks DNS and a verified TLS handshake to this saved provider’s fixed service domains. It sends no API key, account sign-in or inference request. Model access is verified separately.</p>
        {saved.connectivity && <p role="status" className="text-sm">{connectivityMessages[saved.connectivity.code]}<span className="block text-xs text-muted">Last check: {new Date(saved.connectivity.checkedAt).toLocaleString()}</span></p>}
        {dirty && <p className="text-xs text-muted">Save or discard your changes before checking.</p>}
        <Button disabled={!!pending || dirty || mustReload || codexPending || !saved.provider || !!routeBlocker || state.runtime.phase !== 'ready'} onClick={() => void submit('network')}>{pending === 'network' ? 'Checking provider…' : 'Check provider connectivity'}</Button>
      </section>
      <form className="rounded-2xl border border-border p-5 space-y-5" onSubmit={e => { e.preventDefault(); void submit('save'); }}>
        <fieldset disabled={!!pending || mustReload || codexPending} className="min-w-0 space-y-5">
          <legend className="mb-4 flex items-center gap-2 font-semibold"><KeyRound size={18} />Provider and model</legend>
          <div><Label htmlFor="hermes-provider">Model provider</Label><Select id="hermes-provider" value={provider} onChange={e => { const next = e.target.value as typeof provider; setProvider(next); setModel(next === (saved.provider ?? '') ? saved.model : ''); setSecret(''); setCredentialAction('keep'); setConsent(false); setNotice('Provider changed. Choose a model for this provider before saving.'); }}>
            <option value="">Choose a model provider</option>{profileProviders.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select><p className="mt-2 text-xs text-muted">Supports API keys and native ChatGPT / Codex subscription login. Custom endpoints and other authentication methods require native maintenance.</p></div>
          {provider === 'openai-codex' && !!saved.codexModels?.length && <div><Label htmlFor="hermes-codex-model">Suggested Codex model</Label><Select id="hermes-codex-model" value={saved.codexModels.includes(model) ? model : ''} onChange={e => setModel(e.target.value)}><option value="">Choose a native Codex model</option>{saved.codexModels.map(id => <option key={id} value={id}>{id}</option>)}</Select></div>}
          <div><Label htmlFor="hermes-model">Model ID</Label><Input id="hermes-model" value={model} onChange={e => setModel(e.target.value)} autoComplete="off" list={provider === 'openai-codex' ? 'native-codex-models' : undefined} placeholder={profileProviders.find(p => p.id === provider)?.example ?? 'Exact model ID from your provider'} maxLength={200} />{provider === 'openai-codex' && <datalist id="native-codex-models">{saved.codexModels?.map(id => <option key={id} value={id} />)}</datalist>}<p className="mt-2 text-xs text-muted">Use a model available to your account. Codex suggestions come from the pinned native offline catalog; availability depends on your plan. No model list is fetched automatically.</p></div>
          {provider !== 'openai-codex' && <div><Label htmlFor="hermes-key-action">API key</Label><Select id="hermes-key-action" value={credentialAction} onChange={e => { setCredentialAction(e.target.value as typeof credentialAction); setSecret(''); }}>
            <option value="keep">{hasKey ? 'Keep saved key ••••••••' : 'Keep current state (no profile key saved)'}</option>
            <option value="replace">{hasKey ? 'Replace API key' : 'Add API key'}</option><option value="clear">Clear profile key and disable selected provider</option>
          </Select>
          {credentialAction === 'replace' && <div className="mt-3"><Label htmlFor="hermes-api-key">New API key</Label><Input id="hermes-api-key" type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} maxLength={4096} spellCheck={false} /><p className="mt-2 text-xs text-muted">Write-only. The saved value is never sent back to your browser.</p></div>}
          {credentialAction === 'clear' && <p className="mt-2 text-sm text-muted">Saving removes this provider’s profile API key and disables that provider here, preventing fallback to an inherited key. Other providers and native sign-ins are unchanged.</p>}
          </div>}
          <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Advanced profile settings</summary>
            <div className="mt-4 space-y-4">
              {!saved.advancedSupported && <p role="alert" className="text-sm text-danger">Native advanced values are outside this editor’s supported range. Reconcile them in native maintenance before saving.</p>}
              <div><Label htmlFor="hermes-effort">Reasoning effort</Label><Select id="hermes-effort" value={effort} onChange={e => setEffort(e.target.value as typeof effort)}>{reasoningLevels.map(level => <option key={level} value={level}>{level || 'Native default'}</option>)}</Select><p className="mt-2 text-xs text-muted">Hermes applies the levels supported by the model. Native per-model overrides can take precedence.</p></div>
              <div><Label htmlFor="hermes-turns">Maximum agent turns</Label><Input id="hermes-turns" type="number" min={1} max={1000} value={turns} onChange={e => setTurns(e.target.value)} placeholder="Native default · unlimited" /><p className="mt-2 text-xs text-muted">An agent turn is a model/tool iteration, not a chat message. Leave blank for native unlimited; runtime time limits still apply.</p></div>
            </div>
          </details>
          <p className="text-xs text-muted">A changed save safely restarts your runtime to reload native credentials and settings. All your profiles must be idle first. Existing conversations may retain native session overrides; start a new chat for these defaults. Skills and memory remain read-only here.</p>
          {saveBlocker && <p id="hermes-save-blocker" role="alert" className="text-sm text-danger">{saveBlocker}</p>}
          <div className="flex flex-wrap items-center gap-2"><Button type="submit" aria-describedby={saveBlocker ? 'hermes-save-blocker' : undefined} disabled={!dirty || !provider || !model.trim() || !!saveBlocker}>{pending === 'save' ? 'Saving safely…' : 'Save profile settings'}</Button><Button variant="ghost" disabled={!dirty} onClick={() => { apply(saved); setNotice('Unsaved changes discarded.'); }}>Discard changes</Button></div>
        </fieldset>
      </form>
      {provider === 'openai-codex' ? routeBlocker ? <section className="rounded-2xl border border-border p-5 space-y-3"><h2 className="font-semibold">ChatGPT / Codex subscription</h2><p className="text-sm text-muted">Resolve the provider notice above before starting subscription sign-in.</p></section> : <HermesCodexConnection botId={botId} revision={saved.revision} canStart={!dirty && !pending && !mustReload && saved.provider === 'openai-codex'} startBlockedReason={signInBlocker} onChanged={reload} onPendingChange={setCodexPending} /> : <section className="rounded-2xl border border-border p-5 space-y-3" aria-labelledby="hermes-test-title">
        <h2 id="hermes-test-title" className="font-semibold">Test the connection</h2>
        <p className="text-sm text-muted">Sends one short inference request using the saved API key and model, with no tools or chat history. Your provider may charge for it. Saving alone sends no inference request.</p>
        {lastTest && <p role="status" className="text-sm">{testMessages[lastTest.code]} <span className="block text-xs text-muted">Last explicit test: {new Date(lastTest.checkedAt).toLocaleString()}</span></p>}
        {dirty && <p className="text-xs text-muted">Save or discard your changes before testing.</p>}
        {offline && <p className="text-sm text-muted">Connection testing is unavailable while the runtime is offline. No inference request will be sent.</p>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} disabled={testBlocked} onChange={e => setConsent(e.target.checked)} />I understand this test may incur inference charges.</label>
        <Button disabled={!consent || testBlocked} onClick={() => void submit('test')}>{pending === 'test' ? 'Testing once…' : 'Test saved connection'}</Button>
      </section>}
      <p className="text-xs text-muted">You can leave setup and return from this bot’s Hermes settings. Unsaved keys are discarded. A save or test already submitted may finish after you leave; reload to see its outcome.</p>
      <Link className="inline-block text-sm underline" href={`/bots/${botId}`}>Done for now</Link>
    </>}
    <Button variant="outline" disabled={!!pending} onClick={() => void reload()}>Reload saved settings</Button>
  </div>;
}
