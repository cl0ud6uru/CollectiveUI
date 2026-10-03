import { CircleAlert, CirclePause, CircleStop, Clock3, LoaderCircle } from "lucide-react";
import type { ConversationSummary } from "@/components/chat/types";
import { taskIndicator } from "@/lib/chat/recent-task-state";

export function TaskIndicator({ activity }: { activity: ConversationSummary["taskActivity"] }) {
  const indicator = activity && taskIndicator(activity);
  if (!indicator) return null;
  const Icon = { queued: Clock3, working: LoaderCircle, waiting: CirclePause, error: CircleAlert, stopped: CircleStop, unread: null }[indicator.kind];
  return <span role="img" aria-label={indicator.label} title={indicator.label} className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center" data-task-indicator={indicator.kind}>
    {Icon ? <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${indicator.kind === "working" ? "animate-spin motion-reduce:animate-none text-blue-500" : indicator.kind === "error" || indicator.kind === "waiting" ? "text-amber-500" : "text-muted"}`} />
      : <span aria-hidden="true" className="h-2 w-2 rounded-full bg-blue-500" />}
  </span>;
}
