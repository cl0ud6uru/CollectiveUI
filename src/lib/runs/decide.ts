import type { AbortKind, AgentRunStatus } from "./types";

/** Stored error text is shown as is: keep it to a readable length. */
const MAX_ERROR = 500;

/**
 * How a segment ends, in order: lease lost → null (write nothing); cancel → cancelled; shutdown → interrupted;
 * timeout → failed; error → failed; pending approval → waiting; else succeeded.
 */
export function decideFinal(i: { abort?: AbortKind; error?: string; pendingApproval: boolean; pendingTasks?: boolean }): AgentRunStatus | null {
  switch (i.abort) {
    case "lease-lost":
      return null;
    case "cancel":
      return "cancelled";
    case "shutdown":
      return "interrupted";
    case "timeout":
      return "failed";
  }
  if (i.error) return "failed";
  if (i.pendingTasks) return "waiting_tasks";
  return i.pendingApproval ? "waiting" : "succeeded";
}

/** The user-facing error text stored for a failed/interrupted segment (redacted, short). */
export function finalErrorText(i: { abort?: AbortKind; error?: string; timeoutMs: number }): string | null {
  switch (i.abort) {
    case "lease-lost":
    case "cancel":
      return null;
    case "shutdown":
      return "The worker restarted while this reply was running. Try again.";
    case "timeout":
      return `The reply took longer than ${Math.max(1, Math.round(i.timeoutMs / 60_000))} min and was stopped.`;
  }
  if (!i.error) return null;
  // Already user-facing (userFacingMessage / redactSecrets upstream).
  return i.error.length > MAX_ERROR ? `${i.error.slice(0, MAX_ERROR - 1)}…` : i.error;
}
