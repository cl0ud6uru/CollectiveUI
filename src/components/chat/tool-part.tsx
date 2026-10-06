"use client";

import { isDelegationTool } from "@/lib/delegation/policy";
import { workspaceArtifact } from "@/lib/chat/workspace-artifacts";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getToolOrDynamicToolName, type ToolUIPart, type DynamicToolUIPart } from "ai";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
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
import { Button } from "@/components/ui/button";
import { isGrantable, isHermesTool } from "@/lib/agent/tool-names";
import { ENFORCED_APPROVAL_REASON } from "@/lib/bots/service-policy";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { BashResult, WorkspaceApproval } from "./workspace-parts";

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
  taskId?: string; conversationId?: string | null; bot: string; botId?: string; avatar?: string | null; label?: string | null;
  status: string; steps: { tool: string; status?: string }[]; answer?: string; error?: string; startedAt?: string; finishedAt?: string;
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
  const [stepsOpen, setStepsOpen] = useState(false);
  useEffect(() => { if (output.taskId) window.dispatchEvent(new Event("bot-work-changed")); }, [output.taskId, output.status]);
  const working = output.status === "working";
  const steps = output.steps ?? [];
  const meta = [output.label, repliedIn(output)].filter(Boolean).join(" · ");
  return (
    <div data-delegation-card={output.status} className="mt-2 flex flex-col gap-3 rounded-[14px] border border-border bg-surface/50 p-4">
      <div className="flex items-center gap-3">
        <span className={cn("inline-flex shrink-0", !working && "delegate-bob")}>
          {output.botId ? (
            <BotAvatar botId={output.botId} value={output.avatar} size={44} state={working ? "working" : "idle"} activity={working ? "working" : "decorative"} />
          ) : (
            <span aria-hidden="true" className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-base font-semibold text-muted">
              {output.bot.trim().charAt(0).toUpperCase() || "?"}
            </span>
          )}
        </span>
        <div className="flex min-w-0 grow flex-col gap-px">
          <span className="truncate text-sm font-semibold text-fg">{output.bot}</span>
          {meta && <span className="truncate text-xs text-muted">{meta}</span>}
        </div>
        {output.conversationId && output.taskId && (
          <Link href={`/c/${encodeURIComponent(output.conversationId)}`} className="shrink-0 rounded-lg border border-border px-3 py-2 text-[13px] leading-none text-fg hover:bg-hover">
            Open task
          </Link>
        )}
      </div>
      {output.status === "done" && output.answer && <Markdown text={output.answer} className="markdown-bubble text-fg" />}
      {working && (
        <div className="flex items-center gap-2 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {output.bot} is working…
        </div>
      )}
      {output.status === "queued" && <div className="text-muted">Scheduled independently. This reply will continue when the task returns.</div>}
      {output.error && <div className="text-danger">{output.error}</div>}
      {steps.length > 0 && (
        <div className="text-xs text-muted">
          <button type="button" aria-expanded={stepsOpen} onClick={() => setStepsOpen((o) => !o)} className="flex items-center gap-1 hover:text-fg">
            {stepsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {steps.length} {steps.length === 1 ? "step" : "steps"}
          </button>
          {stepsOpen && (
            <div className="mt-2 space-y-1">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  {s.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : s.status === "error" || s.status === "denied" ? <X className="h-3 w-3 text-danger" /> : <Check className="h-3 w-3" />} {s.status === "running" ? describe(s.tool).running : s.status === "error" || s.status === "denied" ? `${s.tool}: ${s.status}` : describe(s.tool).done}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
      {artifact && <a href={artifact.downloadUrl} download className="mt-2 inline-flex max-w-full break-all rounded-lg border border-border px-3 py-2 underline">Download {artifact.path.split("/").at(-1)}</a>}
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
