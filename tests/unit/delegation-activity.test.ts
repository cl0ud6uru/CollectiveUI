import { describe, expect, it } from "vitest";
import { summarizeActivity, type ActivityEvent } from "@/lib/delegation/activity-summary";
const input = (id: string, toolName = "workspace_bash"): ActivityEvent => ({ type: "tool-input-available", toolCallId: id, toolName });
const output = (id: string, preliminary = false): ActivityEvent => ({ type: "tool-output-available", toolCallId: id, preliminary });
describe("delegated tool activity", () => {
  it("tracks parallel calls separately and does not finish a preliminary result", () => {
    expect(summarizeActivity("task", "running", [input("a"), input("b", "workspace_read"), output("a", true), output("b")])).toMatchObject({
      status: "working", completed: 1, steps: [{ tool: "workspace_read", status: "done" }, { tool: "workspace_bash", status: "running" }],
    });
  });
  it("distinguishes input preparation, manual approvals, automatic approvals and denial", () => {
    expect(summarizeActivity("task", "running", [{ type: "tool-input-start", toolCallId: "a", toolName: "workspace_bash" }]).steps[0].status).toBe("preparing");
    const events = [input("a"), { type: "tool-approval-request", toolCallId: "a", approvalId: "approval" }];
    expect(summarizeActivity("task", "waiting", events)).toMatchObject({ phase: "approval", steps: [{ status: "waiting" }] });
    expect(summarizeActivity("task", "running", [...events, { type: "tool-approval-response", approvalId: "approval", approved: true }]).steps[0].status).toBe("running");
    expect(summarizeActivity("task", "waiting", [...events, { type: "tool-approval-response", approvalId: "approval", approved: false }]).steps[0].status).toBe("denied");
    expect(summarizeActivity("task", "running", [input("a"), { type: "tool-approval-request", toolCallId: "a", isAutomatic: true }]).steps[0].status).toBe("running");
  });
  it("does not claim queued continuations or paused delegates are executing tools", () => {
    for (const status of ["queued", "waiting_tasks"] as const) {
      expect(summarizeActivity("task", status, [input("pending")]).steps[0].status).toBe("waiting");
    }
  });
  it("keeps active calls and total completed count through long tasks", () => {
    const events = [input("active"), ...Array.from({ length: 40 }, (_, i) => [input(String(i)), output(String(i))]).flat()];
    const summary = summarizeActivity("task", "running", events);
    expect(summary.steps).toHaveLength(30);
    expect(summary.completed).toBe(40);
    expect(summary.steps.at(-1)).toEqual({ tool: "workspace_bash", status: "running" });
  });
  it("removes reset steps, handles nested failures, and stops spinners on terminal tasks", () => {
    const events = [input("old"), output("old"), { type: "start-step" }, input("reset"), { type: "reset-step" }, input("bad"), { ...output("bad"), failed: true }, input("pending")];
    const summary = summarizeActivity("task", "cancelled", events);
    expect(summary).toMatchObject({ status: "cancelled", completed: 1, steps: [{ status: "done" }, { status: "error" }, { status: "error" }] });
    expect(summarizeActivity("task", "waiting_tasks", []).phase).toBe("delegates");
  });
});
