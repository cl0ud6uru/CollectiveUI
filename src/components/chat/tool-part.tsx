"use client";

import { isDelegationTool } from "@/lib/delegation/policy";
import { workspaceArtifact } from "@/lib/chat/workspace-artifacts";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { getToolOrDynamicToolName, type ToolUIPart, type DynamicToolUIPart } from "ai";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  FilePen,
  FileText,
  FolderTree,
  Globe,
  Loader2,
  Mail,
  Plug,
  Search,
  ShieldQuestion,
  Sparkles,
  Terminal,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { useOptionalPets, usePetEnvironment } from "@/components/pets/pet-context";
import { Button } from "@/components/ui/button";
import { isGrantable, isHermesTool } from "@/lib/agent/tool-names";
import { ENFORCED_APPROVAL_REASON } from "@/lib/bots/service-policy";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { useTaskActivity } from "./use-task-activity";
import { BashResult, WorkspaceApproval } from "./workspace-parts";
import { useWorkspaceFileOpener } from "./workspace-context";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type Label = { icon: React.ComponentType<{ className?: string }>; running: string; done: string; ask: string };

const LABELS: Record<string, Label> = {
  openai_web_search: { icon: Globe, running: "Searching the web with OpenAI", done: "Searched the web with OpenAI", ask: "search the web with OpenAI" },
  web_search: { icon: Globe, running: "Searching the web", done: "Searched the web", ask: "search the web" },
  fetch_url: { icon: Globe, running: "Reading page", done: "Read page", ask: "read a web page" },
  search_knowledge: { icon: BookOpen, running: "Searching knowledge", done: "Searched knowledge", ask: "search its knowledge files" },
  remember: { icon: Brain, running: "Saving to memory", done: "Memory updated", ask: "save a memory" },
  forget: { icon: Brain, running: "Forgetting", done: "Memory updated", ask: "delete a memory" },
  use_skill: { icon: Sparkles, running: "Loading skill", done: "Used skill", ask: "use a skill" },
  m365_search_mail: { icon: Mail, running: "Searching mail", done: "Searched mail", ask: "search your mail" },
  m365_calendar: { icon: Mail, running: "Checking calendar", done: "Checked calendar", ask: "read your calendar" },
  m365_search_files: { icon: Mail, running: "Searching files", done: "Searched files", ask: "search your files" },
  m365_send_mail: { icon: Mail, running: "Sending email", done: "Sent email", ask: "send an email as you" },
  workspace_bash: { icon: Terminal, running: "Running a command", done: "Ran a command", ask: "run a command in your workspace" },
  workspace_write: { icon: FilePen, running: "Writing a file", done: "Wrote a file", ask: "write a file in your workspace" },
  workspace_edit: { icon: FilePen, running: "Editing a file", done: "Edited a file", ask: "edit a file in your workspace" },
  workspace_read: { icon: FileText, running: "Reading a file", done: "Read a file", ask: "read a file in your workspace" },
  workspace_list: { icon: FolderTree, running: "Listing files", done: "Listed files", ask: "list files in your workspace" },
  workspace_grep: { icon: Search, running: "Searching files", done: "Searched files", ask: "search your workspace" },
};

/** Tools a Hermes server runs itself (see src/lib/llm/providers/hermes). */
const HERMES_ICONS: Record<string, Label["icon"]> = {
  terminal: Terminal,
  process_manage: Terminal,
  execute_code: Terminal,
  read_file: FileText,
  write_file: FilePen,
  patch: FilePen,
  search_files: Search,
  web_search: Globe,
  web_extract: Globe,
  delegate_task: Users,
  memory: Brain,
  skill_view: Sparkles,
  skills_list: Sparkles,
};

