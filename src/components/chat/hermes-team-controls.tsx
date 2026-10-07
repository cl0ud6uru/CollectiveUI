"use client";

import { useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { publicationPackageFiles, publicationResourceKind, publicationResourceName, type HermesTeamCaptureInventory, type HermesTeamCaptureSelection, type HermesTeamCapturedResource, type HermesTeamReview, type HermesTeamPublishInput } from "./hermes-team-publication";
import { HermesTeamMemberUpdates, type HermesTeamUpdateActions } from "./hermes-team-updates";
import { HermesTeamRolloutSummary, type HermesTeamRolloutStatus } from "./hermes-team-rollout";
import { HermesTeamRestorePicker, type HermesTeamRevision } from "./hermes-team-restore";
export type { HermesTeamReview, HermesTeamPublishInput } from "./hermes-team-publication";

export type HermesTeamMode = "member" | "admin";
export type HermesTeamView = {
  enabled: boolean;
  mode: HermesTeamMode;
  canMaintain: boolean;
  state: "preparing" | "connection_needed" | "ready" | "updating" | "needs_attention" | "revoked";
  installedRevision: number | null;
  publishedRevision: number;
  conflictCount: number;
  modelAccessAvailable?: boolean;
  modelAccessReason?: string;
  modelPolicyMode?: "admin_provided" | "admin_default_personal_allowed" | "personal_required";
  personalAllowed?: boolean;
  personalRequired?: boolean;
};

const stateLabels: Record<HermesTeamView["state"], string> = {
  preparing: "Preparing your bot…",
  connection_needed: "Model connection needed",
  ready: "Ready",
  updating: "Updating team resources…",
  needs_attention: "Needs attention",
  revoked: "Access removed",
};
const changeLabels = { added: "Added", changed: "Changed", removed: "Removal" };

/** Every callback uses server-derived bot/conversation identity; mode changes navigate to a new context. */
export function HermesTeamControls({ view, busy = false, onOpenMode, onPrepareCapture, onCapture, onPublish, onLoadRollout, onLoadRevisions, onCaptureRollback, ...updateActions }: {
  view: HermesTeamView;
  busy?: boolean;
  onOpenMode?: (mode: HermesTeamMode) => Promise<void>;
  onPrepareCapture?: () => Promise<HermesTeamCaptureInventory>;
  onCapture?: (selection: HermesTeamCaptureSelection) => Promise<HermesTeamReview>;
  onPublish?: (input: HermesTeamPublishInput) => Promise<{ revision: number }>;
  onLoadRollout?: () => Promise<HermesTeamRolloutStatus>;
  onLoadRevisions?: () => Promise<HermesTeamRevision[]>;
  onCaptureRollback?: (targetRevision: number) => Promise<HermesTeamReview>;
} & HermesTeamUpdateActions) {
  const id = useId();
  const [operation, setOperation] = useState<string | null>(null);
  const operationRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState<HermesTeamReview | null>(null);
  const [inventory, setInventory] = useState<HermesTeamCaptureInventory | null>(null);
  const [documents, setDocuments] = useState<string[]>([]);
  const [staleReview, setStaleReview] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [releaseNote, setReleaseNote] = useState("");
  const publishAttempt = useRef<HermesTeamPublishInput | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [rollout, setRollout] = useState<HermesTeamRolloutStatus | null>(null);
  const [rolloutError, setRolloutError] = useState("");
  const [revisions, setRevisions] = useState<HermesTeamRevision[]>([]);
  const [revisionError, setRevisionError] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [rolloutOpen, setRolloutOpen] = useState(false);

  async function perform(name: string, action: () => Promise<void>) {
    if (operationRef.current || busy) return;
    operationRef.current = true;
    setOperation(name); setError(""); setNotice("");
    try { await action(); }
    catch (err) {
      setError(err instanceof Error ? err.message : "The operation was not confirmed. Try again.");
      if (name === "publish" && err instanceof Error && "status" in err && err.status === 409) setStaleReview(true);
      if (err instanceof Error && "status" in err && err.status === 403) { setReviewOpen(false); setReview(null); }
    }
    finally { operationRef.current = false; setOperation(null); }
  }
  function acceptReview(next: HermesTeamReview, targetRevision: number | null = null) {
    setRestoreTarget(targetRevision);
    setReview(next); setSelected([]); setReleaseNote(""); setAttempted(false); setStaleReview(false); publishAttempt.current = null;
    setReviewOpen(true);
  }
  async function prepareCapture() {
    if (!onPrepareCapture || !onCapture || !view.canMaintain || view.mode !== "admin") return;
    await perform("capture", async () => {
      const [prepared, summary, history] = await Promise.allSettled([onPrepareCapture(), onLoadRollout?.(), onLoadRevisions?.()]);
      if (history.status === "rejected" && history.reason?.status === 403) throw history.reason;
      if (history.status === "fulfilled") { setRevisions(history.value ?? []); setRevisionError(""); }
      else setRevisionError(history.reason instanceof Error ? history.reason.message : "Published versions could not be loaded.");
      if (summary.status === "fulfilled") { setRollout(summary.value ?? null); setRolloutError(""); }
      else setRolloutError(summary.reason instanceof Error ? summary.reason.message : "Rollout status could not be loaded.");
      // Shared immutable history can still be reviewed when native working-profile capture is unavailable.
      if (prepared.status === "rejected" && (prepared.reason?.status === 403 || history.status !== "fulfilled" || !history.value?.some(revision => revision.revision < view.publishedRevision))) throw prepared.reason;
      const next: HermesTeamCaptureInventory = prepared.status === "fulfilled" ? prepared.value : { available: false, reason: prepared.reason instanceof Error ? prepared.reason.message : "Native resource review is unavailable.", selection: { skillPackages: [], includeRole: false, documents: [] } };
      setInventory(next); setDocuments([]); setReview(null); setRestoreTarget(null); setStaleReview(false); setAttempted(false); publishAttempt.current = null; setSelected([]); setReleaseNote(""); setReviewOpen(true);
      if (next.available && !next.selection.documents.length) acceptReview(await onCapture({ ...next.selection, documents: [] }));
    });
  }
  async function capture() {
    if (!inventory?.available || !onCapture || !view.canMaintain || view.mode !== "admin") return;
    await perform("capture", async () => {
      acceptReview(await onCapture({ ...inventory.selection, documents }));
    });
  }
  async function captureRollback(targetRevision: number) {
    if (!onCaptureRollback || !view.canMaintain || view.mode !== "admin" || attempted && !staleReview) return;
    await perform("restore", async () => acceptReview(await onCaptureRollback(targetRevision), targetRevision));
  }
  async function publish() {
    if (!review || !onPublish || !selected.length || !releaseNote.trim() || !view.canMaintain || view.mode !== "admin") return;
    await perform("publish", async () => {
      publishAttempt.current ??= { snapshotId: review.snapshotId, expectedRevision: review.expectedRevision,
        selectedKeys: review.changes.filter(change => selected.includes(change.packageId) && change.change !== "removed").map(change => change.packageId),
        removalKeys: review.changes.filter(change => selected.includes(change.packageId) && change.change === "removed").map(change => change.packageId),
        releaseNote: releaseNote.trim(), requestId: crypto.randomUUID() };
      setAttempted(true);
      const result = await onPublish(publishAttempt.current);
      setReviewOpen(false); setReview(null); setNotice(`Published team version ${result.revision}.`);
    });
  }
  async function loadRollout() {
    if (!onLoadRollout || !view.canMaintain || view.mode !== "admin") return;
    await perform("rollout", async () => { setRollout(await onLoadRollout()); setRolloutError(""); setRolloutOpen(true); });
  }
  if (!view.enabled) return null;
  const locked = !!operation || busy || view.state === "revoked";
  const canCapture = view.state !== "preparing" && view.state !== "updating" && view.state !== "revoked";
  const admin = view.mode === "admin";
  const modelUnavailable = view.modelAccessAvailable === false;
  return <section className="mx-auto w-full max-w-3xl space-y-2 px-4 py-2" aria-label="Hermes Team Bot controls">
    <div className="space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-surface-2 px-2 py-1 font-medium">{admin ? "Admin mode" : "Private chat"}</span>
          <span className="flex items-center gap-1.5 text-muted" role="status">{(view.state === "preparing" || view.state === "updating") && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}{modelUnavailable && (view.state === "connection_needed" || view.state === "ready") ? "Model access unavailable" : stateLabels[view.state]}</span>
          {view.publishedRevision > 0 && <span className="text-muted">Team version {admin ? view.publishedRevision : view.installedRevision ?? "pending"}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view.canMaintain && <label className="flex min-h-9 items-center gap-2 text-sm" htmlFor={`${id}-mode`}>
            <input id={`${id}-mode`} type="checkbox" role="switch" checked={admin} disabled={locked || !onOpenMode} aria-describedby={`${id}-mode-description`} onChange={(event) => {
              const mode = event.target.checked ? "admin" : "member";
              if (onOpenMode) void perform("mode", () => onOpenMode(mode));
            }} className="h-4 w-4 accent-[var(--accent)]" />
            Admin mode
          </label>}
          {admin && view.canMaintain && <Button size="sm" variant="outline" disabled={locked || !canCapture || !onPrepareCapture || !onCapture || !onPublish} onClick={() => void prepareCapture()}>{operation === "capture" && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}Publish changes</Button>}
          {admin && view.canMaintain && onLoadRollout && <Button size="sm" variant="outline" disabled={locked} onClick={() => void loadRollout()}>Team status</Button>}
          {!admin && <HermesTeamMemberUpdates installedRevision={view.installedRevision} publishedRevision={view.publishedRevision} conflictCount={view.conflictCount} busy={locked} disabled={view.state === "preparing" || view.state === "updating" || view.state === "revoked"} {...updateActions} />}
        </div>
      </div>
      {view.canMaintain && <p id={`${id}-mode-description`} className="text-xs text-muted">Admin mode opens a separate conversation. Maintainers share this working bot’s skills and native memory. Your private chat and other maintainers’ conversations stay separate.</p>}
      {!admin && <p className="text-xs text-muted">Your chat history, memory and new skills stay private. Team updates preserve your own changes.</p>}
      {modelUnavailable && view.state !== "revoked" && <p className="text-sm">{view.modelAccessReason?.trim() || "Team model access is unavailable in this build. Ask an admin to configure a supported model connection."}</p>}
      {view.state === "connection_needed" && !modelUnavailable && <p className="text-sm">Connect or reconnect the required model account in <a href="/settings?tab=connected-accounts" className="underline">Settings</a> to continue.</p>}
      {view.state === "needs_attention" && <p className="text-xs text-muted">This bot is paused. Ask an admin to check its configuration, or try again after the issue is resolved.</p>}
      {view.state === "revoked" && <p className="text-xs text-muted">Your access to this Team Bot was removed. Ask an admin if you need access again.</p>}
      {view.canMaintain && !onOpenMode && <p className="text-xs text-muted">Open this bot in a compatible web version to switch Admin mode.</p>}
      {admin && (!onPrepareCapture || !onCapture || !onPublish) && <p className="text-xs text-muted">Publishing is not available in this version. Ask an admin to check resource review support.</p>}
      {!admin && view.conflictCount > 0 && (!updateActions.onLoadUpdates || !updateActions.onResolveUpdate) && <p className="text-xs text-muted">Your changes are preserved. Open a compatible web version to review these updates.</p>}
    </div>
    {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
    {error && !reviewOpen && !rolloutOpen && <p role="alert" className="text-sm text-danger">{error}</p>}

    <Dialog open={reviewOpen && admin && view.canMaintain} onOpenChange={(open) => { if (!operationRef.current) { setReviewOpen(open); setError(""); } }}>
      <DialogContent title="Publish changes" description="Choose exactly what the team will receive from this snapshot." className="max-w-2xl" hideClose={operation === "publish"}>
        {rollout && <HermesTeamRolloutSummary status={rollout} />}
        {rolloutError && <p role="alert" className="text-xs text-danger">{rolloutError}</p>}
        {revisionError && <p className="text-xs text-muted">{revisionError}</p>}
        {onCaptureRollback && <HermesTeamRestorePicker key={`${view.publishedRevision}:${review?.snapshotId ?? "draft"}`} revisions={revisions} publishedRevision={view.publishedRevision} disabled={locked || attempted} onReview={targetRevision => void captureRollback(targetRevision)} />}
        {!review && inventory && <div className="space-y-4">
          {!inventory.available ? <><p role="status" className="text-sm">{inventory.reason ?? "Resource review is unavailable for this bot."}</p><p className="text-xs text-muted">Ask an admin to check native resource review, then try again.</p></> : <>
            <p className="text-sm">Review the working bot’s skills{inventory.selection.includeRole ? " and role instructions" : ""}. Select any shared documents to include.</p>
            {inventory.selection.documents.length > 0 && <fieldset disabled={locked} className="min-w-0 space-y-2"><legend className="mb-2 text-sm font-medium">Shared documents</legend>{inventory.selection.documents.map(document => <label key={document} className="flex items-start gap-3 text-sm"><input type="checkbox" aria-label={`Include document ${document}`} checked={documents.includes(document)} onChange={event => setDocuments(current => event.target.checked ? [...current, document] : current.filter(value => value !== document))} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" /><span className="min-w-0 wrap-anywhere">{document}</span></label>)}</fieldset>}
            <p className="text-xs text-muted">The next step shows the captured content. You choose which changes and removals to publish.</p>
          </>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={locked} onClick={() => { setReviewOpen(false); setError(""); }}>Cancel</Button>{inventory.available ? <Button disabled={locked} onClick={() => void capture()}>{operation === "capture" && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}Capture changes</Button> : <Button disabled={locked} onClick={() => void prepareCapture()}>Review again</Button>}</div>
        </div>}
        {review && <div className="space-y-4">
          {restoreTarget !== null && <p className="text-sm">Reviewing shared resources from team version {restoreTarget}. Publish only the changes you select as a new team version.</p>}
          <p className="text-xs text-muted">Based on team version {review.expectedRevision}. This captured snapshot stays fixed; later learning belongs to the next draft.</p>
          <p className="text-xs text-muted">Credentials, personal memory, conversations, browser sessions, logs and caches are excluded.</p>
          <p className="text-xs text-muted">Review expires {new Date(review.expiresAt).toLocaleString()}. Skills include their scripts and assets; publication does not run them.</p>
          {review.changes.length ? <fieldset disabled={locked || attempted} className="min-w-0 space-y-3">
            <legend className="sr-only">Resources to publish</legend>
            {review.changes.map((resource) => <div key={resource.packageId} className="rounded-lg border border-border p-3">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={selected.includes(resource.packageId)} aria-label={`Publish ${publicationResourceName(resource)}`} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, resource.packageId] : ids.filter((key) => key !== resource.packageId))} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
                <span className="min-w-0 wrap-anywhere"><span className="font-medium">{publicationResourceName(resource)}</span><span className="mt-0.5 block text-xs text-muted">{publicationResourceKind(resource)} · {changeLabels[resource.change]} · {publicationPackageFiles(resource).length} {publicationPackageFiles(resource).length === 1 ? "file" : "files"}</span></span>
              </label>
              <div className="mt-2 space-y-2">{publicationPackageFiles(resource).map(file => <PackageFilePreview key={file.path} {...file} />)}</div>
              {resource.change === "removed" && <p className="mt-2 text-xs text-muted">Removes only an unchanged team-owned copy. Members keep their own changes.</p>}
            </div>)}
          </fieldset> : <p className="text-sm">{restoreTarget === null ? "No publishable changes yet. Teach the bot in Admin mode, then review again." : "This shared version has no differences to publish."}</p>}
          <Field label="Release note" hint="A short explanation for the people using this bot.">
            <Textarea aria-label="Team release note" rows={2} maxLength={500} value={releaseNote} disabled={locked || attempted} onChange={(event) => setReleaseNote(event.target.value)} placeholder="What changed and why?" />
          </Field>
          {attempted && error && <p className="text-xs text-muted">{staleReview ? "This snapshot can no longer be published. Review the latest changes before publishing." : "Retry sends the same snapshot, selection and release note. Close this review to capture a fresh draft."}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={locked} onClick={() => { setReviewOpen(false); setError(""); }}>Cancel</Button>
            {staleReview ? <Button disabled={locked} onClick={() => void (restoreTarget === null ? prepareCapture() : captureRollback(restoreTarget))}>Review again</Button> : <Button disabled={locked || !selected.length || !releaseNote.trim()} onClick={() => void publish()}>{operation === "publish" && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}{attempted && error ? "Retry publish" : `Publish ${selected.length} ${selected.length === 1 ? "item" : "items"}`}</Button>}
          </div>
        </div>}
      </DialogContent>
    </Dialog>
    <Dialog open={rolloutOpen && admin && view.canMaintain} onOpenChange={open => { if (!operationRef.current) { setRolloutOpen(open); setError(""); } }}>
      <DialogContent title="Team status" description="Overall update status. Members review their own private content.">
        {rollout && <HermesTeamRolloutSummary status={rollout} />}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end"><Button variant="outline" disabled={locked} onClick={() => setRolloutOpen(false)}>Done</Button></div>
      </DialogContent>
    </Dialog>
  </section>;
}

function PackageFilePreview({ path, before, after }: { path: string; before?: HermesTeamCapturedResource; after?: HermesTeamCapturedResource }) {
  const changed = before?.sha256 !== after?.sha256;
  return <details className="min-w-0 rounded-lg bg-surface-2/50 p-2 text-xs">
    <summary className="cursor-pointer break-all font-mono">{path}<span className="ml-2 whitespace-nowrap font-sans text-muted">{!before ? "Added file" : !after ? "Removed file" : changed ? "Changed file" : "Included file"}</span></summary>
    <div className="mt-2 min-w-0 space-y-3">
      {([{ label: "Previous content", resource: before }, { label: "Reviewed content", resource: after }] as const).map(({ label, resource }) => resource && <div key={label}>
        <p className="mb-1 text-muted">{label} · {resource.size} bytes</p>
        <p className="mb-2 break-all font-mono text-muted">SHA-256 {resource.sha256}</p>
        {resource.encoding === "utf8" ? <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono">{resource.content}</pre> : <p>Binary asset included in the complete skill package. Its bytes are preserved in this reviewed snapshot.</p>}
      </div>)}
      {!after && <p>This file is removed in the selected team version.</p>}
    </div>
  </details>;
}
