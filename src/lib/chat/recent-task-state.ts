import type { ConversationSummary } from "@/components/chat/types";

/** A server task snapshot replaces only task entries, leaving regular chat live patches intact. */
export function mergeRecentTasks(current: ConversationSummary[], tasks: ConversationSummary[]) {
  return [...current.filter(c => c.source !== "delegation"), ...tasks]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

export function taskIndicator(activity: NonNullable<ConversationSummary["taskActivity"]>) {
  const { status, unread } = activity;
  switch (status) {
    case "queued": return { kind: "queued", label: "Task queued" } as const;
    case "running": return { kind: "working", label: "Task working" } as const;
    case "waiting_tasks": return { kind: "working", label: "Task waiting for delegated tasks" } as const;
    case "waiting": return { kind: "waiting", label: "Task waiting for approval" } as const;
    case "succeeded": return unread ? { kind: "unread", label: "Completed task · Unread" } as const : null;
    case "failed": return { kind: "error", label: `Task failed${unread ? " · Unread" : ""}` } as const;
    case "interrupted": return { kind: "error", label: `Task interrupted${unread ? " · Unread" : ""}` } as const;
    case "cancelled": return { kind: "stopped", label: `Task stopped${unread ? " · Unread" : ""}` } as const;
  }
}
