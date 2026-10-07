"use client";

/** Aggregate server response. Member IDs, private contents and member hashes never enter this view. */
export type HermesTeamRolloutStatus = {
  publishedRevision: number;
  nativeUpdatesSupported: boolean;
  profileCount: number;
  states: Record<string, number>;
  conflictCount: number;
  conflictedProfileCount: number;
  updatesNeeded: number;
  reason?: string;
};

export function HermesTeamRolloutSummary({ status }: { status: HermesTeamRolloutStatus }) {
  const counts = [
    ["Ready", status.states.ready ?? 0],
    ["Updating", status.states.updating ?? 0],
    ["Waiting for update", status.updatesNeeded],
    ["People with conflicts", status.conflictedProfileCount],
    ["Model connection needed", status.states.connection_needed ?? 0],
    ["Needs attention", status.states.needs_attention ?? 0],
  ] as const;
  return <section aria-label="Team rollout status" className="space-y-2 rounded-lg border border-border p-3">
    <h3 className="text-sm font-medium">Team version {status.publishedRevision} · Member updates</h3>
    {status.profileCount ? <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">{counts.map(([label, count]) => <div key={label} className="min-w-0"><dt className="text-muted wrap-anywhere">{label}</dt><dd className="mt-0.5 font-medium">{count}</dd></div>)}</dl> : <p className="text-xs text-muted">No one has opened this bot yet.</p>}
    {status.conflictCount > 0 && <p className="text-xs text-muted">Members review their own conflicts. Their skill content stays private.</p>}
    {!status.nativeUpdatesSupported && <p role="status" className="text-xs text-muted">{status.reason ?? "Member installation is not supported by this connection yet. Published versions remain available for review."}</p>}
  </section>;
}
