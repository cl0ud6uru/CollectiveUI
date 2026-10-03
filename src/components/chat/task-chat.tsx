"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Loader2, Menu, Square } from "lucide-react";
import type { ConversationSnapshot } from "@/lib/chat/snapshot";
import type { PortalUIMessage } from "@/lib/chat/store";
import { AssistantMessage, UserMessage } from "./message";
import { StartSideChat } from "./start-side-chat";
import { useShell } from "./shell-context";
import { useTaskRead } from "./use-task-read";

const terminalKey = (task: NonNullable<ConversationSnapshot["task"]>) => `${task.runId}:${task.status}:${task.lastSeq}`;

/** Follow-ups are assigned through the originating bot; this view observes the ordered task turns. */
export function TaskChat({ snapshot }: { snapshot: ConversationSnapshot }) {
  const [task, setTask] = useState(snapshot.task!);
  const [error, setError] = useState<string | null>(null);
  const { setMobileOpen } = useShell();
  const active = ["queued", "running", "waiting_tasks"].includes(task.status);
  const [renderedTerminal, setRenderedTerminal] = useState<string | null>(active ? null : terminalKey(snapshot.task!));
  const streamRunId = useRef(task.runId);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/chat/${snapshot.conversationId}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as ConversationSnapshot;
    return data;
  }, [snapshot.conversationId]);
  // The transport invokes this callback on reconnect, never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const transport = useMemo(() => new DefaultChatTransport<PortalUIMessage>({ api: "/api/chat",
    prepareReconnectToStreamRequest: () => ({ api: `/api/chat/${snapshot.conversationId}/stream?runId=${encodeURIComponent(streamRunId.current)}` }) }), [snapshot.conversationId]);
  const { messages, setMessages, resumeStream, status } = useChat<PortalUIMessage>({ id: snapshot.conversationId, transport, resume: snapshot.resume,
    messages: snapshot.initialRows.map(r => r.message), onFinish: () => { setRenderedTerminal(null); },
    onError: err => { setError(err.message); setRenderedTerminal(null); } });
  useTaskRead(snapshot.conversationId, task, renderedTerminal === terminalKey(task) && status !== "streaming" && status !== "submitted");
  useEffect(() => {
    // Completed views still revalidate: another tab can continue this task at any time.
    let alive = true;
    let checking = false;
    const tick = async () => {
      if (document.hidden || checking) return;
      checking = true;
      try {
        const data = await refresh().catch(() => undefined);
        if (!alive || !data?.task) return;
        if (status === "streaming" || status === "submitted") {
          // The queued run can start while its stream is already attached. Refresh that
          // run's status, but never relabel an old stream as a newer invocation.
          if (data.task.runId === streamRunId.current) { setTask(data.task); setRenderedTerminal(null); }
          return;
        }
        setTask(data.task);
        streamRunId.current = data.task.runId;
        setMessages(data.initialRows.map(r => r.message));
        if (!["queued", "running", "waiting_tasks"].includes(data.task.status)) {
          setRenderedTerminal(terminalKey(data.task)); setError(null);
        } else if (data.resume && data.run && ["queued", "running"].includes(data.run.status)) {
          setRenderedTerminal(null);
          // Retry an idle or failed attachment even when the worker is still in the same segment.
          await resumeStream();
        } else setRenderedTerminal(null);
      } finally { checking = false; }
    };
    void tick().catch(() => {});
    const timer = setInterval(() => void tick().catch(() => {}), 2000);
    window.addEventListener("focus", tick);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [refresh, status, setMessages, resumeStream]);
  const savedErrorVisible = task.error && messages.some(m => m.parts.some(p => (p.type === "text" && p.text.includes(task.error!)) || (p.type === "data-run-error" && (p.data as { message?: string })?.message === task.error)));
  const displayedError = task.executionUnavailable ?? (savedErrorVisible ? null : task.error) ?? error;
  const label = task.cancelRequested && active ? "Stopping…" : ({ running: "Working", succeeded: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted", queued: "Queued", waiting: "Waiting", waiting_tasks: "Waiting for tasks" })[task.status];
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <button onClick={() => setMobileOpen(true)} className="md:hidden" aria-label="Open sidebar"><Menu className="h-5 w-5" /></button>
      <div className="min-w-0 flex-1"><h1 className="font-medium">{task.receiver} · Delegated task</h1><p className="text-xs text-muted">Assigned by {task.assigner}</p></div>
      {snapshot.target?.kind === "bot" && <StartSideChat botId={snapshot.target.id} />}
    </header>
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 text-sm" role="status">
      {active && <Loader2 className="h-4 w-4 animate-spin" />}<span>{label}</span>
      {task.queuedCount > 0 && <span className="text-muted">{task.queuedCount} follow-up{task.queuedCount === 1 ? "" : "s"} queued</span>}
      {task.status === "succeeded" && !task.returnedAt && <span className="text-muted">{task.deliveryPending ? `Returning result to ${task.assigner}…` : "Result not recorded in originating chat"}</span>}
      {task.returnedAt && <span className="text-muted">Result returned to {task.assigner}</span>}
      {task.originConversationId ? <Link className="ml-auto underline" href={`/c/${task.originConversationId}`}>Originating chat</Link> : <span className="ml-auto text-muted">Originating chat removed</span>}
      {active && <button disabled={task.cancelRequested} className="flex items-center gap-1 rounded-lg border border-border px-3 py-1 disabled:opacity-50" onClick={async () => {
        try { const r = await fetch(`/api/chat/${snapshot.conversationId}/stop`, { method: "POST" }); if (!r.ok) throw new Error("Could not stop the task."); }
        catch (e) { setError(e instanceof Error ? e.message : "Could not stop the task."); }
      }}><Square className="h-3 w-3" />Stop</button>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6"><div className="mx-auto max-w-3xl space-y-6">
      {messages.map((message, i) => message.role === "user" ? <div key={message.id}><p className="mb-2 text-right text-xs text-muted">Assignment from {task.assigner}</p><UserMessage message={message} readOnly /></div>
        : <AssistantMessage key={message.id} message={message} streaming={status === "streaming" && i === messages.length - 1} isLast={i === messages.length - 1} botName={task.receiver} readOnly onApprove={() => {}} onDeny={() => {}} />)}
      {displayedError && <p className="text-sm text-danger">{displayedError}</p>}
    </div></div>
    <p className="border-t border-border px-4 py-3 text-center text-xs text-muted">{task.mode === "async" ? "This task runs independently while its parent waits. You can close this page; its result will return to the originating chat and your Inbox." : "This assignment follows its originating turn."} Request related follow-ups in the originating chat. Stop ends all pending turns in this task. Earlier actions may have run; interrupted tasks do not restart automatically.</p>
  </div>;
}
