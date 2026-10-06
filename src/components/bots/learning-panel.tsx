"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { getLearningHistory, updateLearning } from "@/app/(chat)/bots/learning-actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import type { LearningView, LessonContent } from "@/lib/agent/learning/types";

export function LearningCard({ row }: { row: LearningView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState<LessonContent>(row.content);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getLearningHistory>> | null>(null);
  const mutate = (change: Parameters<typeof updateLearning>[0]) => start(async () => {
    try {
      await updateLearning(change);
      setEditing(false);
      setHistory(null);
      toast.success("Learning updated");
      router.refresh();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Update failed"); }
  });
  return <details className="rounded-xl border border-border p-4">
    <summary className="cursor-pointer text-sm font-medium">
      {row.content.name}
      <span className="ml-2 inline-flex flex-wrap gap-1 font-normal">
        {["Learned", row.scope === "user" ? "Personal" : "Shared", row.status === "pending" ? "Needs approval" : row.status === "archived" ? "Archived" : row.stale ? "Stale" : "Active", ...(row.pinned ? ["Pinned"] : [])].map(tag => <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{tag}</span>)}
        <span className="text-muted">v{row.version}</span>
      </span>
    </summary>
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted">{row.content.description}</p>
      {editing ? <div className="space-y-3">
        <Field label="Name"><Input value={content.name} onChange={e => setContent({ ...content, name: e.target.value })} /></Field>
        <Field label="When to use"><Input value={content.description} onChange={e => setContent({ ...content, description: e.target.value })} /></Field>
        <Field label="Procedure"><Textarea rows={7} value={content.instructions} onChange={e => setContent({ ...content, instructions: e.target.value })} /></Field>
        <Field label="Expected output"><Textarea value={content.expectedOutput} onChange={e => setContent({ ...content, expectedOutput: e.target.value })} /></Field>
        <Field label="Boundaries"><Textarea value={content.boundaries} onChange={e => setContent({ ...content, boundaries: e.target.value })} /></Field>
        <Button disabled={pending} size="sm" onClick={() => mutate({ id: row.id, version: row.version, content })}>Save changes</Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      </div> : <>
        <p className="whitespace-pre-wrap">{row.content.instructions}</p>
        {row.content.expectedOutput && <p><strong>Expected output: </strong>{row.content.expectedOutput}</p>}
        {row.content.boundaries && <p><strong>Boundaries: </strong>{row.content.boundaries}</p>}
      </>}
      <p className="text-xs text-muted">{row.kind === "preference" ? "Personal preference, included in this bot’s memory." : `Loaded ${row.useCount} ${row.useCount === 1 ? "time" : "times"}${row.lastUsedAt ? ` · last loaded ${new Date(row.lastUsedAt).toLocaleDateString()}` : ""}.`}</p>
      <p className="text-muted"><strong>Evidence: </strong>{row.verification}</p>
      {row.canManage && <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={() => mutate({ id: row.id, version: row.version, pinned: !row.pinned })}>{row.pinned ? "Unpin" : "Pin"}</Button>
        {row.status === "pending" && <Button size="sm" disabled={pending} onClick={() => mutate({ id: row.id, version: row.version, status: "active" })}>Approve</Button>}
        <Button variant="outline" size="sm" disabled={pending} onClick={() => { setContent(row.content); setEditing(true); }}>Edit</Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => mutate({ id: row.id, version: row.version, status: row.status === "archived" ? "active" : "archived" })}>{row.status === "archived" ? "Restore" : row.status === "pending" ? "Reject" : "Archive"}</Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(async () => {
          try { setHistory(await getLearningHistory(row.id)); }
          catch (err) { toast.error(err instanceof Error ? err.message : "Could not load history"); }
        })}>Revision history</Button>
      </div>}
      {history && <div className="space-y-2">{history.map(revision => <details key={revision.version} className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer">Version {revision.version} · {new Date(revision.createdAt).toLocaleString()}</summary>
        <p className="mt-2 whitespace-pre-wrap">{revision.content.instructions}</p>
        {revision.version !== row.version && <Button size="sm" variant="outline" disabled={pending} onClick={() => mutate({ id: row.id, version: row.version, restoreVersion: revision.version })}>Restore this content</Button>}
      </details>)}</div>}
    </div>
  </details>;
}

export function LearnedItems({ rows }: { rows: LearningView[] }) {
  return <div className="space-y-2">{rows.map(row => <LearningCard key={`${row.id}:${row.version}`} row={row} />)}</div>;
}
