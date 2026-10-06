"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export type HermesTeamRevision = { revision: number; releaseNote: string; publishedAt: string; manifestHash: string };

/** Choices come from the authorized shared release inventory, never from member profiles. */
export function HermesTeamRestorePicker({ revisions, publishedRevision, disabled, onReview }: {
  revisions: HermesTeamRevision[]; publishedRevision: number; disabled: boolean; onReview: (targetRevision: number) => void;
}) {
  const [selected, setSelected] = useState("");
  const earlier = revisions.filter(revision => revision.revision < publishedRevision);
  const chosen = earlier.find(revision => String(revision.revision) === selected);
  if (!earlier.length) return null;
  return <details className="my-4 min-w-0 rounded-lg border border-border p-3 text-xs">
    <summary className="cursor-pointer text-sm font-medium">Restore a published team version</summary>
    <div className="mt-3 min-w-0 space-y-3">
      <p className="text-xs text-muted">Review shared resources from an earlier version. Publishing the selected changes creates a new team version. Members keep their own learning.</p>
      <label className="block space-y-1 text-sm"><span>Published team version</span><select aria-label="Published team version to restore" value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)} className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm"><option value="">Choose a version</option>{earlier.map(revision => <option key={revision.revision} value={revision.revision}>Version {revision.revision}{revision.releaseNote ? ` · ${revision.releaseNote}` : ""}</option>)}</select></label>
      {chosen && <div className="space-y-1 text-xs text-muted"><p className="wrap-anywhere">{chosen.releaseNote || "No release note"}</p><p>Published {new Date(chosen.publishedAt).toLocaleString()}</p></div>}
      <Button size="sm" variant="outline" disabled={disabled || !chosen} onClick={() => chosen && onReview(chosen.revision)}>Review selected version</Button>
    </div>
  </details>;
}
