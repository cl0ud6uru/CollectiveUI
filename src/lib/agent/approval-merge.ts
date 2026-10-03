type AnyPart = { type: string; toolCallId?: string; state?: string; approval?: Record<string, unknown> & { id?: string } };

export type ApprovalDecision = { approved: boolean; reason?: string };

function isToolPart(p: AnyPart) {
  return p.type === "dynamic-tool" || p.type.startsWith("tool-");
}

/**
 * Apply approval decisions to the server-stored assistant message. Only `approved` and `reason` are
 * taken from the client — tool names, inputs and approval signatures always come from the database,
 * so a client cannot smuggle in a different tool call.
 */
export function applyApprovalDecisions<P extends AnyPart>(
  storedParts: P[],
  decisions: Map<string, ApprovalDecision>, // keyed by approval id
): { parts: P[]; changed: number } {
  let changed = 0;
  const parts = storedParts.map((p) => {
    if (!isToolPart(p) || p.state !== "approval-requested" || !p.approval?.id) return p;
    const d = decisions.get(p.approval.id);
    if (!d) return p;
    changed++;
    return {
      ...p,
      state: "approval-responded",
      approval: { ...p.approval, approved: d.approved, reason: d.reason?.slice(0, 500) },
    } as P;
  });
  return { parts, changed };
}

/** Extract decisions from a client-sent assistant message (useChat addToolApprovalResponse). */
export function decisionsFromClientParts(clientParts: AnyPart[]): Map<string, ApprovalDecision> {
  const out = new Map<string, ApprovalDecision>();
  for (const p of clientParts) {
    if (!isToolPart(p) || p.state !== "approval-responded" || !p.approval?.id) continue;
    out.set(String(p.approval.id), {
      approved: p.approval.approved === true,
      reason: typeof p.approval.reason === "string" ? p.approval.reason : undefined,
    });
  }
  return out;
}
