"use client";

import { isDelegationTool } from "@/lib/delegation/policy";

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
import { Button } from "@/components/ui/button";
import { isGrantable, isHermesTool } from "@/lib/agent/tool-names";
import { ENFORCED_APPROVAL_REASON } from "@/lib/bots/service-policy";
import { cn } from "@/lib/utils";
import { BashResult, WorkspaceApproval } from "./workspace-parts";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type Label = { icon: React.ComponentType<{ className?: string }>; running: string; done: string; ask: string };

const LABELS: Record<string, Label> = {
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

type DelegateOutput = { taskId?: string; conversationId?: string | null; bot: string; status: string; steps: { tool: string; status?: string }[]; answer?: string; error?: string };

function DelegationTrace({ output }: { output: DelegateOutput }) {
  useEffect(() => { if (output.taskId) window.dispatchEvent(new Event("bot-work-changed")); }, [output.taskId, output.status]);
  return (
    <div className="mt-2 space-y-1 border-l-2 border-border pl-3 text-xs text-muted">
      {output.conversationId && output.taskId && <Link href={`/c/${encodeURIComponent(output.conversationId)}`} className="mb-2 block underline">Open {output.bot}’s task</Link>}
      {(output.steps ?? []).map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {s.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : s.status === "error" || s.status === "denied" ? <X className="h-3 w-3 text-danger" /> : <Check className="h-3 w-3" />} {s.status === "running" ? describe(s.tool).running : s.status === "error" || s.status === "denied" ? `${s.tool}: ${s.status}` : describe(s.tool).done}
        </div>
      ))}
      {output.status === "working" && (
        <div className="flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> {output.bot} is working…
        </div>
      )}
      {output.status === "queued" && <div>Scheduled independently. This reply will continue when the task returns.</div>}
      {output.error && <div className="text-danger">{output.error}</div>}
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
    return <WorkspaceApproval name={name} part={part} botName={botName} onApprove={onApprove} onDeny={onDeny} onAlwaysAllow={part.approval.requestReason === ENFORCED_APPROVAL_REASON ? undefined : onAlwaysAllow} />;
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
  const preliminary = part.state === "output-available" && !!(part as { preliminary?: boolean }).preliminary;
  // A turn that ended mid-tool (timeout, stop) leaves its last progress update behind: show it as interrupted.
  const preliminaryRunning = preliminary && live;
  // Hermes tool steps whose run ended (stopped, failed) without a result are shown as interrupted.
  const interrupted = (preliminary && !live) || (running && !live && isHermesTool(name));

  return (
    <div className="my-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn("flex items-center gap-2 text-muted hover:text-fg", denied && "line-through")}
      >
        {(running && !interrupted) || preliminaryRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : failed ? <AlertTriangle className="h-4 w-4 text-danger" /> : <Icon className="h-4 w-4" />}
        <span className={cn(running && !interrupted && "animate-pulse")}>
          {denied ? `${d.done} — denied` : failed ? `${d.done} — failed` : interrupted ? `${d.running} — interrupted` : running || preliminaryRunning ? d.running : d.done}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {isDelegate && !!output && typeof output === "object" && <DelegationTrace output={output as DelegateOutput} />}
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
