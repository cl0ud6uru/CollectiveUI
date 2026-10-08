'use client';
import { useEffect, useState } from 'react';
import { applicableRemaining, moneyText, type BillingAccountView } from '@/lib/billing/contracts';
/** Admin-only cached read; off unless an account explicitly opts in. Never initiates provider refreshes. */
export function SpendingHealth() {
  const [accounts, setAccounts] = useState<BillingAccountView[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/admin/spending', { cache: 'no-store', signal: abort.signal }).then(async res => {
      if (res.ok) setAccounts((await res.json()).filter((a: BillingAccountView) => a.enabled && a.showHealthBar));
    }).catch(() => {});
    return () => abort.abort();
  }, []);
  return accounts.length ? <a href="/admin/spending" className="max-w-28 rounded-lg border border-border px-2 py-1 text-[10px] hover:bg-hover" title={accounts.map(a => `${a.name} (${a.organization}): ${moneyText(a.snapshot && !a.lastError ? applicableRemaining(a.snapshot, null) : null)} reported remaining`).join('\n')}>
    API spending<div className="mt-1 flex h-1 gap-1" aria-hidden="true">{accounts.map(a => {
      const limit = a.snapshot?.organizationLimit; const amount = a.snapshot && !a.lastError ? applicableRemaining(a.snapshot, null) : null;
      const percent = amount && limit?.amount ? Math.max(0, Math.min(100, amount.value / limit.amount * 100)) : null;
      return <div key={a.id} className="flex-1 overflow-hidden rounded bg-border"><div className="h-full bg-accent" style={{ width: percent === null ? '0%' : `${percent}%` }} /></div>;
    })}</div><span className="sr-only">Open the organization provider spending dashboard. This bar covers configured billing accounts.</span>
  </a> : null;
}
