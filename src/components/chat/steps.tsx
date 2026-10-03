"use client";

import { useEffect, useState } from "react";
import { isToolUIPart, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

/** "35s", "2m 5s", "1h 3m". */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A tool step the person must act on (approve/deny) stays out of the collapsed "Worked for" row. */
export function needsAction(part: unknown): boolean {
  return isToolUIPart(part as AnyToolPart) && (part as AnyToolPart).state === "approval-requested" && !(part as { approval?: { isAutomatic?: boolean } }).approval?.isAutomatic;
}

function stepRunning(p: AnyToolPart) {
  return p.state === "input-streaming" || p.state === "input-available" || p.state === "approval-responded" || (p.state === "output-available" && !!(p as { preliminary?: boolean }).preliminary);
}

/** Milliseconds since `since`, ticking while `live`. */
export function useElapsed(since: number | undefined, live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, since]);
  return since ? now - since : null;
}

/**
 * Several tool steps in a row, like ChatGPT's "Worked for 35s ›": expanded while the reply is still working on them,
 * one quiet line once it's done. Failures stay visible as a small count, not a red banner.
 */
export function StepsGroup({
  parts,
  live,
  startedAt,
  finishedAt,
  timed,
  children,
}: {
  parts: AnyToolPart[];
  /** The reply is streaming and this is its latest group of steps. */
  live: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** Only the reply's single group can honestly say how long the whole turn worked. */
  timed: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const running = live && parts.some(stepRunning);
  const elapsed = useElapsed(startedAt, running);
  const failed = parts.filter((p) => p.state === "output-error").length;
  const expanded = running || open;
  const label = running
    ? `Working${elapsed ? ` for ${formatDuration(elapsed)}` : "…"}`
    : timed && startedAt && finishedAt
      ? `Worked for ${formatDuration(finishedAt - startedAt)}`
      : `${parts.length} steps`;
  return (
    <div className="my-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-muted hover:text-fg"
      >
        {running && <Loader2 className="h-4 w-4 motion-safe:animate-spin" />}
        <span className={cn(running && "motion-safe:animate-pulse")}>{label}</span>
        {!running && failed > 0 && (
          <span className="flex items-center gap-1 text-xs text-subtle">
            · <AlertTriangle className="h-3 w-3 text-danger" /> {failed} failed
          </span>
        )}
        {!running && (open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />)}
      </button>
      {expanded && <div className="mt-1 border-l border-border pl-3">{children}</div>}
    </div>
  );
}
