'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { signIntoRemoteHermes, loadRemoteHermesProfiles } from '@/app/(chat)/settings/remote-hermes-actions';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import type { RemoteConnectionView } from '@/lib/remote-hermes/store';
import type { RemoteHermesProfile } from '@/lib/remote-hermes/client';

export function RemoteHermes({ allowed, initial }: { allowed: boolean; initial: RemoteConnectionView[] }) {
  const [connections, setConnections] = useState(initial);
  const [profiles, setProfiles] = useState<Record<string, RemoteHermesProfile[]>>({});
  const [name, setName] = useState(''); const [baseUrl, setBaseUrl] = useState('');
  const [mode, setMode] = useState<'password' | 'sessionToken'>('password');
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [token, setToken] = useState('');
  const [error, setError] = useState(''); const [pending, start] = useTransition();
  return <section aria-labelledby="remote-hermes-title" className="rounded-xl border border-border p-4 space-y-4">
    <h2 id="remote-hermes-title" tabIndex={-1} className="font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">Remote Hermes</h2>
    <p className="text-sm text-muted">Connect your own Hermes dashboard. Your connection and credentials belong to your account.</p>
    {!allowed && <p role="status" className="text-sm">Personal remote connections are disabled by your administrator. Saved connections are retained.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {connections.map(c => <div key={c.id} className="rounded-lg border border-border p-3 space-y-2">
      <p className="font-medium">{c.name}</p><p className="text-xs text-muted">{c.baseUrl} {c.version && `· Hermes ${c.version}`}</p>
      <Link href={`/hermes/${encodeURIComponent(c.id)}`} className="inline-block text-sm underline">Open Hermes</Link>
      <Button variant="outline" disabled={pending || !allowed} onClick={() => start(async () => {
        try { setProfiles(p => ({ ...p, [c.id]: [] })); const items = await loadRemoteHermesProfiles(c.id); setProfiles(p => ({ ...p, [c.id]: items })); setError(''); }
        catch (e) { setError(e instanceof Error ? e.message : 'Could not load Hermes profiles.'); }
      })}>Refresh profiles</Button>
      {profiles[c.id] && <div className="space-y-2">{profiles[c.id].length ? profiles[c.id].map(p => <div key={p.name} className="text-sm"><strong>{p.botTitle || p.displayName || p.name}</strong>{p.description && <p className="text-muted">{p.description}</p>}<p className="text-xs text-muted">{p.name}{p.model && ` · ${p.model}`}</p></div>) : <p className="text-sm text-muted">No profiles loaded.</p>}</div>}
    </div>)}
    {allowed && <form className="space-y-3" onSubmit={e => { e.preventDefault(); start(async () => {
      setError('');
      const input = { name, baseUrl, mode, username, password, sessionToken: token };
      setPassword(''); setToken('');
      try {
        const result = await signIntoRemoteHermes(input);
        setConnections(cs => [...cs.filter(c => c.id !== result.connection.id), result.connection]);
        setProfiles(p => ({ ...p, [result.connection.id]: result.profiles }));
      } catch (e) { setError(e instanceof Error ? e.message : 'Hermes sign-in failed.'); }
    }); }}>
      <fieldset disabled={pending} className="space-y-3">
        <Field label="Connection name"><Input value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></Field>
        <Field label="Hermes dashboard URL" hint="The hermes serve address reachable from this portal, including any proxy path prefix."><Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} required placeholder="https://hermes.example.com" /></Field>
        <Field label="Sign-in method"><Select value={mode} onChange={e => { setMode(e.target.value as typeof mode); setPassword(''); setToken(''); }}><option value="password">Username and password</option><option value="sessionToken">Dashboard session token</option></Select></Field>
        {mode === 'password' ? <><Field label="Hermes username"><Input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required /></Field><Field label="Hermes password" hint="Used only to sign in. The password is never saved."><Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="off" required /></Field></> : <Field label="Dashboard session token"><Input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" required /></Field>}
        <Button type="submit">{pending ? 'Connecting…' : 'Sign in and discover profiles'}</Button>
      </fieldset>
    </form>}
  </section>;
}
