"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, FilePen, Loader2, Square, Terminal, X } from "lucide-react";
import { stopWorkspaceCommand } from "@/app/(chat)/settings/workspace-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Part = {
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  preliminary?: boolean;
  approval?: { id: string; isAutomatic?: boolean; requestReason?: string };
};

export const WORKSPACE_TOOLS = new Set(["workspace_bash", "workspace_write", "workspace_edit", "workspace_read", "workspace_list", "workspace_grep"]);

function Pre({ children, tone }: { children: React.ReactNode; tone?: "add" | "del" | "err" }) {
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-xs",
        tone === "add" ? "bg-green-500/10 text-green-900 dark:text-green-200" : tone === "del" ? "bg-red-500/10 text-red-900 dark:text-red-200" : tone === "err" ? "bg-surface-2 text-danger" : "bg-surface-2",
      )}
    >
      {children}
    </pre>
  );
}

/**
 * Approval cards for workspace changes. Commands show exactly what will run and never offer "Always allow";
 * edits show the text being replaced; writes show the file.
 */
export function WorkspaceApproval({
  name,
  part,
  botName,
  onApprove,
  onDeny,
  onAlwaysAllow,
  disabled = false,
}: {
  name: string;
  part: Part;
  botName?: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAlwaysAllow?: (id: string, toolName: string) => void;
  disabled?: boolean;
}) {
  const id = part.approval!.id;
  const who = botName ?? "The bot";
  const input = (part.input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");

  let title: React.ReactNode;
  let body: React.ReactNode;
  if (name === "workspace_bash") {
    title = (
      <>
        <Terminal className="h-4 w-4 text-accent" /> {who} wants to run a command in your workspace
      </>
    );
    body = (
      <div className="space-y-1">
        {str("cwd") && <div className="text-xs text-muted">in {str("cwd")}</div>}
        <Pre>{str("command")}</Pre>
      </div>
    );
  } else if (name === "workspace_edit") {
    title = (
      <>
        <FilePen className="h-4 w-4 text-accent" /> {who} wants to edit <span className="font-mono">{str("path")}</span>
        {input.replace_all === true && <span className="text-xs text-muted">(every occurrence)</span>}
      </>
    );
    body = (
      <div className="space-y-1">
        <Pre tone="del">{str("old_string")}</Pre>
        <Pre tone="add">{str("new_string") || "(removed)"}</Pre>
      </div>
    );
  } else if (name === "workspace_write") {
    const content = str("content");
    title = (
      <>
        <FilePen className="h-4 w-4 text-accent" /> {who} wants to write <span className="font-mono">{str("path")}</span>
        <span className="text-xs text-muted">({content.length.toLocaleString()} characters)</span>
      </>
    );
    body = <Pre>{content.length > 20_000 ? `${content.slice(0, 20_000)}\n…` : content}</Pre>;
  } else {
    title = <>{who} wants to {name.replace("workspace_", "")} in your workspace</>;
    body = <Pre>{JSON.stringify(input, null, 2)}</Pre>;
  }

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-medium">{title}</div>
      <div className="px-4 py-3">{body}</div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <Button size="sm" disabled={disabled} onClick={() => onApprove(id)}>
          <Check className="h-4 w-4" /> {name === "workspace_bash" ? "Run" : "Allow once"}
        </Button>
        {name !== "workspace_bash" && onAlwaysAllow && (
          <Button size="sm" disabled={disabled} variant="outline" onClick={() => onAlwaysAllow(id, name)}>
            Always allow
          </Button>
        )}
        <Button size="sm" disabled={disabled} variant="ghost" onClick={() => onDeny(id)}>
          <X className="h-4 w-4" /> Deny
        </Button>
        {name === "workspace_bash" && <span className="ml-auto text-xs text-subtle">Workspace permissions control approvals. Your workspace has no network.</span>}
      </div>
    </div>
  );
}

type BashOutput =
  | { status: "running"; stdout: string; stderr: string; bytes: number }
  | { status: "done"; ok: boolean; exitCode: number; reason: string; stdout: string; stderr: string; truncated: boolean; durationMs: number }
  | { status: "error"; reason: string; message: string };

const REASON: Record<string, string> = { timeout: "timed out", output_limit: "stopped: too much output", killed: "stopped", stopped: "workspace stopped", died: "workspace restarted" };

/** A command's live output (with Stop) and its result. */
export function BashResult({ part, live }: { part: Part; live: boolean }) {
  const [stopping, setStopping] = useState(false);
  const input = (part.input ?? {}) as { command?: string };
  const o = part.output as BashOutput | undefined;
  const running = (part.state === "output-available" && part.preliminary) || part.state === "input-available" || part.state === "approval-responded";
  const interrupted = running && !live;

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border text-sm">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2/50 px-3 py-1.5">
        {running && !interrupted ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" /> : <Terminal className="h-3.5 w-3.5 text-muted" />}
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{input.command}</code>
        {o?.status === "done" && (
          <span className={cn("rounded-full px-2 py-0.5 text-xs", o.ok ? "bg-green-500/15 text-green-700 dark:text-green-300" : "bg-red-500/15 text-red-700 dark:text-red-300")}>
            exit {o.exitCode}
            {REASON[o.reason] ? ` · ${REASON[o.reason]}` : ""} · {(o.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {interrupted && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">interrupted</span>}
        {running && !interrupted && (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            aria-label="Stop command"
            onClick={async () => {
              setStopping(true);
              const r = await stopWorkspaceCommand(part.toolCallId).catch(() => ({ ok: false as const, error: "Couldn't stop it" }));
              if (!r.ok) toast.error(r.error);
              setStopping(false);
            }}
          >
            <Square className="h-3 w-3" /> Stop
          </Button>
        )}
      </div>
      {o?.status === "error" ? (
        <div className="px-3 py-2 text-danger">{o.message}</div>
      ) : o ? (
        <div className="space-y-1 p-2">
          {!!o.stdout && <Pre>{o.stdout}</Pre>}
          {!!o.stderr && <Pre tone="err">{o.stderr}</Pre>}
          {o.status === "done" && !o.stdout && !o.stderr && <div className="px-1 text-xs text-muted">(no output)</div>}
          {o.status === "done" && o.truncated && <div className="px-1 text-xs text-muted">Output shortened (the start and end are kept).</div>}
        </div>
      ) : null}
    </div>
  );
}
