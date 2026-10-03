import { readUIMessageStream, type UIMessageChunk } from "ai";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { StoredEvent } from "./log";
import type { AgentRunStatus } from "./types";

/** Per event: the chunk to send, null to skip it, or "end" to close the stream. Stateful (keeps the first start). */
export type EventFilter = (e: StoredEvent) => UIMessageChunk | null | "end";

/** What a dropped start/finish still contributes to the message: its metadata (the reducer merges it the same way). */
const metadataOf = (chunk: { messageMetadata?: unknown }): UIMessageChunk | null =>
  chunk.messageMetadata != null ? { type: "message-metadata", messageMetadata: chunk.messageMetadata } : null;

/** `keepTransientAfter`: transient chunks with a larger seq pass (null: all do; Infinity: none do). */
function eventFilter(targetSegment: number, keepTransientAfter: number | null): EventFilter {
  let started = false;
  return (e) => {
    if (e.kind === "segment-end") return e.segment >= targetSegment ? "end" : null;
    const chunk = e.chunk;
    if (!chunk) return null;
    if (e.transient && keepTransientAfter !== null && e.seq <= keepTransientAfter) return null;
    if (chunk.type === "start") {
      // Every segment's stream begins with a start (same messageId): the browser needs exactly one.
      if (started) return metadataOf(chunk);
      started = true;
      return chunk;
    }
    // An earlier segment's end isn't the end of the message: the next segment continues it.
    if (chunk.type === "finish" && e.segment < targetSegment) return metadataOf(chunk);
    if (chunk.type === "abort" && e.segment < targetSegment) return null;
    return chunk;
  };
}

/**
 * GET /api/chat/[id]/stream replay from seq 1: keep only the first `start`; drop `finish`/`abort` of segments below
 * `targetSegment`; drop transient chunks up to `liveAfterSeq` (the backlog: a title or notice already seen; ones that
 * arrive while following live still pass); skip segment-end markers of earlier segments; "end" at the segment-end of
 * a segment >= targetSegment. A dropped start or finish that carries message metadata becomes a `message-metadata`
 * chunk, so the replayed message has the same metadata as the saved one.
 */
export function replayFilter(targetSegment: number, liveAfterSeq = Infinity): EventFilter {
  return eventFilter(targetSegment, liveAfterSeq);
}

/**
 * A live tail from a segment boundary (chat POST): passes everything incl. transient chunks; "end" at segment-end >=
 * targetSegment. (Same structural rules as replayFilter, which only matter if it starts below the boundary.)
 */
export function liveFilter(targetSegment: number): EventFilter {
  return eventFilter(targetSegment, null);
}

/** Text / reasoning stream ids started and not ended yet (UI text parts don't keep their stream id). */
export type OpenStreamIds = { text: string[]; reasoning: string[] };

/** Follows text-start/-end and reasoning-start/-end the way the SDK reducer does (reset-step drops them all). */
export function trackOpenStreams() {
  const text = new Set<string>();
  const reasoning = new Set<string>();
  return {
    see(chunk: UIMessageChunk) {
      switch (chunk.type) {
        case "text-start":
          text.add(chunk.id);
          break;
        case "text-end":
          text.delete(chunk.id);
          break;
        case "reasoning-start":
          reasoning.add(chunk.id);
          break;
        case "reasoning-end":
          reasoning.delete(chunk.id);
          break;
        case "reset-step":
          text.clear();
          reasoning.clear();
          break;
      }
    },
    ids(): OpenStreamIds {
      return { text: [...text], reasoning: [...reasoning] };
    },
  };
}

/** The stream ids a chunk sequence (one segment, in order) left open: for closing a run rebuilt from its events. */
export function openStreamIdsOf(chunks: UIMessageChunk[]): OpenStreamIds {
  const t = trackOpenStreams();
  for (const c of chunks) t.see(c);
  return t.ids();
}

// Loose view of a tool part: the closing only reads and sets these fields.
type ToolPartView = {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  rawInput?: unknown;
  errorText?: string;
  preliminary?: boolean;
  approval?: { id: string; approved?: boolean; reason?: string; [k: string]: unknown };
};

const isToolPart = (p: { type: string }): p is ToolPartView => p.type === "dynamic-tool" || p.type.startsWith("tool-");

const INTERRUPTED = "Interrupted.";

/**
 * Closes what a finished (or paused) run left open, as chunks for the log plus the equivalent message (the message is
 * what the SDK reducer makes of the run's chunks followed by these, so a replay shows exactly what was saved):
 * - approval-responded, approved, without output → output-error `stoppedText` ("Stopped before it ran.")
 * - approval-responded, denied → output-denied
 * - input-available / output-available with preliminary: true → output-error "Interrupted."
 * - input-streaming → output-error "Interrupted." with the input streamed so far (an output-error's input goes back
 *   to the model as the call's arguments): tool-output-error keeps it; with no input yet, tool-input-error sets {}
 *   (it only finds parts of the last step; the SDK keeps a static tool's as rawInput)
 * - text / reasoning parts in state "streaming" → state done, plus text-end / reasoning-end for `openIds` (the
 *   writer's or openStreamIdsOf's: a text part doesn't carry its stream id, and an end for an id the stream didn't
 *   open would break the browser's reducer, so none is guessed)
 * - approval-requested → kept when `status` is "waiting", else output-denied with `deniedReason` ("Not answered.")
 *   (a tool-approval-response carries the reason, then tool-output-denied)
 * - `endNote` (a failed or interrupted run) → a `data-run-error` part saying why the reply ended, so it still shows
 *   after a reload (the stream's error chunk isn't part of the message)
 */