function describe(name: string): Label {
  if (LABELS[name]) return LABELS[name];
  if (isHermesTool(name)) {
    const tool = name.slice("hermes__".length);
    const what = tool.replace(/_/g, " ");
    return { icon: HERMES_ICONS[tool] ?? Wrench, running: `Hermes is using ${what}`, done: `Hermes used ${what}`, ask: `use ${what} on Hermes` };
  }
  if (isDelegationTool(name)) {
    const who = name.replace(/^(ask|continue)_/, "").replace(/_/g, " ");
    return { icon: Users, running: `Working with ${who}`, done: `Worked with ${who}`, ask: `hand work to ${who}` };
  }
  if (name.includes("__")) {
    const [server, tool] = name.split("__");
    return { icon: Plug, running: `Using ${tool} (${server})`, done: `Used ${tool} (${server})`, ask: `use ${tool} (${server})` };
  }
  return { icon: Wrench, running: `Using ${name}`, done: `Used ${name}`, ask: `use ${name}` };
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-xs text-muted">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

type DelegateOutput = {
  taskId?: string; conversationId?: string | null; bot?: string; botId?: string; avatar?: string | null; label?: string | null;
  status: string; steps?: { tool: string; status?: string }[]; answer?: string; error?: string; startedAt?: string; finishedAt?: string;
};

/** "replied in 4s", only from the receiver run's recorded times. */
function repliedIn(output: DelegateOutput): string | null {
  if (output.status !== "done" || !output.startedAt || !output.finishedAt) return null;
  const ms = Date.parse(output.finishedAt) - Date.parse(output.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.max(1, Math.round(ms / 1000));
  return `replied in ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
}

export function DelegationCard({ output }: { output: DelegateOutput }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const pets = useOptionalPets();
  const { visible } = usePetEnvironment();
  const { activity, unavailable } = useTaskActivity(output.taskId, output.status);
  const status = activity?.status ?? output.status;
  useEffect(() => { if (output.taskId) window.dispatchEvent(new Event("bot-work-changed")); }, [output.taskId, status]);
  const botName = typeof output.bot === "string" ? output.bot.trim() : "";
  const working = status === "working" && !unavailable;
  const still = output.botId ? pets?.pets[output.botId]?.motion === "still" : false;
  const steps = (unavailable ? [] : activity?.steps ?? output.steps ?? []).map(s => {
    if (["running", "preparing", "waiting"].includes(s.status ?? "") && !["queued", "working"].includes(status)) return { ...s, status: "error" };
    if (status === "queued" && ["running", "preparing"].includes(s.status ?? "")) return { ...s, status: "waiting" };
    return s;
  });
  const active = steps.filter(s => ["running", "preparing", "waiting"].includes(s.status ?? ""));
  const current = active.find(s => s.status === "running") ?? active[0];
  const completed = activity?.completed ?? steps.filter(s => s.status === "done").length;
  const statusLabel = repliedIn({ ...output, status }) ?? ({
    working: "Working", queued: "Queued", done: "Completed", error: "Failed", cancelled: "Stopped", interrupted: "Interrupted",
  } as Record<string, string>)[status] ?? status;
  const detailLabel = (s: { tool: string; status?: string }) => s.status === "preparing" ? `Preparing ${s.tool.replace(/_/g, " ")}` : describe(s.tool).running;
  const activityLabel = unavailable ? "Live activity unavailable" : status === "queued" ? "Queued"
    : working ? activity?.phase === "delegates" ? "Waiting for delegated tasks"
      : current?.status === "waiting" || activity?.phase === "approval" ? "Waiting for approval"
        : current ? detailLabel(current) : "Working…" : statusLabel;
  const compactActivity = working && !!(current || activity?.phase);
  const countSuffix = active.length > 1 ? ` · +${active.length - 1} active` : completed ? ` · ${completed} completed` : "";
  const meta = compactActivity
    ? `${activityLabel}${countSuffix}`
    : [activityLabel, output.label].filter(Boolean).join(" · ");
  const waitingMessage = unavailable ? "Live access to this assignment is unavailable. Open task to view its saved history."
    : status === "queued" ? "Waiting to start. This reply will continue when the task returns."
      : working ? activity?.phase === "delegates" ? "Waiting for delegated tasks to return."
        : current?.status === "waiting" || activity?.phase === "approval" ? "Waiting for approval before the next tool can run."
          : "The agent is working. Tool steps will appear here as they start."
        : status === "done" ? "Task completed. Open task to read the reply." : "No tool steps were recorded for this task.";
  const recent = steps.slice(-3);
  return (
    <div data-delegation-card={status} className="mt-2 flex flex-col gap-3 rounded-[14px] border border-border bg-surface/50 p-4">
      <div className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 sm:gap-3">
        <span className={cn("inline-flex shrink-0", !working && visible && !still && "delegate-bob")}>
          {output.botId ? (
            <BotAvatar botId={output.botId} value={output.avatar} size={44} state={working ? "working" : "idle"} activity={working ? "working" : "decorative"} />
          ) : (
            <span aria-hidden="true" className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-base font-semibold text-muted">
              {botName.charAt(0).toUpperCase() || "?"}
            </span>
          )}
        </span>
        <button
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${botName || "delegated task"} response`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-describedby={`${detailsId}-status`}
          onClick={() => setExpanded((value) => !value)}
          className="col-span-2 flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:col-span-1"
        >
          <span className="flex min-w-0 grow flex-col gap-1">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg">
              {working && <Circle aria-hidden="true" className="h-2 w-2 shrink-0 fill-current text-success" />}
              <span className="truncate">{botName || "Delegated task"}</span>
            </span>
            <span id={`${detailsId}-status`} className="flex min-w-0 items-center gap-1 text-xs text-muted" title={meta}>
              {working && !current?.status?.includes("waiting") && !activity?.phase ? <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
                : (status === "queued" || working) && <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate" role="status" aria-label={meta}>{compactActivity ? <>{activityLabel}<span className="hidden text-subtle sm:inline">{countSuffix}</span></> : meta}</span>
            </span>
          </span>
          {expanded ? <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />}
        </button>
        {output.conversationId && output.taskId && (
          <Link href={`/c/${encodeURIComponent(output.conversationId)}`} className="col-start-2 row-start-2 w-fit rounded-lg border border-border px-3 py-2 text-[13px] leading-none text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:col-start-3 sm:row-start-1">
            Open task
          </Link>
        )}
      </div>
      {(output.error || status === "error") && <div className="text-danger">{output.error ?? "The delegated task failed. Open task for details."}</div>}
      <div id={detailsId} hidden={!expanded} className="space-y-3 border-t border-border pt-3">
        {expanded && <>
          {recent.length > 0 && <div className="space-y-2 text-xs text-muted" aria-label="Recent tool steps">
            {recent.map((s, i) => {
              const running = s.status === "running" || s.status === "preparing";
              const failed = s.status === "error" || s.status === "denied";
              return <div key={i} className="flex min-w-0 items-center gap-2">
                {running ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
                  : s.status === "waiting" ? <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    : failed ? <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-danger" /> : <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                <span className={cn("min-w-0 grow truncate", running && "text-fg")} title={detailLabel(s)}>{detailLabel(s)}</span>
                <span className="shrink-0 text-subtle">{s.status === "preparing" ? "Preparing" : running ? "Running" : s.status === "waiting" ? "Waiting" : s.status === "denied" ? "Denied" : failed ? "Failed" : "Done"}</span>
              </div>;
            })}
            {steps.length > 3 && <p className="text-subtle">Showing 3 recent steps. Open task for the full history.</p>}
          </div>}
          {(!steps.length || status === "queued" || current?.status === "waiting" || activity?.phase || unavailable) && <p className="text-xs text-muted">{waitingMessage}</p>}
          {status === "done" && output.answer ? <Markdown text={output.answer} className="markdown-bubble text-fg" />
            : status === "done" && steps.length > 0 && <p className="text-xs text-muted">{waitingMessage}</p>}
        </>}
      </div>
    </div>
  );
}

export function ToolPartView({
  part,
  botName,
  onApprove,
  onDeny,
  onAlwaysAllow,
  live = true,
  readOnly = false,
}: {
  part: AnyToolPart;
  botName?: string;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onAlwaysAllow?: (approvalId: string, toolName: string) => void;
  /** The message is still streaming (a running command can be stopped; otherwise it was interrupted). */
  live?: boolean;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const openWorkspaceFile = useWorkspaceFileOpener();
  const name = getToolOrDynamicToolName(part);
  const d = describe(name);
  const Icon = d.icon;

  if ((name === "workspace_bash" || name === "workspace_write" || name === "workspace_edit") && part.state === "approval-requested" && !part.approval.isAutomatic) {
    return <WorkspaceApproval name={name} part={part} botName={botName} disabled={readOnly} onApprove={onApprove} onDeny={onDeny} onAlwaysAllow={part.approval.requestReason === ENFORCED_APPROVAL_REASON ? undefined : onAlwaysAllow} />;
  }
  if (name === "workspace_bash" && ["input-available", "approval-responded", "output-available"].includes(part.state)) {
    return <BashResult part={part as never} live={live} />;
  }

  if (isHermesTool(name) && part.state === "approval-requested" && !part.approval.isAutomatic) {
    const ask = (part.input ?? {}) as { command?: string; reason?: string; preview?: string; expires_in_s?: number };
    const minutes = ask.expires_in_s ? Math.max(1, Math.round(ask.expires_in_s / 60)) : null;
    return (
      <div className="my-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
          <Icon className="h-4 w-4 text-accent" /> {botName ?? "The bot"} wants to {d.ask}
        </div>
        <div className="space-y-1 px-4 py-3">
          {ask.reason && <p className="text-sm text-muted">Hermes flagged this: {ask.reason}</p>}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">{ask.command ?? ask.preview}</pre>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <Button size="sm" disabled={readOnly} onClick={() => onApprove(part.approval.id)}>
            <Check className="h-4 w-4" /> Allow once
          </Button>
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => onDeny(part.approval.id)}>
            <X className="h-4 w-4" /> Deny
          </Button>
          {readOnly && <span className="text-xs text-muted">Approval is unavailable in this saved conversation.</span>}
          {!readOnly && minutes && <span className="ml-auto text-xs text-subtle">Hermes denies it if nobody answers within {minutes} min.</span>}
        </div>
      </div>
    );
  }

  if (name === "m365_send_mail" && part.state === "approval-requested" && !part.approval.isAutomatic) {
    const mail = (part.input ?? {}) as { to?: string[]; subject?: string; body?: string };
    return (
      <div className="my-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">
          <Mail className="h-4 w-4 text-accent" /> Draft email from {botName ?? "the bot"} — review before it&apos;s sent
        </div>
        <dl className="space-y-1 px-4 py-3 text-sm">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted">To</dt>
            <dd className="break-all">{mail.to?.join(", ")}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted">Subject</dt>
            <dd className="font-medium">{mail.subject}</dd>
          </div>
        </dl>
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-border px-4 py-3 text-sm">{mail.body}</div>
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          <Button size="sm" onClick={() => onApprove(part.approval.id)}>
            <Mail className="h-4 w-4" /> Send email
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDeny(part.approval.id)}>
            <X className="h-4 w-4" /> Discard
          </Button>
          <span className="ml-auto self-center text-xs text-subtle">Ask the bot to change anything before sending.</span>
        </div>
      </div>
    );
  }

  if (part.state === "approval-requested" && !part.approval.isAutomatic) {
    return (
      <div className="my-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldQuestion className="h-4 w-4 text-accent" />
          {botName ?? "The bot"} wants to {d.ask}
        </div>
        {part.approval.requestReason && <p className="mt-1 text-sm text-muted">{part.approval.requestReason}</p>}
        <div className="mt-3">
          <Json value={part.input} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onApprove(part.approval.id)}>
            <Check className="h-4 w-4" /> Allow once
          </Button>
          {onAlwaysAllow && isGrantable(name) && part.approval.requestReason !== ENFORCED_APPROVAL_REASON && (
            <Button size="sm" variant="outline" onClick={() => onAlwaysAllow(part.approval.id, name)}>
              Always allow
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onDeny(part.approval.id)}>
            <X className="h-4 w-4" /> Deny
          </Button>
        </div>
      </div>
    );
  }

  const running = part.state === "input-streaming" || part.state === "input-available" || part.state === "approval-responded";
  const failed = part.state === "output-error";
  const denied = part.state === "output-denied";
  const output = part.state === "output-available" ? part.output : undefined;
  const isDelegate = isDelegationTool(name);
  const artifact = workspaceArtifact(name, output);
  const preliminary = part.state === "output-available" && !!(part as { preliminary?: boolean }).preliminary;
  // A turn that ended mid-tool (timeout, stop) leaves its last progress update behind: show it as interrupted.
  const preliminaryRunning = preliminary && live;
  // Remote tool steps whose run ended without a result must not keep spinning.
  const interrupted = (preliminary && !live) || (running && !live && (isHermesTool(name) || name === "openai_web_search"));

  return (
    <div className="my-2 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex items-center gap-2 text-muted hover:text-fg", denied && "line-through")}
      >
        {(running && !interrupted) || preliminaryRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : failed ? <AlertTriangle className="h-4 w-4 text-danger" /> : <Icon className="h-4 w-4" />}
        <span className={cn(running && !interrupted && "animate-pulse")}>
          {denied ? `${d.done} — denied` : failed ? `${d.done} — failed` : interrupted ? `${d.running} — interrupted` : running || preliminaryRunning ? d.running : d.done}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {isDelegate && !!output && typeof output === "object" && <DelegationCard output={output as DelegateOutput} />}
      {artifact && <div className="mt-2 flex flex-wrap gap-2">
        {openWorkspaceFile && <button onClick={() => openWorkspaceFile(artifact.path)} className="inline-flex max-w-full break-all rounded-lg border border-border px-3 py-2 hover:bg-hover">Open {artifact.path.split("/").at(-1)}</button>}
        <a href={artifact.downloadUrl} download className="inline-flex max-w-full break-all rounded-lg border border-border px-3 py-2 underline">Download {artifact.path.split("/").at(-1)}</a>
      </div>}
      {open && (
        <div className="mt-2 space-y-2">
          <div className="text-xs font-medium text-subtle">Input</div>
          <Json value={part.input} />
          {output !== undefined && (
            <>
              <div className="text-xs font-medium text-subtle">Result</div>
              <Json value={output} />
            </>
          )}
          {failed && <Json value={part.errorText} />}
        </div>
      )}
    </div>
  );
}
