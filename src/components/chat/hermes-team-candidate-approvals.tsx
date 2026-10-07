"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type PendingApproval = { id: string; action: string; resourceIds: string[]; input: unknown; expiresAt: string };

/** Current person's private approval cards. Disabled native admission never activates this polling. */
export function HermesTeamCandidateApprovals({ conversationId, active }: { conversationId: string; active: boolean }) {
  return active ? <ActiveCandidateApprovals key={conversationId} conversationId={conversationId} /> : null;
}

function ActiveCandidateApprovals({ conversationId }: { conversationId: string }) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState<string | null>(null);
  const held = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/team/approvals`, { cache: "no-store", signal: abort.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? "The approval could not be checked.");
        if (!abort.signal.aborted) { setApprovals(value.approvals); setError(""); }
      } catch (err) {
        if (!abort.signal.aborted) { setApprovals([]); setError(err instanceof Error ? err.message : "Approval access changed."); }
      } finally { if (!abort.signal.aborted) timer = setTimeout(() => void load(), 1000); }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [conversationId]);
  async function answer(id: string, decision: "approved" | "rejected") {
    if (held.current) return;
    held.current = true; setAnswering(id); setError("");
    try {
      const response = await fetch(`/api/hermes-team/approvals/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "This approval expired or changed. The action has not been confirmed.");
      setApprovals(rows => rows.filter(row => row.id !== id));
    } catch (err) { setError(err instanceof Error ? err.message : "The approval was not confirmed."); }
    finally { held.current = false; setAnswering(null); }
  }
  return <section aria-label="Team action approvals" className="mx-auto min-w-0 w-full max-w-3xl px-4">
    {approvals.map(row => <div key={row.id} className="my-2 min-w-0 wrap-anywhere rounded-xl border border-border p-3 text-sm">
      <p className="font-medium">Allow {row.action}?</p>
      <p className="text-muted">Resources: {row.resourceIds.join(", ")}</p>
      <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(row.input, null, 2)}</pre>
      <p className="mb-2 text-xs text-muted">Approve this action once. Unanswered requests expire. Approval does not confirm completion.</p>
      <div className="flex gap-2"><Button disabled={answering !== null} onClick={() => void answer(row.id, "approved")}>Allow once</Button>
        <Button variant="outline" disabled={answering !== null} onClick={() => void answer(row.id, "rejected")}>Deny</Button></div>
    </div>)}
    {error && <p role="alert" className="pb-2 text-sm text-danger">{error}</p>}
  </section>;
}
