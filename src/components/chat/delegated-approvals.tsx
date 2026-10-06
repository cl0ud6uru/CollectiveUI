"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { TaskApprovalRequest } from "@/lib/delegation/approvals";
import { WorkspaceApproval } from "./workspace-parts";

export function DelegatedApprovals({ conversationId }: { conversationId: string }) {
  const [requests, setRequests] = useState<TaskApprovalRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const refresh = useCallback(async () => {
    setNow(Date.now());
    const response = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/approvals`, { cache: "no-store" });
    if (!response.ok) { setRequests([]); return; }
    setRequests((await response.json()).requests);
  }, [conversationId]);
  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive && !document.hidden) void refresh().catch(() => setRequests([])); };
    tick(); const timer = setInterval(tick, 2000);
    window.addEventListener("focus", tick);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [refresh]);
  const answer = async (request: TaskApprovalRequest, approved: boolean) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/approvals`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: request.runId, approvalId: request.part.approval!.id, approved }) });
      if (!response.ok) throw new Error((await response.json()).error || "The approval could not be saved.");
      window.dispatchEvent(new Event("bot-work-changed"));
    } catch (err) { setError(err instanceof Error ? err.message : "The approval could not be saved."); }
    finally { await refresh().catch(() => setRequests([])); setBusy(false); }
  };
  return <div aria-label="Delegated workspace approvals" className="space-y-3">
    {requests.map(request => <section key={`${request.runId}:${request.part.approval!.id}`}>
      <p className="text-sm text-muted">Assigned by {request.assignerName} · <Link href={`/c/${encodeURIComponent(request.conversationId)}`} className="underline">Open {request.botName}’s task</Link></p>
      <WorkspaceApproval name={request.part.type.slice(5)} part={request.part} botName={request.botName} disabled={busy || Date.parse(request.expiresAt) <= now}
        onApprove={() => void answer(request, true)} onDeny={() => void answer(request, false)} />
      <p className="text-xs text-muted">Only you can approve this action. The task expires at {new Date(request.expiresAt).toLocaleTimeString()}.</p>
    </section>)}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
