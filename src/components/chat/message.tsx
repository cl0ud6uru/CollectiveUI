"use client";

import { useState } from "react";
import { isToolUIPart } from "ai";
import { ChevronLeft, ChevronRight, FileText, Pencil, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import type { PortalUIMessage } from "@/lib/chat/store";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { CopyButton, Markdown } from "./markdown";
import { needsAction, StepsGroup } from "./steps";
import { ToolPartView } from "./tool-part";

export type BranchInfo = { index: number; total: number; onPrev: () => void; onNext: () => void };

/**
 * "plain": ChatGPT layout for app/model chats (grey user bubble, assistant as full-width text).
 * "bubbles": messaging layout for bot and group chats (Grok Bot / ChatGPT dots): the bot's text in grey bubbles, your
 * messages in the bot's colour, the speaker's avatar at the end of each run in groups.
 */
export type MessageVariant = "plain" | "bubbles";
export type BubbleTint = { bg: string; fg: string };

function BranchSwitcher({ info }: { info?: BranchInfo }) {
  if (!info || info.total < 2) return null;
  return (
    <div className="flex items-center text-xs text-muted">
      <button onClick={info.onPrev} disabled={info.index === 0} className="rounded p-1 hover:bg-hover disabled:opacity-30" aria-label="Previous version">
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="tabular-nums">
        {info.index + 1}/{info.total}
      </span>
      <button onClick={info.onNext} disabled={info.index === info.total - 1} className="rounded p-1 hover:bg-hover disabled:opacity-30" aria-label="Next version">
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function textOf(m: PortalUIMessage) {
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n\n");
}

function FileChip({ part }: { part: { mediaType: string; filename?: string; url: string } }) {
  if (part.mediaType.startsWith("image/")) {
    return (
      <a href={part.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={part.url} alt={part.filename ?? "image"} className="max-h-60 max-w-[240px] object-cover" />
      </a>
    );
  }
  return (
    <a href={part.url} target="_blank" rel="noreferrer" className="flex max-w-[260px] items-center gap-3 rounded-2xl border border-border bg-bg p-2 pr-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#ff5588] text-white">
        <FileText className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{part.filename ?? "File"}</span>
        <span className="block text-xs uppercase text-muted">{part.filename?.split(".").pop() ?? part.mediaType}</span>
      </span>
    </a>
  );
}

export function UserMessage({
  message,
  branch,
  onEdit,
  readOnly,
  variant = "plain",
  tint,
}: {
  message: PortalUIMessage;
  branch?: BranchInfo;
  onEdit?: (text: string) => void;
  readOnly?: boolean;
  variant?: MessageVariant;
  tint?: BubbleTint;
}) {
  const [editing, setEditing] = useState(false);
  const text = textOf(message);
  const [draft, setDraft] = useState(text);
  const files = message.parts.filter((p) => p.type === "file") as { mediaType: string; filename?: string; url: string }[];

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full rounded-3xl bg-surface-2 p-3">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="max-h-[50vh] min-h-[80px] w-full resize-none bg-transparent px-2 py-1 text-base outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" className="bg-bg" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!draft.trim() || !onEdit}
              onClick={() => {
                setEditing(false);
                onEdit?.(draft);
              }}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-1">
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {files.map((f, i) => (
            <FileChip key={i} part={f} />
          ))}
        </div>
      )}
      {text &&
        (variant === "bubbles" ? (
          <div
            className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] px-4 py-2 text-[15px] leading-relaxed sm:max-w-[70%]"
            style={{ background: tint?.bg ?? "var(--accent)", color: tint?.fg ?? "var(--accent-fg)" }}
          >
            {text}
          </div>
        ) : (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-surface-2 px-5 py-2.5 text-base sm:max-w-[70%]">
            {text}
          </div>
        ))}
      <div className="flex items-center gap-1 text-muted opacity-0 transition-opacity group-hover:opacity-100">
        <Tip label="Copy">
          <span>
            <CopyButton text={text} label="" className="rounded-lg p-1.5 hover:bg-hover" />
          </span>
        </Tip>
        {!readOnly && onEdit && (
          <Tip label="Edit message">
            <button onClick={() => { setDraft(text); setEditing(true); }} className="rounded-lg p-1.5 hover:bg-hover" aria-label="Edit message">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </Tip>
        )}
        <BranchSwitcher info={branch} />
      </div>
    </div>
  );
}