export function closeOpenParts(
  message: PortalUIMessage,
  status: AgentRunStatus,
  opts: { deniedReason?: string; stoppedText?: string; openIds?: OpenStreamIds; endNote?: string } = {},
): { chunks: UIMessageChunk[]; message: PortalUIMessage; changed: boolean } {
  const chunks: UIMessageChunk[] = [];
  for (const id of opts.openIds?.text ?? []) chunks.push({ type: "text-end", id });
  for (const id of opts.openIds?.reasoning ?? []) chunks.push({ type: "reasoning-end", id });
  const parts = structuredClone(message.parts) as unknown as { type: string; state?: string }[];
  let changed = chunks.length > 0;
  let lastStep = -1;
  parts.forEach((p, i) => {
    if (p.type === "step-start") lastStep = i;
  });

  parts.forEach((part, i) => {
    if ((part.type === "text" || part.type === "reasoning") && part.state === "streaming") {
      part.state = "done";
      changed = true;
      return;
    }
    if (!isToolPart(part)) return;
    const p = part;
    const dynamic = p.type === "dynamic-tool";
    const toolCallId = p.toolCallId;
    const toError = (errorText: string) => {
      chunks.push({ type: "tool-output-error", toolCallId, errorText, ...(dynamic ? { dynamic: true } : {}) });
      p.state = "output-error";
      p.errorText = errorText;
      delete p.output;
      delete p.preliminary;
      changed = true;
    };
    switch (p.state) {
      case "approval-responded":
        if (p.approval?.approved) toError(opts.stoppedText ?? "Stopped before it ran.");
        else {
          chunks.push({ type: "tool-output-denied", toolCallId });
          p.state = "output-denied";
          changed = true;
        }
        break;
      case "approval-requested": {
        if (status === "waiting" || status === "waiting_tasks") break;
        const reason = opts.deniedReason ?? "Not answered.";
        if (p.approval) {
          chunks.push({ type: "tool-approval-response", approvalId: p.approval.id, approved: false, reason });
          p.approval = { ...p.approval, approved: false, reason };
        }
        chunks.push({ type: "tool-output-denied", toolCallId });
        p.state = "output-denied";
        changed = true;
        break;
      }
      case "input-available":
        toError(INTERRUPTED);
        break;
      case "output-available":
        if (p.preliminary) toError(INTERRUPTED);
        else if (p.output && typeof p.output === "object" && "taskId" in p.output && "status" in p.output && p.output.status === "queued" && status !== "waiting_tasks" && status !== "waiting")
          toError("The assignment did not finish in this reply. Review its task before requesting another attempt; actions may have run.");
        break;
      case "input-streaming": {
        if (p.input !== undefined || i < lastStep) {
          toError(INTERRUPTED);
          break;
        }
        const input = {};
        const toolName = dynamic ? (p.toolName ?? "tool") : p.type.slice("tool-".length);
        chunks.push({ type: "tool-input-error", toolCallId, toolName, input, errorText: INTERRUPTED, ...(dynamic ? { dynamic: true } : {}) });
        p.state = "output-error";
        p.errorText = INTERRUPTED;
        // What the reducer does with a tool-input-error: a static tool keeps it as rawInput (see
        // node_modules/ai/src/ui/process-ui-message-stream.ts), a dynamic one as input.
        if (dynamic) p.input = input;
        else {
          delete p.input;
          p.rawInput = input;
        }
        changed = true;
        break;
      }
    }
  });

  // Why the reply ended early, kept with the message (the stream's error chunk is only seen live).
  if (opts.endNote) {
    const note = { type: "data-run-error" as const, data: { message: opts.endNote } };
    chunks.push(note);
    parts.push(note);
    changed = true;
  }

  return { chunks, message: { ...message, parts: parts as unknown as PortalUIMessage["parts"] }, changed };
}

/**
 * Rebuilds the message a run streamed (sweeper, after its worker died): `stored` (the saved message, for a
 * continuation segment) plus `chunks` (non-transient, in order) through readUIMessageStream({terminateOnError: true}).
 * Without `stored` the chunks must begin with the segment's `start` (one is added when missing). `error` chunks are
 * skipped (they don't change the message, and would end the read); a malformed stream keeps what was read before it.
 */
export async function rebuildMessage(stored: PortalUIMessage | null, chunks: UIMessageChunk[], messageId: string): Promise<PortalUIMessage> {
  const body = chunks.filter((c) => c.type !== "error");
  if (!stored && body[0]?.type !== "start") body.unshift({ type: "start", messageId });
  // The reader only snapshots on chunks that "write" (a trailing start-step doesn't): a closing start with the same
  // id makes the last snapshot the final state.
  body.push({ type: "start", messageId });
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const chunk of body) c.enqueue(chunk);
      c.close();
    },
  });
  let last: PortalUIMessage | undefined;
  try {
    for await (const m of readUIMessageStream<PortalUIMessage>({ message: stored ? structuredClone(stored) : undefined, stream, terminateOnError: true })) {
      last = m;
    }
  } catch (err) {
    console.warn(`[runs] rebuilding message ${messageId} stopped at a malformed chunk`, err);
  }
  const out = last ?? (stored ? structuredClone(stored) : { id: messageId, role: "assistant" as const, parts: [] });
  return out.id ? out : { ...out, id: messageId };
}
