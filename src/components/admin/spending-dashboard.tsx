'use client';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { AdminHeader, Card, Stat, Table, Td } from './ui';
import { Button } from '@/components/ui/button';
import { AdminTimestamp } from './timestamp';
import { saveBillingConfiguration } from '@/app/admin/spending/actions';
import { applicableRemaining, BILLING_REFRESH_COOLDOWN_MS, BILLING_REFRESH_INTERVAL_MS, limitDescription, moneyText, remaining, snapshotStale, type BillingAccountView, type Money, type SpendLimit } from '@/lib/billing/contracts';

const amountsText = (amounts: Money[], known: boolean) => !known ? 'Unknown' : amounts.length ? amounts.map(moneyText).join(' · ') : 'No costs reported';
const limitText = (limit: SpendLimit | undefined) => !limit ? 'Not read' : limit.status === 'known' ? moneyText(limit.amount === null || !limit.currency ? null : { value: limit.amount, currency: limit.currency }) : ({ unset: 'Not set', permission_denied: 'Access denied', unsupported: 'Unsupported', unavailable: 'Unavailable', unknown: 'Unknown' })[limit.status];
export function SpendingDashboard({ initial }: { initial: BillingAccountView[] }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [accounts, setAccounts] = useState(initial);
  const [selected, setSelected] = useState(initial[0]?.id ?? '');
  const [project, setProject] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [localAttempts, setLocalAttempts] = useState<Record<string, number>>({});
  const refreshing = useRef(false);
  const account = accounts.find(a => a.id === selected);
  const snapshot = account?.enabled ? account.snapshot : null;
  const stale = snapshot ? snapshotStale(snapshot, clock) : false;
  const selectedProject = snapshot?.projects.find(p => p.id === project);
  const ownLimit = project ? snapshot?.projectLimits[project] : snapshot?.organizationLimit;
  const ownCosts = project ? selectedProject?.amounts ?? [] : snapshot?.amounts ?? [];
  const costsKnown = snapshot && (project ? snapshot.breakdownStatus : snapshot.costsStatus) === 'known';
  const projectIds = snapshot ? [...new Set([...snapshot.projects.flatMap(p => p.id ? [p.id] : []), ...Object.keys(snapshot.projectLimits)])] : [];
  const available = snapshot && !account?.lastError && !error ? applicableRemaining(snapshot, project || null, clock) : null;
  const dailyMax = new Map<string, number>();
  for (const day of snapshot?.daily ?? []) for (const amount of day.amounts) dailyMax.set(amount.currency, Math.max(dailyMax.get(amount.currency) ?? 0, Math.abs(amount.value)));
  const lastAttempt = Math.max(Date.parse(account?.lastAttemptAt ?? '') || 0, localAttempts[selected] ?? 0);
  const cooldown = Math.max(0, Math.ceil((lastAttempt + BILLING_REFRESH_COOLDOWN_MS - clock) / 1000));
  const refresh = useCallback(async (id: string, previousRefreshedAt?: string) => {
    if (refreshing.current) return;
    refreshing.current = true;
    setBusy(true);
    setLocalAttempts(prior => ({ ...prior, [id]: Date.now() }));
    setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/spending/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Refresh failed.');
      if (!Array.isArray(data)) throw new Error('Refresh returned an invalid response. Cached data is still shown.');
      const updated = (data as BillingAccountView[]).find(a => a.id === id);
      setAccounts(data);
      if (!updated?.enabled) setNotice('The billing account changed. Provider data was not updated.');
      else if (updated.lastError || !updated.snapshot) setNotice('Refresh did not update provider costs. Any previous snapshot is retained below.');
      else if (updated.snapshot.refreshedAt === previousRefreshedAt) setError('Provider costs were not updated. The billing account may have changed during refresh. Reload before retrying.');
      else setNotice('Provider costs updated. Limit availability is reported separately below.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Refresh failed.'); }
    finally { refreshing.current = false; setBusy(false); setClock(Date.now()); }
  }, []);
  useEffect(() => {
    // Refresh only the selected, enabled account while an administrator is viewing this page.
    // Both successful and failed attempts wait five minutes; the server independently fences claims.
    const check = () => {
      if (!account?.enabled || document.visibilityState !== 'visible') return;
      const attempted = Math.max(lastAttempt, Date.parse(account.snapshot?.refreshedAt ?? '') || 0);
      if (Date.now() - attempted >= BILLING_REFRESH_INTERVAL_MS) void refresh(account.id, account.snapshot?.refreshedAt);
    };
    check();
    const timer = setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, [account, lastAttempt, refresh]);
  const allowanceNote = stale || account?.lastError || error ? 'Current allowance is unknown while provider costs are stale or the latest refresh failed.'
    : ownLimit?.status !== 'known' || (project && snapshot?.organizationLimit.status !== 'known') ? 'Cannot calculate without readable monthly limits for the selected scope.'
    : 'Calculated from reported costs and limits; provider reporting may be delayed.';
  return <div className="space-y-5" aria-busy={busy}>
    <AdminHeader title="Provider spending" description="OpenAI API Platform · provider-reported monthly spending" />
    <p className="text-sm text-muted">Read-only. Costs may arrive late from OpenAI. Monthly spending allowance is separate from prepaid credit and ChatGPT / Codex subscription allowance.</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 text-sm">Billing account<select aria-label="Billing account" disabled={busy} className="mt-1 block w-full max-w-80 rounded-lg border border-border bg-surface px-3 py-2" value={selected} onChange={e => { setSelected(e.target.value); setProject(''); setError(''); setNotice(''); }}>
        {!accounts.length && <option value="">No billing accounts configured</option>}{accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.organization}</option>)}
      </select></label>
      {snapshot && <label className="min-w-0 text-sm">Scope<select aria-label="Spending scope" className="mt-1 block w-full max-w-80 rounded-lg border border-border bg-surface px-3 py-2" value={project} onChange={e => setProject(e.target.value)}>
        <option value="">Organization</option>{projectIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select></label>}
      <Button disabled={busy || !account?.enabled || cooldown > 0} onClick={() => void refresh(selected, snapshot?.refreshedAt)}>{busy ? 'Refreshing…' : cooldown > 0 ? `Refresh in ${cooldown}s` : 'Refresh provider data'}</Button>
    </div>
    <p className="text-xs text-muted">Automatically refreshes the selected enabled account every five minutes while this page is visible.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{(busy || notice) && <p role="status" className="text-sm">{busy ? 'Reading provider data… Cached costs remain visible until the request finishes.' : notice}</p>}
    {!account && <Card>Provider spending is off by default. An authorized administrator can configure a separate billing account below.</Card>}
    {account && <p className="break-words text-xs text-muted">Organization: {account.organization} · {account.enabled ? 'Enabled' : 'Off'} · Last refresh attempt: {account.lastAttemptAt ? <AdminTimestamp value={account.lastAttemptAt} /> : 'Never'}</p>}
    {account?.lastError && !error && <p role="alert" className="text-sm text-danger">{account.lastError}</p>}
    {account && !snapshot && <Card>{!account.enabled ? 'Provider spending is disabled. No billing reads are made.' : busy ? 'Loading provider costs…' : 'No successful provider snapshot yet. Refresh to read costs and limits.'}</Card>}
    {snapshot && <>
      <p className="text-sm text-muted">{snapshot.month} UTC · Provider data requested through <AdminTimestamp value={snapshot.through * 1000} /> · Last successful refresh: <AdminTimestamp value={snapshot.refreshedAt} /></p>
      {(stale || account?.lastError || error) && <p className="rounded-lg bg-surface-2 p-3 text-sm">{stale ? 'Stale snapshot. ' : ''}Historical reported costs are shown; current allowance is unknown until a successful refresh.</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label={project ? 'Project month-to-date costs' : 'Organization month-to-date costs'} value={amountsText(ownCosts, !!costsKnown)} sub="Actual provider-reported costs; reporting may be delayed" />
        <Stat label={project ? 'Project monthly spending limit' : 'Organization monthly spending limit'} value={limitText(ownLimit)} sub={limitDescription(ownLimit)} />
        <Stat label="Applicable remaining allowance" value={moneyText(available)} sub={allowanceNote} />
        {project && <Stat label="Parent organization limit" value={limitText(snapshot.organizationLimit)} sub={`Remaining: ${moneyText(remaining(snapshot.organizationLimit, snapshot.amounts, snapshot.costsStatus === 'known' && !stale && !account?.lastError && !error))} · ${limitDescription(snapshot.organizationLimit)}`} />}
      </div>
      <section aria-labelledby="spending-trends" className="space-y-3"><h2 id="spending-trends" className="font-semibold">Daily organization costs</h2>
        <p className="text-xs text-muted">Returned daily buckets only; missing days are not inferred. Bars are relative to the largest reported day in each currency.</p>
        {snapshot.costsStatus !== 'known' ? <p>Costs {snapshot.costsStatus.replaceAll('_', ' ')}.</p> : <Table head={['Day (UTC)', 'Reported costs', 'Trend']}>
          {!snapshot.daily.length && <tr><Td colSpan={3}>No daily costs returned for this period.</Td></tr>}
          {snapshot.daily.map(day => <tr key={day.start}><Td>{new Date(day.start * 1000).toISOString().slice(0, 10)}</Td><Td>{amountsText(day.amounts, true)}</Td><Td><div className="w-32 space-y-1" aria-hidden="true">{day.amounts.map(a => <div key={a.currency} className="h-2 overflow-hidden rounded bg-surface-2"><div className="h-full rounded bg-accent" style={{ width: `${a.value ? Math.max(1, Math.abs(a.value) / dailyMax.get(a.currency)! * 100) : 0}%` }} /></div>)}</div></Td></tr>)}
        </Table>}
      </section>
      <section aria-labelledby="spending-projects" className="space-y-3"><h2 id="spending-projects" className="font-semibold">Project breakdown</h2>
        <p className="text-xs text-muted">OpenAI identifies projects by ID. Limits are read for projects in saved provider connections; other project limits are marked Not read.</p>
        {snapshot.breakdownStatus !== 'known' ? <p>Project breakdown {snapshot.breakdownStatus.replaceAll('_', ' ')}. Organization costs remain available independently.</p> : <Table head={['Project', 'Month-to-date costs', 'Monthly limit', 'Enforcement']}>
          {!snapshot.projects.length && <tr><Td colSpan={4}>No project costs returned for this period.</Td></tr>}
          {snapshot.projects.map(row => <tr key={row.id ?? 'unattributed'}><Td className="break-all font-mono text-xs">{row.id ?? 'Unattributed by provider'}</Td><Td>{amountsText(row.amounts, true)}</Td><Td><span title={row.id ? limitDescription(snapshot.projectLimits[row.id]) : undefined}>{row.id ? limitText(snapshot.projectLimits[row.id]) : 'Not applicable'}</span></Td><Td>{row.id ? snapshot.projectLimits[row.id]?.enforcement ?? 'unknown' : 'unknown'}</Td></tr>)}
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
