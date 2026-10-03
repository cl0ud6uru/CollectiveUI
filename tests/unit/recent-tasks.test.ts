import { describe, expect, it } from "vitest";
import { mergeRecentTasks, taskIndicator } from "@/lib/chat/recent-task-state";
import type { ConversationSummary } from "@/components/chat/types";

describe("recent task presentation", () => {
  it("distinguishes every durable state without treating a failure or stop as success", () => {
    expect(taskIndicator({ status: "queued", unread: false })).toEqual({ kind: "queued", label: "Task queued" });
    for (const status of ["running", "waiting_tasks"] as const) expect(taskIndicator({ status, unread: false })?.kind).toBe("working");
    expect(taskIndicator({ status: "waiting", unread: false })?.kind).toBe("waiting");
    expect(taskIndicator({ status: "succeeded", unread: true })?.kind).toBe("unread");
    expect(taskIndicator({ status: "succeeded", unread: false })).toBeNull();
    for (const status of ["failed", "interrupted", "cancelled"] as const) {
      expect(taskIndicator({ status, unread: true })?.label).toContain("Unread");
      expect(taskIndicator({ status, unread: false })?.label).not.toContain("Unread");
      expect(["working", "unread"]).not.toContain(taskIndicator({ status, unread: true })?.kind);
    }
  });
  it("reconciles concurrent task snapshots without duplicates, stale deleted entries or changing ordinary chat patches", () => {
    const c = (id: string, source: ConversationSummary["source"], updatedAt = "2026-10-01T00:00:00Z"): ConversationSummary =>
      ({ id, source, title: id, updatedAt, pinned: false, folderId: null, botId: null, appId: null });
    const regular = { ...c("regular", "chat"), title: "Live renamed title" };
    const tasks = [c("second", "delegation", "2026-10-03T00:00:00Z"), c("first", "delegation", "2026-10-02T00:00:00Z")];
    const merged = mergeRecentTasks([regular, c("first", "delegation"), c("deleted", "delegation")], tasks);
    expect(merged.map(c => c.id)).toEqual(["second", "first", "regular"]);
    expect(merged[2]).toBe(regular);
    expect(mergeRecentTasks(merged, tasks)).toEqual(merged);
  });
});
