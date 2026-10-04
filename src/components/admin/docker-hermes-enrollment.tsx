'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateDockerEnrollment } from '@/app/admin/hermes/enrollment-actions';
import type { DockerReadiness } from '@/lib/docker-hermes/enrollment';
type Person = { id: string; name: string; upn: string; enabled: boolean; cleanup: string; error: string | null; changedBy: string | null; changedAt: string | null };
export function DockerHermesEnrollment({ people, readiness, legacyConfigured }: { people: Person[]; readiness: DockerReadiness; legacyConfigured: boolean }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const router = useRouter();
  function update(id: string, enabled: boolean) {
    start(async () => {
      setMessage('');
      try { const result = await updateDockerEnrollment(id, enabled); setMessage(result.error ?? (enabled ? 'Permission saved. The user can enable Hermes in Settings.' : 'Permission revoked. Check runtime cleanup status below.')); router.refresh(); }
      catch { setMessage('The request failed. Refresh the status before retrying.'); }
    });
  }
  const readinessLabel = { 'not-configured': 'Not configured', unavailable: 'Unavailable', ready: 'Ready' }[readiness.status];
  return <section aria-labelledby="personal-enrollment-title" className="max-w-4xl space-y-4 p-6">
    <h2 id="personal-enrollment-title" className="text-lg font-semibold">Personal Docker Hermes enrollment</h2>
    <div className="rounded-xl border border-border p-4 space-y-2 text-sm">
      <p><strong>Broker readiness: {readinessLabel}</strong></p><p>{readiness.message}</p>
      <p>Every user starts without permission, including administrators. Allowing personal Hermes does not create a runtime or configure provider authentication. Enrolled users choose Settings → Connected accounts → Personal Hermes → Enable.</p>
      <p>Revoking permission immediately denies new setup, chat and profile access, invalidates broker leases and requests a runtime stop. Native volumes, sessions, skills, memory, bots and ownership mappings are retained. Failed stops are retried by the worker.</p>
      {legacyConfigured && <p role="status">A legacy allowlist is configured and is no longer authoritative. An operator must review and explicitly import it using the documented migration command. Existing Admin revocations are never overwritten.</p>}
    </div>
    <p role="status" aria-live="polite">{pending ? 'Saving permission and checking cleanup…' : message}</p>
    <button type="button" className="rounded border border-border px-3 py-2 text-sm" disabled={pending} onClick={() => router.refresh()}>Refresh enrollment and broker status</button>
    <ul className="space-y-3">{people.map(person => <li key={person.id} className="rounded-xl border border-border p-4 space-y-2 text-sm break-words">
      <p className="font-medium">{person.name} <span className="text-muted font-normal">({person.upn})</span></p>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={person.enabled} disabled={pending || (!person.enabled && !['none', 'stopped'].includes(person.cleanup))} onChange={event => update(person.id, event.target.checked)} aria-label={`Allow personal Hermes for ${person.name} (${person.upn})`} />Allow personal Hermes</label>
      <p>Permission: {person.enabled ? 'Allowed' : 'Disabled'} · Runtime cleanup: {({ none: 'Not requested', pending: 'Stop pending', stopping: 'Stopping', failed: 'Stop failed — retry required', stopped: 'Stopped — data retained' } as Record<string, string>)[person.cleanup]}</p>
      {person.error && <p role="alert" className="text-danger">{person.error}</p>}
      {!person.enabled && ['pending', 'stopping', 'failed'].includes(person.cleanup) && <button type="button" disabled={pending} className="min-h-11 rounded border border-border px-3 py-2" onClick={() => update(person.id, false)}>Retry runtime stop for {person.name}</button>}
      {person.changedAt && <p className="text-xs text-muted">Last permission change: {person.changedBy ?? 'Deleted administrator'} · <time dateTime={person.changedAt}>{person.changedAt}</time></p>}
    </li>)}</ul>
  </section>;
}
