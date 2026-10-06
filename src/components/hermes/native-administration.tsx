'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { settingValues } from '@/lib/remote-hermes/administration-contract';

type Setting = { supported: boolean; value: string };
type Inventory = {
  profileName: string;
  session: { reasoning: Setting; fast: Setting };
  profile: { reasoning: Setting; fast: Setting };
  mcp: null | { servers: { name: string; transport: string; enabled: boolean; source: string; status: string; tools: number | null; envKeys: string[]; hasOAuth: boolean }[]; catalog: { name: string; transport: string; installed: boolean; requires: string[] }[] };
};
type Probe = { ok: boolean; oauthNeeded: boolean; oauthTokensPresent: boolean | null; tools: string[]; prompts: number; resources: number };
export function NativeAdministration({ connectionId, sessionId, allowed, running }: { connectionId: string; sessionId: string; allowed: boolean; running: boolean }) {
  const [open, setOpen] = useState(false); const [data, setData] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const [scope, setScope] = useState<'session' | 'profile'>('session');
  const [key, setKey] = useState<'reasoning' | 'fast'>('reasoning'); const [value, setValue] = useState('');
  const [preset, setPreset] = useState(''); const [server, setServer] = useState(''); const [envVar, setEnvVar] = useState(''); const [secret, setSecret] = useState('');
  const [probe, setProbe] = useState<{ name: string; result: Probe } | null>(null);
  const endpoint = `/api/hermes/${encodeURIComponent(connectionId)}/administration`;
  async function load() {
    const response = await fetch(`${endpoint}?${new URLSearchParams({ sessionId })}`, { cache: 'no-store' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not inspect Hermes.'); setData(result);
  }
  async function inspect() {
    setBusy(true); setNotice('');
    try { await load(); setOpen(true); } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not inspect Hermes.'); }
    finally { setBusy(false); }
  }
  async function act(input: Record<string, unknown>) {
    setBusy(true); setNotice(''); setSecret('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, input: { requestId: crypto.randomUUID(), ...input } }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Hermes did not confirm this change.');
      if (input.operation === 'test') setProbe({ name: String(input.name), result });
      else { setNotice(result.duplicate ? 'This operation was already submitted. Refresh to check its outcome.' : result.accepted ? 'Hermes confirmed the change.' : 'Hermes did not confirm the change. Refresh before trying again.'); await load(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Hermes could not complete this operation.'); }
    finally { setBusy(false); }
  }
  const disabled = !allowed || running || busy;
  const serverInfo = data?.mcp?.servers.find(s => s.name === server);
  return <div className="space-y-3">
    <Button size="sm" variant="outline" disabled={!allowed || busy} onClick={() => { if (open) { setSecret(''); setOpen(false); } else void inspect(); }}>{open ? 'Hide native settings' : 'Native settings & MCP'}</Button>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {open && data && <section aria-label="Native Hermes settings and MCP" className="space-y-5 rounded-xl border border-border p-4">
      <header className="flex items-center justify-between"><h3 className="font-medium">Hermes profile: {data.profileName}</h3><Button size="sm" variant="outline" disabled={!allowed || busy} onClick={() => void inspect()}>Refresh settings</Button></header>
      <p className="text-sm text-muted">Chat settings affect this conversation. Profile defaults and MCP servers belong to the remote Hermes profile and can affect its other clients. Finish the current turn before making changes.</p>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (scope === 'profile' && !confirm(`Change defaults for Hermes profile “${data.profileName}”? Other clients using this profile may be affected.`)) return; void act({ operation: 'setting', scope, key, value }); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">Scope<Select aria-label="Setting scope" value={scope} disabled={disabled} onChange={e => { setScope(e.target.value as 'session' | 'profile'); setValue(''); }}><option value="session">This chat</option><option value="profile">Profile defaults</option></Select></label>
          <label className="space-y-1 text-sm">Setting<Select aria-label="Setting key" value={key} disabled={disabled} onChange={e => { setKey(e.target.value as 'reasoning' | 'fast'); setValue(''); }}><option value="reasoning">Reasoning effort</option><option value="fast">Speed tier</option></Select></label>
          <label className="space-y-1 text-sm">Value<Select aria-label="Setting value" value={value} disabled={disabled || !data[scope][key].supported} onChange={e => setValue(e.target.value)}><option value="">Choose a value</option>{settingValues[key].map(v => <option key={v} value={v}>{v}</option>)}</Select></label>
        </div>
        <p className="text-xs text-muted">Current: {data[scope][key].supported ? data[scope][key].value || 'Reported value unavailable' : 'Unavailable on this Hermes version'}. Speed tiers depend on the selected model and can affect cost.</p>
        <Button type="submit" size="sm" disabled={disabled || !value || !data[scope][key].supported}>Apply setting</Button>
      </form>
      <div className="space-y-3">
        <h4 className="font-medium">MCP servers</h4>
        {!data.mcp ? <p className="text-sm text-muted">MCP administration is unavailable on this Hermes version.</p> : <>
          {data.mcp.servers.length === 0 && <p className="text-sm text-muted">No servers configured in this profile.</p>}
          {data.mcp.servers.map(s => <div key={s.name} className="space-y-2 rounded-lg border border-border p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><strong>{s.name}</strong><span>{s.transport} · {s.status} · {s.enabled ? 'enabled' : 'disabled'}{s.tools !== null ? ` · ${s.tools} tools` : ''}</span><Button size="sm" variant="outline" disabled={disabled} onClick={() => void act({ operation: 'test', requestId: undefined, name: s.name })}>Test connection</Button></div>{s.envKeys.length > 0 && <p className="text-xs text-muted">Credential keys: {s.envKeys.join(', ')}</p>}{s.hasOAuth && <p className="text-xs text-muted">OAuth credentials are present in Hermes.</p>}</div>)}
          {probe && <div role="status" className="rounded-lg border border-border p-3 text-sm"><strong>{probe.name}: {probe.result.ok ? 'Connection succeeded' : probe.result.oauthNeeded && probe.result.oauthTokensPresent === false ? 'OAuth sign-in required in Hermes' : 'Connection failed; check the server in Hermes'}</strong>{probe.result.ok && <p>{probe.result.tools.length} tools · {probe.result.prompts} prompts · {probe.result.resources} resources{probe.result.tools.length > 0 && ` · ${probe.result.tools.join(', ')}`}</p>}</div>}
          <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act({ operation: 'install', preset }); }}>
            <label className="block text-sm">Install a Hermes preset<Select aria-label="Install a Hermes preset" value={preset} disabled={disabled} onChange={e => setPreset(e.target.value)}><option value="">Choose a preset</option>{data.mcp!.catalog.filter(p => !p.installed).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}</Select></label>
            {preset && <p className="text-xs text-muted">Required keys: {data.mcp.catalog.find(p => p.name === preset)?.requires.join(', ') || 'none'}. Installing changes this profile’s MCP configuration; Hermes may require a reload.</p>}
            <Button type="submit" size="sm" disabled={disabled || !preset}>Install preset</Button>
          </form>
          <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act({ operation: 'credential', name: server, envVar, value: secret }); }}>
            <label className="block text-sm">Update a protected credential<Select aria-label="Update a protected credential" value={server} disabled={disabled} onChange={e => { setServer(e.target.value); setEnvVar(''); setSecret(''); }}><option value="">Choose a server</option>{data.mcp.servers.filter(s => s.source === 'config' && s.envKeys.length).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</Select></label>
            <Select aria-label="MCP credential key" value={envVar} disabled={disabled || !server} onChange={e => { setEnvVar(e.target.value); setSecret(''); }}><option value="">Choose a credential key</option>{serverInfo?.envKeys.map(k => <option key={k} value={k}>{k}</option>)}</Select>
            <Input aria-label="Protected MCP credential" type="password" value={secret} disabled={disabled || !envVar} onChange={e => setSecret(e.target.value)} autoComplete="off" maxLength={16000} />
            <p className="text-xs text-muted">Sent directly to Hermes for storage in that profile. The portal clears this field and saves no credential value or chat message.</p>
            <Button type="submit" size="sm" disabled={disabled || !envVar || !secret}>Save protected credential</Button>
          </form>
        </>}
      </div>
    </section>}
  </div>;
}