/** Short plain paragraphs read like chat messages; anything with code, tables, lists or headings stays one bubble. */
const RICH = /```|^\s*([|#>]|[-*+] |\d+\. )/m;
const isRich = (text: string) => RICH.test(text);

export function splitBubbles(text: string): string[] {
  if (isRich(text)) return [text];
  const paras = text.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
  return paras.length > 1 && paras.length <= 6 ? paras : [text];
}

type Part = PortalUIMessage["parts"][number];
type Speaker = { botId?: string; name: string; avatar: string | null };
type Block =
  | { kind: "part"; part: Part; index: number }
  | { kind: "steps"; parts: { part: Part; index: number }[] };

/** Consecutive tool steps become one block; steps waiting for your approval always stand alone. */
function toBlocks(parts: { part: Part; index: number }[]): Block[] {
  const out: Block[] = [];
  for (const p of parts) {
    // Step boundaries carry no content and must not split a run of tool calls.
    if (p.part.type === "step-start") continue;
    const last = out.at(-1);
    if (isToolUIPart(p.part) && !needsAction(p.part)) {
      if (last?.kind === "steps") last.parts.push(p);
      else out.push({ kind: "steps", parts: [p] });
    } else out.push({ kind: "part", ...p });
  }
  return out;
}

/** Group replies: each bot's turn starts with a speaker marker; split the parts into runs per speaker. */
function toRuns(parts: Part[]): { speaker: Speaker | null; parts: { part: Part; index: number }[] }[] {
  const runs: { speaker: Speaker | null; parts: { part: Part; index: number }[] }[] = [{ speaker: null, parts: [] }];
  parts.forEach((part, index) => {
    if (part.type === "data-speaker") runs.push({ speaker: part.data as Speaker, parts: [] });
    else runs[runs.length - 1].parts.push({ part, index });
  });
  return runs.filter((r) => r.speaker || r.parts.length);
}

export function AssistantMessage({
  message,
  streaming,
  isLast,
  branch,
  botName,
  feedback,
  readOnly,
  onRegenerate,
  onFeedback,
  onApprove,
  onDeny,
  onAlwaysAllow,
  variant = "plain",
}: {
  message: PortalUIMessage;
  streaming: boolean;
  isLast: boolean;
  branch?: BranchInfo;
  botName?: string;
  feedback?: 1 | -1 | null;
  readOnly?: boolean;
  onRegenerate?: () => void;
  onFeedback?: (v: 1 | -1 | null) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAlwaysAllow?: (id: string, toolName: string) => void;
  variant?: MessageVariant;
}) {
  const text = textOf(message);
  const lastTextIdx = message.parts.map((p) => p.type).lastIndexOf("text");
  const bubbles = variant === "bubbles";
  const runs = toRuns(message.parts);
  const stepGroups = runs.reduce((n, r) => n + toBlocks(r.parts).filter((b) => b.kind === "steps").length, 0);
  const meta = message.metadata;
  const searchCalls = new Set(message.parts.filter(p => isToolUIPart(p) && p.type === "tool-openai_web_search").map(p => (p as { toolCallId: string }).toolCallId)).size;

  const tool = (part: Part) =>
    isToolUIPart(part) ? (
      <ToolPartView
        key={part.toolCallId}
        part={part}
        botName={botName}
        onApprove={onApprove}
        onDeny={onDeny}
        onAlwaysAllow={readOnly ? undefined : onAlwaysAllow}
        live={streaming}
        readOnly={readOnly}
      />
    ) : null;

  const renderPart = (part: Part, i: number) => {
    if (part.type === "data-bot-error") {
      // Group chats: this bot couldn't answer (e.g. its ChatGPT plan isn't connected).
      return (
        <p key={i} className="text-sm italic text-muted">
          Couldn&apos;t answer: {(part.data as { message: string }).message}
        </p>
      );
    }
    if (part.type === "data-run-error") {
      // The reply ended early (an error, or the worker restarted); kept with the message so a reload shows why.
      return (
        <p key={i} className="text-sm italic text-muted">
          {(part.data as { message: string }).message}
        </p>
      );
    }
    if (part.type === "text") {
      if (!part.text) return null;
      const isStreamingText = streaming && i === lastTextIdx;
      if (!bubbles) return <Markdown key={i} text={part.text} streaming={isStreamingText} />;
      const chunks = splitBubbles(part.text);
      return (
        <div key={i} className="flex flex-col items-start gap-1">
          {chunks.map((chunk, j) => (
            // Rich answers (code, tables, lists) get the column's width; chatty paragraphs stay message-sized.
            <div key={j} className={cn("max-w-full rounded-[20px] bg-bubble-bot px-4 py-2.5", chunks.length === 1 && isRich(chunk) ? "w-full" : "sm:max-w-[85%]")}>
              <Markdown text={chunk} streaming={isStreamingText && j === chunks.length - 1} className="markdown-bubble" />
            </div>
          ))}
        </div>
      );
    }
    if (part.type === "reasoning") {
      return part.text ? (
        <details key={i} className="mb-2 text-sm text-muted">
          <summary className="cursor-pointer select-none">{streaming ? "Thinking…" : "Thought for a moment"}</summary>
          <div className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3">{part.text}</div>
        </details>
      ) : null;
    }
    if (part.type === "source-url") {
      return (
        <a key={i} href={part.url} target="_blank" rel="noreferrer" className="mr-2 inline-flex rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted hover:text-fg">
          {part.title ?? new URL(part.url).hostname}
        </a>
      );
    }
    return tool(part);
  };

  const renderBlocks = (parts: { part: Part; index: number }[], lastRun: boolean) => {
    const blocks = toBlocks(parts);
    return blocks.map((b, bi) => {
      if (b.kind === "part") return renderPart(b.part, b.index);
      if (b.parts.length === 1) return tool(b.parts[0].part);
      return (
        <StepsGroup
          key={`steps-${b.parts[0].index}`}
          parts={b.parts.map((p) => p.part) as never}
          live={streaming && lastRun && bi === blocks.length - 1}
          startedAt={meta?.startedAt}
          finishedAt={meta?.finishedAt}
          timed={stepGroups === 1}
        >
          {b.parts.map((p) => tool(p.part))}
        </StepsGroup>
      );
    });
  };

  return (
    <div className="group">
      <div className={cn(bubbles ? "space-y-1.5" : "space-y-1")}>
        {runs.map((run, ri) => {
          const lastRun = ri === runs.length - 1;
          if (!run.speaker) return <div key={ri} className={cn(bubbles ? "space-y-1.5" : "space-y-1")}>{renderBlocks(run.parts, lastRun)}</div>;
          const active = isLast && lastRun;
          const speakerActivity = active && run.parts.some(({ part }) => needsAction(part)) ? "approval" : streaming && lastRun ? "working" : active && run.parts.some(({ part }) => part.type === "data-run-error" || part.type === "data-bot-error") ? "attention" : "decorative";
          return bubbles ? (
            // Grok Bot groups: the sender's name above the run, their avatar beside its last bubble.
            <div key={ri} className={cn("flex items-end gap-2", ri > 0 && "pt-3")}>
              <BotAvatar botId={run.speaker.botId} activity={speakerActivity} value={run.speaker.avatar} size={28} className="mb-0.5 h-7 w-7" state={streaming && lastRun ? "working" : undefined} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="px-1 text-xs font-medium text-muted">{run.speaker.name}</div>
                {renderBlocks(run.parts, lastRun)}
              </div>
            </div>
          ) : (
            <div key={ri} className="space-y-1">
              <div className={cn("flex items-center gap-2 pb-1 text-sm font-semibold", ri > 0 && "mt-5")}>
                <BotAvatar botId={run.speaker.botId} activity={speakerActivity} value={run.speaker.avatar} size={24} className="h-6 w-6" />
                {run.speaker.name}
              </div>
              {renderBlocks(run.parts, lastRun)}
            </div>
          );
        })}
        {streaming && !text && !message.parts.some(isToolUIPart) && !bubbles && <span className="streaming-dot" />}
      </div>
      {searchCalls > 0 && <details className="mt-2 text-xs text-muted" data-testid="search-usage">
        <summary className="w-fit cursor-pointer">Search usage</summary>
        <p className="mt-1">OpenAI search: {searchCalls} observed call{searchCalls === 1 ? "" : "s"} · ${(searchCalls * 0.01).toFixed(2)} estimated tool fees, plus model/search-content tokens. Final billing may differ.</p>
      </details>}
      {!streaming && !message.parts.some((p) => isToolUIPart(p) && p.state === "approval-requested") && (
        <div
          className={cn(
            "mt-2 flex items-center gap-0.5 text-muted transition-opacity",
            isLast ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <Tip label="Copy">
            <span>
              <CopyButton text={text} label="" className="rounded-lg p-1.5 hover:bg-hover" />
            </span>
          </Tip>
          {!readOnly && (
            <>
              <Tip label="Good response">
                <button
                  onClick={() => onFeedback?.(feedback === 1 ? null : 1)}
                  className={cn("rounded-lg p-1.5 hover:bg-hover", feedback === 1 && "text-fg")}
                  aria-label="Good response"
                >
                  <ThumbsUp className={cn("h-3.5 w-3.5", feedback === 1 && "fill-current")} />
                </button>
              </Tip>
              <Tip label="Bad response">
                <button
                  onClick={() => onFeedback?.(feedback === -1 ? null : -1)}
                  className={cn("rounded-lg p-1.5 hover:bg-hover", feedback === -1 && "text-fg")}
                  aria-label="Bad response"
                >
                  <ThumbsDown className={cn("h-3.5 w-3.5", feedback === -1 && "fill-current")} />
                </button>
              </Tip>
              {onRegenerate && (
                <Tip label="Regenerate">
                  <button onClick={onRegenerate} className="rounded-lg p-1.5 hover:bg-hover" aria-label="Regenerate">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </Tip>
              )}
            </>
          )}
          <BranchSwitcher info={branch} />
          {message.metadata?.model && (
            <span className="ml-2 hidden text-xs text-subtle group-hover:inline">{message.metadata.model}</span>
          )}
        </div>
      )}
    </div>
  );
}
