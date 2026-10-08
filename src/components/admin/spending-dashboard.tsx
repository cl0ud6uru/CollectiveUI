'use client';
import { useEffect, useState, useTransition } from 'react';
import { AdminHeader, Card, Stat, Table, Td } from './ui';
import { Button } from '@/components/ui/button';
import { saveBillingConfiguration } from '@/app/admin/spending/actions';
import { applicableRemaining, moneyText, remaining, snapshotStale, type BillingAccountView, type Money, type SpendLimit } from '@/lib/billing/contracts';

const amountsText = (amounts: Money[], known: boolean) => !known ? 'Unknown' : amounts.length ? amounts.map(moneyText).join(' · ') : 'No costs reported';
const limitText = (limit: SpendLimit | undefined) => !limit ? 'Unknown' : limit.status === 'known' ? moneyText(limit.amount === null || !limit.currency ? null : { value: limit.amount, currency: limit.currency }) : limit.status.replaceAll('_', ' ');
export function SpendingDashboard({ initial }: { initial: BillingAccountView[] }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [accounts, setAccounts] = useState(initial);
  const [selected, setSelected] = useState(initial[0]?.id ?? '');
  const [project, setProject] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, start] = useTransition();
  const account = accounts.find(a => a.id === selected);
  const snapshot = account?.enabled ? account.snapshot : null;
  const stale = snapshot ? snapshotStale(snapshot, clock) : false;
  const selectedProject = snapshot?.projects.find(p => p.id === project);
  const ownLimit = project ? snapshot?.projectLimits[project] : snapshot?.organizationLimit;
  const ownCosts = project ? selectedProject?.amounts ?? [] : snapshot?.amounts ?? [];
  const costsKnown = snapshot && (project ? snapshot.breakdownStatus : snapshot.costsStatus) === 'known';
  const projectIds = snapshot ? [...new Set([...snapshot.projects.flatMap(p => p.id ? [p.id] : []), ...Object.keys(snapshot.projectLimits)])] : [];
  const available = snapshot && !account?.lastError ? applicableRemaining(snapshot, project || null, clock) : null;
  const max = Math.max(1, ...(snapshot?.daily.flatMap(d => d.amounts.map(a => Math.abs(a.value))) ?? []));
  async function refresh() {
    setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/spending/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: selected }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Refresh failed.');
      setAccounts(data); setNotice('Refresh completed. Check data freshness and permission status below.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Refresh failed.'); }
  }
  return <div className="space-y-5">
    <AdminHeader title="Provider spending" description="OpenAI API Platform · provider-reported monthly spending" />
    <p className="text-sm text-muted">Read-only. Costs may arrive late from OpenAI. Monthly spending allowance is separate from prepaid credit and ChatGPT / Codex subscription allowance.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 text-sm">Billing account<select aria-label="Billing account" className="mt-1 block w-full max-w-80 rounded-lg border border-border bg-surface px-3 py-2" value={selected} onChange={e => { setSelected(e.target.value); setProject(''); setError(''); setNotice(''); }}>
        {!accounts.length && <option value="">No billing accounts configured</option>}{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.organization}</option>)}
      </select></label>
      {snapshot && <label className="min-w-0 text-sm">Scope<select aria-label="Spending scope" className="mt-1 block w-full max-w-80 rounded-lg border border-border bg-surface px-3 py-2" value={project} onChange={e => setProject(e.target.value)}>
        <option value="">Organization</option>{projectIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>}
      <Button disabled={busy || !account?.enabled} onClick={() => start(refresh)}>{busy ? 'Refreshing…' : 'Refresh provider data'}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {!account && <Card>Provider spending is off by default. An authorized administrator can configure a separate billing account below.</Card>}
    {account && <p className="break-words text-xs text-muted">Organization: {account.organization} · {account.enabled ? 'Enabled' : 'Off'} · Last refresh attempt: {account.lastAttemptAt ? new Date(account.lastAttemptAt).toLocaleString() : 'Never'}</p>}
    {account?.lastError && <p role="alert" className="text-sm text-danger">{account.lastError}</p>}
    {account && !snapshot && <Card>{account.enabled ? 'No successful provider snapshot yet. Refresh to read costs and limits.' : 'Provider spending is disabled. No billing reads are made.'}</Card>}
    {snapshot && <>
      <p className="text-sm text-muted">{snapshot.month} UTC · Provider data requested through {new Date(snapshot.through * 1000).toLocaleString()} · Last successful refresh: {new Date(snapshot.refreshedAt).toLocaleString()}</p>
      {(stale || account?.lastError) && <p role="status" className="rounded-lg bg-surface-2 p-3 text-sm">{stale ? 'Stale snapshot. ' : ''}Historical reported costs are shown; current allowance is unknown until a successful refresh.</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label={project ? 'Project month-to-date costs' : 'Organization month-to-date costs'} value={amountsText(ownCosts, !!costsKnown)} sub="Actual provider-reported costs; reporting may be delayed" />
        <Stat label={project ? 'Project monthly spending limit' : 'Organization monthly spending limit'} value={limitText(ownLimit)} sub={`Provider enforcement: ${ownLimit?.enforcement ?? 'unknown'}`} />
        <Stat label="Applicable remaining allowance" value={moneyText(available)} sub={project ? 'Bounded by the organization and project limits; subject to reporting delay' : 'Subject to provider reporting delay; no local cap is enforced'} />
        {project && <Stat label="Parent organization limit" value={limitText(snapshot.organizationLimit)} sub={`Remaining: ${moneyText(remaining(snapshot.organizationLimit, snapshot.amounts, snapshot.costsStatus === 'known' && !stale && !account?.lastError))} · Enforcement: ${snapshot.organizationLimit.enforcement ?? 'unknown'}`} />}
      </div>
      <section aria-labelledby="spending-trends" className="space-y-3"><h2 id="spending-trends" className="font-semibold">Daily organization costs</h2>
        <p className="text-xs text-muted">Returned daily buckets only; missing days are not inferred. Currency totals stay separate.</p>
        {snapshot.costsStatus !== 'known' ? <p>Costs {snapshot.costsStatus.replaceAll('_', ' ')}.</p> : <Table head={['Day (UTC)', 'Reported costs', 'Trend']}>
          {snapshot.daily.map(day => <tr key={day.start}><Td>{new Date(day.start * 1000).toISOString().slice(0, 10)}</Td><Td>{amountsText(day.amounts, true)}</Td><Td><div className="min-w-12 space-y-1" aria-hidden="true">{day.amounts.map(a => <div key={a.currency} className="h-2 rounded bg-accent" style={{ width: `${Math.min(100, Math.abs(a.value) / max * 100)}%` }} />)}</div></Td></tr>)}
        </Table>}
      </section>
      <section aria-labelledby="spending-projects" className="space-y-3"><h2 id="spending-projects" className="font-semibold">Project breakdown</h2>
        {snapshot.breakdownStatus !== 'known' ? <p>Project breakdown {snapshot.breakdownStatus.replaceAll('_', ' ')}. Organization costs remain available independently.</p> : <Table head={['Project', 'Month-to-date costs', 'Monthly limit', 'Enforcement']}>
          {snapshot.projects.map(row => <tr key={row.id ?? 'unattributed'}><Td>{row.id ?? 'Unattributed by provider'}</Td><Td>{amountsText(row.amounts, true)}</Td><Td>{row.id ? limitText(snapshot.projectLimits[row.id]) : 'Unknown'}</Td><Td>{row.id ? snapshot.projectLimits[row.id]?.enforcement ?? 'unknown' : 'unknown'}</Td></tr>)}
        </Table>}
      </section>
    </>}
    <details className="rounded-2xl border border-border p-4"><summary className="cursor-pointer font-medium">Billing configuration</summary>
      <p className="my-3 text-sm text-muted">Use a separate API Platform organization Admin key with the least read access needed for Costs, organization/project spend-limit retrieval and project breakdown. Confirm available permission names in the Platform before activation. Do not grant write permissions for this dashboard. Keys are encrypted on the server and never returned.</p>
      <BillingForm key={account?.id ?? 'new'} account={account} onSaved={view => { setAccounts(rows => [...rows.filter(a => a.id !== view.id), view]); setSelected(view.id); setNotice('Billing configuration saved.'); }} />
      {account && <details className="mt-5"><summary className="cursor-pointer text-sm">Add another billing account</summary><BillingForm onSaved={view => { setAccounts(rows => [...rows, view]); setSelected(view.id); setProject(''); }} /></details>}
    </details>
  </div>;
}
function BillingForm({ account, onSaved }: { account?: BillingAccountView; onSaved: (view: BillingAccountView) => void }) {
  const [pending, start] = useTransition(); const [error, setError] = useState('');
  return <form className="grid gap-3 pt-3" onSubmit={event => {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setError('');
    const input = { id: account?.id, name: String(data.get('name')), organization: String(data.get('organization')), adminKey: String(data.get('adminKey')), enabled: data.has('enabled'), showHealthBar: data.has('showHealthBar') };
    // Clear the sensitive browser field immediately; it is never part of persistent UI state.
    (form.elements.namedItem('adminKey') as HTMLInputElement).value = '';
    start(async () => { try { onSaved(await saveBillingConfiguration(input)); } catch { setError('Configuration could not be saved. Check the account details and server encryption configuration.'); } });
  }}>
    {[['name', 'Account label', account?.name ?? ''], ['organization', 'Organization ID', account?.organization ?? '']].map(([name, label, value]) => <label key={name} className="text-sm">{label}<input name={name} aria-label={label} required defaultValue={value} readOnly={name === 'organization' && !!account} maxLength={name === 'name' ? 80 : 100} className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2" /></label>)}
    <label className="text-sm">Separate API Platform Admin billing key<input name="adminKey" aria-label="Separate API Platform Admin billing key" type="password" autoComplete="new-password" required={!account} maxLength={10000} placeholder={account ? 'Leave blank to keep stored key' : 'sk-admin-…'} className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2" /></label>
    <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={account?.enabled ?? false} />Enable provider spending reads</label>
    <label className="flex items-center gap-2 text-sm"><input name="showHealthBar" type="checkbox" defaultChecked={account?.showHealthBar ?? false} />Show admin spending bar beside model selection</label>
    <Button className="justify-self-start" disabled={pending} type="submit">Save billing configuration</Button>{error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </form>;
}
