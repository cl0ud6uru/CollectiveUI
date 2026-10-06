'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Search } from 'lucide-react';
import { updateDockerEnrollment } from '@/app/admin/hermes/enrollment-actions';
import type { DockerReadiness } from '@/lib/docker-hermes/enrollment';
import { Badge, Card, Table, Td } from '@/components/admin/ui';
import { Button } from '@/components/ui/button';
import { HermesNetworkControl, useHermesNetworks } from './hermes-network-control';
import { cn } from '@/lib/utils';

type Person = { id: string; name: string; upn: string; enabled: boolean; cleanup: string; error: string | null; changedBy: string | null; changedAt: string | null };

const READINESS = {
  'not-configured': { label: 'Not configured', dot: 'bg-subtle' },
  unavailable: { label: 'Unavailable', dot: 'bg-danger' },
  ready: { label: 'Ready', dot: 'bg-success' },
} as const;
const CLEANUP: Record<string, { label: string; tone: 'default' | 'amber' | 'red' } | undefined> = {
  pending: { label: 'Stop pending', tone: 'amber' },
  stopping: { label: 'Stopping', tone: 'amber' },
  failed: { label: 'Stop failed', tone: 'red' },
  stopped: { label: 'Stopped · data kept', tone: 'default' },
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function DockerHermesEnrollment({ people, readiness, legacyConfigured }: { people: Person[]; readiness: DockerReadiness; legacyConfigured: boolean }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const router = useRouter();
  const networks = useHermesNetworks(readiness.status === 'ready');
  function update(id: string, enabled: boolean) {
    start(async () => {
      setMessage('');
      try { const result = await updateDockerEnrollment(id, enabled); setMessage(result.error ?? (enabled ? 'Permission saved. The user can enable Hermes in Settings.' : 'Permission revoked. Check runtime cleanup status below.')); router.refresh(); }
      catch { setMessage('The request failed. Refresh the status before retrying.'); }
    });
  }
  const status = READINESS[readiness.status];
  const needle = query.trim().toLowerCase();
  const shown = people.filter(person => `${person.name} ${person.upn}`.toLowerCase().includes(needle));
  const allowed = people.filter(person => person.enabled).length;
  return <section aria-labelledby="personal-enrollment-title" className="space-y-5">
    <h2 id="personal-enrollment-title" className="sr-only">Personal Docker Hermes enrollment</h2>

    <Card className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-center gap-2 font-medium"><span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', status.dot)} />Broker readiness: {status.label}</p>
        <p className="text-sm text-muted">{readiness.message}</p>
      </div>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => { router.refresh(); void networks.refresh(); }} aria-label="Refresh enrollment and broker status">
        <RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} aria-hidden="true" /> Refresh
      </Button>
    </Card>

    {legacyConfigured && <p role="note" className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      A legacy allowlist (<code>DOCKER_HERMES_ALLOWED_USER_IDS</code>) is configured but no longer grants access. An operator must review it and import it with the documented migration command. Revocations made here are never overwritten.
    </p>}

    <details className="group rounded-2xl border border-border px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">How personal runtimes work</summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
        <li>Nobody has access until you allow it here, administrators included.</li>
        <li>Allowing doesn&apos;t create anything. The person turns Hermes on in Settings → Connected accounts → Personal Hermes, then sets up their model provider.</li>
        <li>Internet access is a separate per-person policy shared by their native profiles. Existing offline and restricted proxy policies stay in place until you approve a change. Fresh installations use Standard Internet.</li>
        <li>Revoking blocks setup, chat and profile access right away and stops their runtime. Their sessions, skills, memory and bots are kept. If a stop fails, the worker retries it.</li>
      </ul>
    </details>

    <div className="flex flex-wrap items-center gap-3">
      <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-2 px-4 sm:max-w-sm">
        <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search people" aria-label="Search people" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
      </label>
      <span className="text-sm text-muted tabular-nums">{allowed} of {people.length} allowed</span>
    </div>
    <p role="status" aria-live="polite" className={cn('text-sm', !pending && !message && 'sr-only')}>{pending ? 'Saving permission and checking cleanup…' : message}</p>

    {networks.error && <p role="alert" className="text-sm text-danger">{networks.error}</p>}
    <Table head={['Person', 'Personal Hermes', 'Internet access', 'Runtime', 'Last change']}>
      {shown.map(person => {
        const cleanup = CLEANUP[person.cleanup];
        const stopping = !person.enabled && ['pending', 'stopping', 'failed'].includes(person.cleanup);
        return <tr key={person.id} className="align-top">
          <Td className="min-w-48"><div className="font-medium">{person.name}</div><div className="break-all text-xs text-muted">{person.upn}</div></Td>
          <Td>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-[var(--fg)]" checked={person.enabled} disabled={pending || (!person.enabled && !['none', 'stopped'].includes(person.cleanup))}
                onChange={event => update(person.id, event.target.checked)} aria-label={`Allow personal Hermes for ${person.name} (${person.upn})`} />
              <span className={person.enabled ? '' : 'text-muted'}>{person.enabled ? 'Allowed' : 'Off'}</span>
            </label>
          </Td>
          <Td><HermesNetworkControl owner={person.id} name={person.name} enabled={person.enabled && person.cleanup === 'none'} status={networks.status(person.id)} reload={networks.refresh} /></Td>
          <Td className="min-w-40">
            {cleanup ? <Badge tone={cleanup.tone}>{cleanup.label}</Badge> : <span className="text-subtle">—</span>}
            {person.error && <p role="alert" className="mt-1 text-xs text-danger">{person.error}</p>}
            {stopping && <Button variant="outline" size="sm" className="mt-2" disabled={pending} onClick={() => update(person.id, false)} aria-label={`Retry runtime stop for ${person.name}`}>Retry stop</Button>}
          </Td>
          <Td className="min-w-40 text-xs text-muted">
            {person.changedAt ? <>{person.changedBy ?? 'Deleted administrator'}<br /><time dateTime={person.changedAt} suppressHydrationWarning>{when(person.changedAt)}</time></> : <span className="text-subtle">Never</span>}
          </Td>
        </tr>;
      })}
      {!shown.length && <tr><Td colSpan={5} className="py-6 text-center text-muted">No one matches “{query.trim()}”.</Td></tr>}
    </Table>
  </section>;
}
