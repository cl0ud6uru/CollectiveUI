import type { AgentRunStatus } from "@/db/schema";

export type ActivityStep = { tool: string; status: "preparing" | "running" | "waiting" | "done" | "error" | "denied" };
export type TaskActivity = {
  taskId: string;
  status: "queued" | "working" | "done" | "error" | "cancelled" | "interrupted";
  phase?: "approval" | "delegates";
  steps: ActivityStep[];
  completed: number;
};

/** Only these fields are selected from the event log; arguments and results never enter the response. */
export type ActivityEvent = {
  type: string; toolCallId?: string | null; toolName?: string | null;
  approvalId?: string | null; approved?: boolean | null; isAutomatic?: boolean | null;
  preliminary?: boolean | null; failed?: boolean | null;
};

export function summarizeActivity(taskId: string, runStatus: AgentRunStatus, events: ActivityEvent[]): TaskActivity {
  const calls = new Map<string, ActivityStep>();
  const approvals = new Map<string, string>();
  let currentStep: string[] = [];
  for (const e of events) {
    if (e.type === "start-step") currentStep = [];
    if (e.type === "reset-step") { for (const id of currentStep) calls.delete(id); currentStep = []; }
    if (e.type === "tool-approval-response" && e.approvalId) {
      const step = calls.get(approvals.get(e.approvalId) ?? "");
      if (step) step.status = e.approved ? "running" : "denied";
    }
    if (!e.toolCallId) continue;
    if (e.toolName && !calls.has(e.toolCallId)) {
      calls.set(e.toolCallId, { tool: e.toolName, status: e.type === "tool-input-start" ? "preparing" : "running" });
      currentStep.push(e.toolCallId);
    }
    const step = calls.get(e.toolCallId);
    if (!step) continue;
    if (e.type === "tool-approval-request" && !e.isAutomatic) {
      step.status = "waiting";
      if (e.approvalId) approvals.set(e.approvalId, e.toolCallId);
    }
    if (e.type === "tool-input-available") step.status = "running";
    if (e.type === "tool-output-available") step.status = e.preliminary ? "running" : e.failed ? "error" : "done";
    if (e.type === "tool-input-error" || e.type === "tool-output-error") step.status = "error";
    if (e.type === "tool-output-denied") step.status = "denied";
  }
  const status: TaskActivity["status"] = runStatus === "succeeded" ? "done" : runStatus === "failed" ? "error"
    : runStatus === "cancelled" || runStatus === "interrupted" || runStatus === "queued" ? runStatus : "working";
  const all = [...calls.values()];
  if (["queued", "waiting", "waiting_tasks"].includes(runStatus)) {
    for (const step of all) if (step.status === "running" || step.status === "preparing") step.status = "waiting";
  }
  if (!["queued", "working"].includes(status)) {
    for (const step of all) if (step.status === "preparing" || step.status === "running" || step.status === "waiting") step.status = "error";
  }
  // Retain every active call even when a long task has many completed steps.
  const active = all.filter(s => s.status === "preparing" || s.status === "running" || s.status === "waiting");
  const recentCount = Math.max(0, 30 - active.length);
  const recent = recentCount ? all.filter(s => s.status !== "preparing" && s.status !== "running" && s.status !== "waiting").slice(-recentCount) : [];
  return { taskId, status, steps: [...recent, ...active], completed: all.filter(s => s.status === "done").length,
    ...(runStatus === "waiting" ? { phase: "approval" as const } : runStatus === "waiting_tasks" ? { phase: "delegates" as const } : {}) };
}
