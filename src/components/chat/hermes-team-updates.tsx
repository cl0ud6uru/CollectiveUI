"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { HermesTeamCapturedResource } from "./hermes-team-publication";

export type HermesTeamMemberConflict = {
  packageId: string;
  recorded: boolean;
  expectedMemberHash: string;
  expectedTeamHash: string;
  memberResources: HermesTeamCapturedResource[];
  teamResources: HermesTeamCapturedResource[];
};
export type HermesTeamUpdateInput = { expectedInstalledRevision: number | null; targetRevision?: number; requestId: string };
export type HermesTeamResolveInput = HermesTeamUpdateInput & {
  targetRevision: number;
  packageId: string;
  choice: "keep-member" | "use-team";
  expectedMemberHash: string;
  expectedTeamHash: string;
};
export type HermesTeamUpdateResult = { status: "complete" | "needs_attention" | "cancelled"; installedRevision: number | null; conflictCount: number; requestId: string };
export type HermesTeamUpdateReview = {
  installedRevision: number | null;
  targetRevision: number;
  publishedRevision: number;
  state: string;
  nativeUpdatesSupported: boolean;
  pendingRequestId?: string;
  pendingRequest?: { kind: "update"; input: HermesTeamUpdateInput } | { kind: "resolve"; input: HermesTeamResolveInput };
  changes: { packageId: string; action: "install" | "remove" | "preserve" | "conflict"; reason: string }[];
  conflicts: HermesTeamMemberConflict[];
  overrides?: (HermesTeamMemberConflict & { choice: "keep-member" | "deleted" })[];
};
export type HermesTeamUpdateActions = {
  onLoadUpdates?: (targetRevision?: number) => Promise<HermesTeamUpdateReview>;
  onApplyUpdate?: (input: HermesTeamUpdateInput) => Promise<HermesTeamUpdateResult>;
  onResolveUpdate?: (input: HermesTeamResolveInput) => Promise<HermesTeamUpdateResult>;
  onRollbackUpdate?: (input: HermesTeamUpdateInput & { targetRevision: number }) => Promise<HermesTeamUpdateResult>;
  onCancelUpdate?: (requestId: string) => Promise<HermesTeamUpdateResult>;
};
const nameFor = (id: string) => id === "SOUL.md" ? "Role instructions" : id.replace(/^(skills|documents)\//, "");
const reasonFor = (reason: string) => ({
  "team-changed": "New team content", "team-removed": "Removed by the team", "unchanged": "Already current",
  "member-modified": "Your changes are preserved", "member-deleted": "Your deletion is preserved", "member-override": "Your selected version is preserved",
  "independent-learning": "Your learned skill is preserved", "learned-collision": "Your learned skill shares this name",
}[reason] ?? "Your content will be preserved where it differs");
type Attempt = { kind: "rollback"; input: HermesTeamUpdateInput & { targetRevision: number } } | { kind: "update"; input: HermesTeamUpdateInput } | { kind: "resolve"; input: HermesTeamResolveInput };

/** This review receives only the signed-in member's previews. Admin rollout uses a separate aggregate API. */
export function HermesTeamMemberUpdates({ installedRevision, publishedRevision, conflictCount, busy, disabled = false, ...actions }: {
  installedRevision: number | null; publishedRevision: number; conflictCount: number; busy: boolean; disabled?: boolean;
} & HermesTeamUpdateActions) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<HermesTeamUpdateReview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [stale, setStale] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const workingRef = useRef(false);
  const locked = busy || disabled || working;
  async function perform(action: () => Promise<void>, request?: Attempt) {
    if (workingRef.current || busy || disabled) return;
    workingRef.current = true; setWorking(true); setError(""); setNotice("");
    try { await action(); }
    catch (err) {
      setError(err instanceof Error ? err.message : "The update was not confirmed. Retry the same request.");
      if (err instanceof Error && "status" in err && err.status === 409) { setStale(true); if (request?.kind === "resolve" && err.message === "Your skill changed. Review both versions again.") setRestartNeeded(true); }
      if (err instanceof Error && "status" in err && err.status === 403) { setReview(null); setOpen(false); }
    } finally { workingRef.current = false; setWorking(false); }
  }
  async function refresh(targetRevision?: number) {
    if (!actions.onLoadUpdates) return;
    await perform(async () => { setOpen(true); setReview(null); const next = await actions.onLoadUpdates!(targetRevision); setReview(next); setRestoring(targetRevision !== undefined); setAttempt(next.pendingRequest ?? null); if (!next.pendingRequestId) setRestartNeeded(false); setStale(false); });
  }
  async function run(next: Attempt) {
    await perform(async () => {
      setAttempt(next);
      const result = next.kind === "resolve" ? await actions.onResolveUpdate!(next.input) : next.kind === "rollback" ? await actions.onRollbackUpdate!(next.input) : await actions.onApplyUpdate!(next.input);
      if (result.status === "needs_attention") { setNotice("This update needs recovery. Retry the same request when your bot is idle."); return; }
      setAttempt(null); setStale(false); setRestartNeeded(false);
      const latest = await actions.onLoadUpdates!(restoring && result.status !== "cancelled" ? result.installedRevision ?? undefined : undefined); setReview(latest); if (result.status === "cancelled") setRestoring(false);
      setNotice(result.status === "cancelled" ? "This update was cancelled. Your existing content is preserved." : next.kind === "resolve" ? next.input.choice === "keep-member" ? `Kept your version of ${nameFor(next.input.packageId)}.` : `Applied the team version of ${nameFor(next.input.packageId)}.` : `Your private bot uses team version ${result.installedRevision ?? "pending"}.`);
    }, next);
  }
  function apply() {
    if (!review || !actions.onApplyUpdate || review.pendingRequestId) return;
    void run({ kind: restoring ? "rollback" : "update", input: { expectedInstalledRevision: review.installedRevision, targetRevision: review.targetRevision, requestId: crypto.randomUUID() } });
  }
  function resolve(conflict: HermesTeamMemberConflict, choice: HermesTeamResolveInput["choice"]) {
    if (!review || !actions.onResolveUpdate || review.pendingRequestId || !conflict.recorded) return;
    void run({ kind: "resolve", input: { expectedInstalledRevision: review.installedRevision, targetRevision: review.targetRevision,
      packageId: conflict.packageId, choice, expectedMemberHash: conflict.expectedMemberHash, expectedTeamHash: conflict.expectedTeamHash, requestId: crypto.randomUUID() } });
  }
  async function cancel() {
    if (!review?.pendingRequestId || !actions.onCancelUpdate) return;
    await perform(async () => { await actions.onCancelUpdate!(review.pendingRequestId!); setReview(await actions.onLoadUpdates!()); setRestoring(false); setAttempt(null); setStale(false); setRestartNeeded(false); setNotice("The untouched update was cancelled. Your existing content is preserved."); });
  }
  if (publishedRevision === 0 && !conflictCount && !installedRevision) return null;
  const reviewBlocked = stale || !!attempt || !!review?.pendingRequestId || review?.nativeUpdatesSupported !== true;
  const canResolve = review && review.installedRevision === review.targetRevision;
  return <>
    <Button size="sm" variant="outline" disabled={locked || !actions.onLoadUpdates} onClick={() => void refresh()}>{conflictCount > 0 ? `Review ${conflictCount} ${conflictCount === 1 ? "update" : "updates"}` : installedRevision !== publishedRevision ? "Review team update" : "Team updates"}</Button>
    {error && !open && <p role="alert" className="text-sm text-danger">{error}</p>}
    <Dialog open={open} onOpenChange={next => { if (!workingRef.current) { setOpen(next); setError(""); } }}>
      <DialogContent title="Review team updates" description="Review changes for your private bot. Your history, memory and learned skills stay private." className="max-w-2xl" hideClose={working}>
        <div className="space-y-4">
          {review && <>
            {!review.nativeUpdatesSupported && <p role="status" className="text-xs text-muted">Member installation is not supported by this connection yet. Your content is preserved.</p>}
            <p className="text-xs text-muted">Your installed team version: {review.installedRevision ?? "pending"}. Reviewing team version {review.targetRevision}.</p>
            {review.changes.length > 0 && <ul className="space-y-2 text-xs">{review.changes.map(change => <li key={change.packageId} className="min-w-0 wrap-anywhere"><span className="font-medium">{nameFor(change.packageId)}</span> · {reasonFor(change.reason)}</li>)}</ul>}
            {review.conflicts.map(conflict => <section key={conflict.packageId} aria-label={`Update ${nameFor(conflict.packageId)}`} className="space-y-3 rounded-lg border border-border p-3">
              <h3 className="text-sm font-medium wrap-anywhere">{nameFor(conflict.packageId)}</h3>
              {!conflict.memberResources.length && <p className="text-xs text-muted">You deleted this item. Keep my version preserves that choice.</p>}
              {!conflict.teamResources.length && <p className="text-xs text-muted">The team removed this item. Use team version accepts the removal.</p>}
              <ResourcePreview label="Preview your version" resources={conflict.memberResources} empty="Deleted by you" />
              <ResourcePreview label="Preview team version" resources={conflict.teamResources} empty="Removed from the team" />
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked || reviewBlocked || !canResolve || !conflict.recorded || !actions.onResolveUpdate} onClick={() => resolve(conflict, "keep-member")}>Keep my version</Button><Button size="sm" disabled={locked || reviewBlocked || !canResolve || !conflict.recorded || !actions.onResolveUpdate} onClick={() => resolve(conflict, "use-team")}>Use team version</Button></div>
            </section>)}
            {(review.conflicts.some(conflict => !conflict.recorded) || (review.conflicts.length > 0 && !canResolve)) && <p className="text-xs text-muted">Apply the safe team update first. Your changes will be preserved, then you can resolve recorded conflicts.</p>}
            {!!review.overrides?.length && <details className="min-w-0 text-xs"><summary className="cursor-pointer text-sm">Your saved choices</summary><div className="mt-3 space-y-3">{review.overrides.map(override => <section key={override.packageId} aria-label={`Saved choice ${nameFor(override.packageId)}`} className="min-w-0 space-y-2 rounded-lg border border-border p-3"><h3 className="wrap-anywhere text-sm font-medium">{nameFor(override.packageId)}</h3><p className="text-xs text-muted">{override.choice === "deleted" ? "You chose to keep this item deleted." : "You chose to keep your version."} You can explicitly reset this choice to the team version.</p><ResourcePreview label="Preview your version" resources={override.memberResources} empty="Deleted by you" /><ResourcePreview label="Preview team version" resources={override.teamResources} empty="Removed from the team" /><Button size="sm" variant="outline" disabled={locked || reviewBlocked || !canResolve || !actions.onResolveUpdate} onClick={() => resolve(override, "use-team")}>Use team version</Button></section>)}</div></details>}
            {actions.onRollbackUpdate && !review.pendingRequestId && !attempt && <details className="min-w-0 text-xs"><summary className="cursor-pointer text-sm">Restore an earlier team version</summary><div className="mt-3 space-y-2"><Field label="Team version to restore" hint={`Choose a published version from 0 to ${Math.max(0, (review.installedRevision ?? 0) - 1)}. Version 0 removes unchanged team resources.`}><Input type="number" aria-label="Team version to restore" min={0} max={Math.max(0, (review.installedRevision ?? 0) - 1)} step={1} value={restoreVersion} disabled={locked} onChange={event => setRestoreVersion(event.target.value)} /></Field><p className="text-xs text-muted">This restores only your private bot. Your modified, deleted and newly learned skills are preserved.</p><Button size="sm" variant="outline" disabled={locked || restoreVersion === "" || !Number.isSafeInteger(Number(restoreVersion)) || Number(restoreVersion) < 0 || Number(restoreVersion) >= (review.installedRevision ?? 0)} onClick={() => void refresh(Number(restoreVersion))}>Preview restore</Button></div></details>}
            {restoring && <p className="text-xs text-muted">Restoring your private bot to team version {review.targetRevision}. Review the changes before applying them.</p>}
            {!review.changes.length && !review.conflicts.length && <p className="text-sm">Your team resources are current. Your personal learning stays in place.</p>}
            {review.pendingRequestId && <p className="text-xs text-muted">An earlier update needs recovery. Resume its exact request, or cancel it if no files have been applied.</p>}
          </>}
          {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {stale && <p className="text-xs text-muted">This preview changed. Refresh it before choosing a version. An unfinished update may require recovery.</p>}
          {error && !review && <p className="text-xs text-muted">Your content is preserved. Ask an admin to check native member update support, then review again.</p>}
          {restartNeeded && review?.pendingRequestId && <p className="text-xs text-muted">The original resolution used an outdated skill preview. Cancel the untouched update, then review the current versions before making a new choice.</p>}
          {attempt && !stale && !restartNeeded && <p className="text-xs text-muted">Retry uses the same reviewed hashes, version and request. Other choices stay locked until this result is confirmed.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={locked} onClick={() => { setOpen(false); setError(""); }}>Done</Button>
            {review?.pendingRequestId && actions.onCancelUpdate && <Button variant="outline" disabled={locked} onClick={() => void cancel()}>Cancel untouched update</Button>}
            {attempt && !stale && !restartNeeded ? <Button disabled={locked || (attempt.kind === "resolve" ? !actions.onResolveUpdate : attempt.kind === "rollback" ? !actions.onRollbackUpdate : !actions.onApplyUpdate)} onClick={() => void run(attempt)}>{working && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}Resume same update</Button> : stale || !review ? <Button disabled={locked} onClick={() => void refresh(restoring ? review?.targetRevision : undefined)}>Refresh review</Button> : !review.pendingRequestId && (review.installedRevision !== review.targetRevision || (review.conflicts.some(conflict => !conflict.recorded) || (review.conflicts.length > 0 && !canResolve))) ? <Button disabled={locked || review.nativeUpdatesSupported !== true || (restoring ? !actions.onRollbackUpdate : !actions.onApplyUpdate)} onClick={apply}>{restoring ? "Restore my team version" : "Apply team update"}</Button> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function ResourcePreview({ label, resources, empty }: { label: string; resources: HermesTeamCapturedResource[]; empty: string }) {
  return <details className="min-w-0 text-xs"><summary className="cursor-pointer text-sm">{label}</summary><div className="mt-2 space-y-2">{resources.length ? resources.map(resource => <details key={resource.path} className="min-w-0 rounded-lg bg-surface-2/50 p-2"><summary className="cursor-pointer break-all font-mono">{resource.path}</summary><div className="mt-2 min-w-0 space-y-2"><p className="break-all font-mono text-muted">SHA-256 {resource.sha256} · {resource.size} bytes</p>{resource.encoding === "utf8" ? <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono">{resource.content}</pre> : <p>Binary asset included in this complete skill package.</p>}</div></details>) : <p>{empty}</p>}</div></details>;
}
