"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { getToolOrDynamicToolName, isToolUIPart, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { AlertCircle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { isDelegationTool } from "@/lib/delegation/policy";
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

/** A tool step the person must act on (approve/deny) stays out of the collapsed step chip. */
export function needsAction(part: unknown): boolean {
  return isToolUIPart(part as AnyToolPart) && (part as AnyToolPart).state === "approval-requested" && !(part as { approval?: { isAutomatic?: boolean } }).approval?.isAutomatic;
}

/**
 * Steps that never fold into the chip: ones waiting for the person, and delegated tasks, whose card carries another
 * bot's live status, answer and errors.
 */
export function standsAlone(part: unknown): boolean {
  return needsAction(part) || (isToolUIPart(part as AnyToolPart) && isDelegationTool(getToolOrDynamicToolName(part as AnyToolPart)));
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

/** What a tool call does, for its glyph and the collapsed chip. Matches ToolKind in the native apps. */
export function toolKind(name: string): "terminal" | "web" | "tools" {
  const tool = name.startsWith("hermes__") ? name.slice("hermes__".length) : name;
  if (["workspace_bash", "terminal", "process_manage", "execute_code"].includes(tool)) return "terminal";
  if (["web_search", "openai_web_search", "fetch_url", "web_extract"].includes(tool)) return "web";
  return "tools";
}

/** The one line a running step shows: its command, query or target, whitespace collapsed. */
export function commandLine(input: unknown): string | null {
  const line = (v: unknown) => (typeof v === "string" ? v.slice(0, 400).split(/\s+/).filter(Boolean).join(" ") || null : null);
  if (!input || typeof input !== "object") return line(input);
  const o = input as Record<string, unknown>;
  // `preview` is what a Hermes server reports for its own tools (see hermes/mapper.ts).
  for (const key of ["command", "preview", "code", "query", "url", "pattern", "path", "goal"]) {
    const l = line(o[key]);
    if (l) return l;
  }
  for (const key of Object.keys(o).sort()) {
    const l = line(o[key]);
    if (l) return l;
  }
  return null;
}

/** "12s", then "1m 5s", like the native apps. */
function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** When each running step was first seen, so its timer survives the ticker remounting (scrolling, regrouping). */
const stepStarts = new Map<string, number>();

/** Whole seconds a running step has been running. */
function useStepClock(toolCallId: string) {
  const [start] = useState(() => {
    if (!stepStarts.has(toolCallId)) stepStarts.set(toolCallId, Date.now());
    return stepStarts.get(toolCallId)!;
  });
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** `$ command`, a blinking caret and the elapsed time, on one line. */
export function RunningTicker({ toolCallId, command }: { toolCallId: string; command: string | null }) {
  const seconds = useStepClock(toolCallId);
  return (
    <span className="flex min-w-0 items-baseline gap-2 font-mono text-xs text-muted">
      <span className="flex min-w-0 grow items-baseline">
        <span className="sr-only">Running </span>
        <span className="truncate">$ {command ?? ""}</span>
        <span aria-hidden="true" className="tool-caret text-hermes">▌</span>
      </span>
      <span aria-hidden="true" className="shrink-0 tabular-nums">{formatElapsed(seconds)}</span>
    </span>
  );
}

type StepState = "done" | "active" | "failed" | "denied";

function stepState(p: AnyToolPart): StepState {
  if (p.state === "output-error") return "failed";
  if (p.state === "output-denied" || (p.state === "approval-responded" && p.approval?.approved === false)) return "denied";
  return stepRunning(p) ? "active" : "done";
}

const RailContext = createContext<{ state: StepState; first: boolean; last: boolean } | null>(null);

/**
 * A step's dot on the rail, placed in the step's own header row so it centers on that row whatever the step looks like.
 * It is positioned against the rail item, and draws the connector up and down from itself (the item clips the overflow).
 * Renders nothing outside a rail.
 */
export function RailDot() {
  const rail = useContext(RailContext);
  if (!rail) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute left-0 h-2.5 w-2.5 rounded-full",
        { done: "bg-muted", active: "bg-hermes motion-safe:animate-pulse", failed: "bg-danger", denied: "bg-subtle" }[rail.state],
        !rail.first && "before:absolute before:bottom-full before:left-[4.5px] before:h-[100vh] before:w-px before:bg-border",
        !rail.last && "after:absolute after:top-full after:left-[4.5px] after:h-[100vh] after:w-px after:bg-border",
      )}
    />
  );
}

/**
 * A reply's tool steps: a rail while the reply works on them, then one chip like "terminal · web · 3 steps · 14s".
 * Failed steps stay visible beside the folded chip, with their error, never hidden inside it.
 */
export function StepsGroup({
  parts,
  live,
  startedAt,
  finishedAt,
  timed,
  renderStep,
}: {
  parts: AnyToolPart[];
  /** The reply is still streaming this run of steps. */
  live: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** Only the reply's single group can honestly say how long the whole turn worked. */
  timed: boolean;
  renderStep: (part: AnyToolPart) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const failed = parts.filter((p) => stepState(p) === "failed");
  const kinds = [...new Set(parts.map((p) => toolKind(getToolOrDynamicToolName(p))))];
  const label = [
    ...kinds,
    `${parts.length} ${parts.length === 1 ? "step" : "steps"}`,
    ...(failed.length ? [`${failed.length} failed`] : []),
    ...(timed && startedAt && finishedAt && finishedAt >= startedAt ? [formatDuration(finishedAt - startedAt)] : []),
  ].join(" · ");

  const rail = (
    <ol className="my-1">
      {parts.map((p, i) => (
        <li key={p.toolCallId} className="relative overflow-y-clip py-0.5 pl-5">
          <RailContext.Provider value={{ state: stepState(p), first: i === 0, last: i === parts.length - 1 }}>{renderStep(p)}</RailContext.Provider>
        </li>
      ))}
    </ol>
  );
  // Steps of a reply that is no longer streaming are finished or interrupted, never still running.
  if (live) return rail;
  return (
    <div className="my-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex max-w-full items-center gap-1.5 rounded-[14px] border bg-surface-2 px-2.5 py-1 text-left text-[13px] hover:text-fg",
          failed.length ? "border-danger/60 text-danger" : "border-border text-muted",
        )}
      >
        {failed.length ? <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
        <span>{label}</span>
        {open ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
      </button>
      {open ? rail : failed.map((p) => <div key={p.toolCallId}>{renderStep(p)}</div>)}
    </div>
  );
}
