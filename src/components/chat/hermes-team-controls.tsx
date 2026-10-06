"use client";

import { useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { publicationPackageFiles, publicationResourceKind, publicationResourceName, type HermesTeamCaptureInventory, type HermesTeamCaptureSelection, type HermesTeamCapturedResource, type HermesTeamReview, type HermesTeamPublishInput } from "./hermes-team-publication";
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
};
export type HermesTeamFilePreview = { path: string; before?: string | null; after?: string | null; diff?: string; binary?: boolean };
export type HermesTeamConflict = { id: string; name: string; memberDeleted?: boolean; teamRemoved?: boolean; memberFiles: HermesTeamFilePreview[]; teamFiles: HermesTeamFilePreview[] };
export type HermesTeamConflictInput = { conflictId: string; choice: "keep_mine" | "use_team"; requestId: string };

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
export function HermesTeamControls({ view, busy = false, onOpenMode, onPrepareCapture, onCapture, onPublish, onLoadConflicts, onResolveConflict }: {
  view: HermesTeamView;
  busy?: boolean;
  onOpenMode?: (mode: HermesTeamMode) => Promise<void>;
  onPrepareCapture?: () => Promise<HermesTeamCaptureInventory>;
  onCapture?: (selection: HermesTeamCaptureSelection) => Promise<HermesTeamReview>;
  onPublish?: (input: HermesTeamPublishInput) => Promise<{ revision: number }>;
  onLoadConflicts?: () => Promise<HermesTeamConflict[]>;
  onResolveConflict?: (input: HermesTeamConflictInput) => Promise<void>;
}) {
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
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflicts, setConflicts] = useState<HermesTeamConflict[]>([]);
  const [resolved, setResolved] = useState<string[]>([]);
  const conflictAttempts = useRef(new Map<string, string>());

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
  function acceptReview(next: HermesTeamReview) {
    setReview(next); setSelected([]); setReleaseNote(""); setAttempted(false); setStaleReview(false); publishAttempt.current = null;
    setReviewOpen(true);
  }
  async function prepareCapture() {
    if (!onPrepareCapture || !onCapture || !view.canMaintain || view.mode !== "admin") return;
    await perform("capture", async () => {
      const next = await onPrepareCapture();
      setInventory(next); setDocuments([]); setReview(null); setStaleReview(false); setReviewOpen(true);
      if (next.available && !next.selection.documents.length) acceptReview(await onCapture({ ...next.selection, documents: [] }));
    });
  }
  async function capture() {
    if (!inventory?.available || !onCapture || !view.canMaintain || view.mode !== "admin") return;
    await perform("capture", async () => {
      acceptReview(await onCapture({ ...inventory.selection, documents }));
    });
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
  async function loadConflicts() {
    if (!onLoadConflicts || view.mode !== "member") return;
    await perform("conflicts", async () => { setConflicts(await onLoadConflicts()); setResolved([]); setConflictsOpen(true); });
  }
  async function resolve(conflict: HermesTeamConflict, choice: HermesTeamConflictInput["choice"]) {
    if (!onResolveConflict || view.mode !== "member") return;
    await perform(`resolve:${conflict.id}`, async () => {
      const key = `${conflict.id}:${choice}`;
      if (!conflictAttempts.current.has(key)) conflictAttempts.current.set(key, crypto.randomUUID());
      await onResolveConflict({ conflictId: conflict.id, choice, requestId: conflictAttempts.current.get(key)! });
      setResolved((ids) => [...ids, conflict.id]);
      setNotice(choice === "keep_mine" ? `Kept your version of ${conflict.name}.` : `Selected the team version of ${conflict.name}. It will be applied when your bot is idle.`);
    });
  }
  if (!view.enabled) return null;
  const locked = !!operation || busy || view.state === "revoked";
  const canCapture = view.state !== "preparing" && view.state !== "updating" && view.state !== "revoked";
  const admin = view.mode === "admin";
  const visibleConflicts = conflicts.filter((conflict) => !resolved.includes(conflict.id));
  return <section className="mx-auto w-full max-w-3xl space-y-2 px-4 py-2" aria-label="Hermes Team Bot controls">
    <div className="space-y-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-surface-2 px-2 py-1 font-medium">{admin ? "Admin mode" : "Private chat"}</span>
          <span className="flex items-center gap-1.5 text-muted" role="status">{(view.state === "preparing" || view.state === "updating") && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}{stateLabels[view.state]}</span>
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
          {!admin && view.conflictCount > 0 && <Button size="sm" variant="outline" disabled={locked || !onLoadConflicts || !onResolveConflict} onClick={() => void loadConflicts()}>Review {view.conflictCount} {view.conflictCount === 1 ? "update" : "updates"}</Button>}
        </div>
      </div>
      {view.canMaintain && <p id={`${id}-mode-description`} className="text-xs text-muted">Admin mode opens a separate conversation. Maintainers share this working bot’s skills and native memory. Your private chat and other maintainers’ conversations stay separate.</p>}
      {!admin && <p className="text-xs text-muted">Your chat history, memory and new skills stay private. Team updates preserve your own changes.</p>}
      {view.state === "connection_needed" && <p className="text-sm">Connect or reconnect the required model account in <a href="/settings?tab=connected-accounts" className="underline">Settings</a> to continue.</p>}
      {view.state === "needs_attention" && <p className="text-xs text-muted">This bot is paused. Ask an admin to check its configuration, or try again after the issue is resolved.</p>}
      {view.state === "revoked" && <p className="text-xs text-muted">Your access to this Team Bot was removed. Ask an admin if you need access again.</p>}
      {view.canMaintain && !onOpenMode && <p className="text-xs text-muted">Open this bot in a compatible web version to switch Admin mode.</p>}
      {admin && (!onPrepareCapture || !onCapture || !onPublish) && <p className="text-xs text-muted">Publishing is not available in this version. Ask an admin to check resource review support.</p>}
      {!admin && view.conflictCount > 0 && (!onLoadConflicts || !onResolveConflict) && <p className="text-xs text-muted">Your changes are preserved. Open a compatible web version to review these updates.</p>}
    </div>
    {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
    {error && !reviewOpen && !conflictsOpen && <p role="alert" className="text-sm text-danger">{error}</p>}

    <Dialog open={reviewOpen && admin && view.canMaintain} onOpenChange={(open) => { if (!operationRef.current) { setReviewOpen(open); setError(""); } }}>
      <DialogContent title="Publish changes" description="Choose exactly what the team will receive from this snapshot." className="max-w-2xl" hideClose={operation === "publish"}>
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
          </fieldset> : <p className="text-sm">No publishable changes yet. Teach the bot in Admin mode, then review again.</p>}
          <Field label="Release note" hint="A short explanation for the people using this bot.">
            <Textarea aria-label="Team release note" rows={2} maxLength={500} value={releaseNote} disabled={locked || attempted} onChange={(event) => setReleaseNote(event.target.value)} placeholder="What changed and why?" />
          </Field>
          {attempted && error && <p className="text-xs text-muted">{staleReview ? "This snapshot can no longer be published. Review the latest changes before publishing." : "Retry sends the same snapshot, selection and release note. Close this review to capture a fresh draft."}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={locked} onClick={() => { setReviewOpen(false); setError(""); }}>Cancel</Button>
            {staleReview ? <Button disabled={locked} onClick={() => void prepareCapture()}>Review again</Button> : <Button disabled={locked || !selected.length || !releaseNote.trim()} onClick={() => void publish()}>{operation === "publish" && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}{attempted && error ? "Retry publish" : `Publish ${selected.length} ${selected.length === 1 ? "item" : "items"}`}</Button>}
          </div>
        </div>}
      </DialogContent>
    </Dialog>
    <Dialog open={conflictsOpen && !admin} onOpenChange={(open) => { if (!operationRef.current) { setConflictsOpen(open); setError(""); } }}>
      <DialogContent title="Review team updates" description="Your changes have been preserved. Choose which version to keep for each item." className="max-w-2xl" hideClose={!!operation}>
        <div className="space-y-4">
          {visibleConflicts.map((conflict) => <section key={conflict.id} aria-label={`Update ${conflict.name}`} className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="text-sm font-medium wrap-anywhere">{conflict.name}</h3>
            {conflict.memberDeleted && <p className="text-xs text-muted">You deleted this item. Keep my version preserves that choice.</p>}
            {conflict.teamRemoved && <p className="text-xs text-muted">The team removed this item. Use team version accepts the removal.</p>}
            <details className="text-xs"><summary className="cursor-pointer text-sm">Preview your version</summary><div className="mt-2 space-y-2">{conflict.memberDeleted ? <p>Deleted by you</p> : conflict.memberFiles.map((file) => <FilePreview key={file.path} file={file} />)}</div></details>
            <details className="text-xs"><summary className="cursor-pointer text-sm">Preview team version</summary><div className="mt-2 space-y-2">{conflict.teamRemoved ? <p>Removed from the team</p> : conflict.teamFiles.map((file) => <FilePreview key={file.path} file={file} />)}</div></details>
            <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked} onClick={() => void resolve(conflict, "keep_mine")}>Keep my version</Button><Button size="sm" disabled={locked} onClick={() => void resolve(conflict, "use_team")}>Use team version</Button></div>
          </section>)}
          {!visibleConflicts.length && <p className="text-sm">All updates have been reviewed.</p>}
          {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end"><Button variant="outline" disabled={locked} onClick={() => { setConflictsOpen(false); setError(""); }}>Done</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}

function FilePreview({ file }: { file: HermesTeamFilePreview }) {
  return <details className="min-w-0 rounded-lg bg-surface-2/50 p-2 text-xs">
    <summary className="cursor-pointer break-all font-mono">{file.path}</summary>
    <div className="mt-2 min-w-0 space-y-2">
      {file.binary ? <p>Binary asset included in the complete skill package.</p> : file.diff !== undefined ? <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono">{file.diff}</pre> : <>
        {file.before != null && <div><p className="mb-1 text-muted">Previous content</p><pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono">{file.before}</pre></div>}
        {file.after != null && <div><p className="mb-1 text-muted">Reviewed content</p><pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono">{file.after}</pre></div>}
        {file.before == null && file.after == null && <p>This file is removed in the selected team version.</p>}
      </>}
    </div>
  </details>;
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
