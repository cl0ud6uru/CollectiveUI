/**
 * Real UI chunk sequences for the run-layer tests: streamText over a mock model, wrapped the way runTurn wraps it
 * (createUIMessageStream with the history as originalMessages, the response id pre-allocated, transient title), and
 * the message the SDK hands to onEnd (what runTurn persists).
 */
import {
  convertToModelMessages,
  createUIMessageStream,
  isStepCount,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
  type ToolApprovalConfiguration,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { StoredEvent } from "@/lib/runs/log";
import type { EventFilter } from "@/lib/runs/replay";

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

export const finishPart = (reason: "stop" | "tool-calls"): LanguageModelV4StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});

export const text = (id: string, s: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: s.slice(0, 3) },
  { type: "text-delta", id, delta: s.slice(3) },
  { type: "text-end", id },
];

export const userMessage = (id: string, s: string): PortalUIMessage => ({ id, role: "user", parts: [{ type: "text", text: s }] });

/** One segment: the model answers each call with the next part list. */
export async function runSegment(i: {
  calls: LanguageModelV4StreamPart[][];
  history: PortalUIMessage[];
  messageId: string;
  tools?: ToolSet;
  toolApproval?: ToolApprovalConfiguration<ToolSet, unknown>;
  title?: string;
  createdAt?: number;
}): Promise<{ chunks: UIMessageChunk[]; message: PortalUIMessage }> {
  let call = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(i.calls[call++] ?? []) }) });
  const messages = await convertToModelMessages(i.history, { tools: i.tools, ignoreIncompleteToolCalls: true });
  const result = streamText({ model, messages, tools: i.tools, toolApproval: i.toolApproval, stopWhen: isStepCount(i.calls.length) });
  let message: PortalUIMessage | undefined;
  const stream = createUIMessageStream<PortalUIMessage>({
    originalMessages: i.history,
    generateId: () => i.messageId,
    execute: ({ writer }) => {
      if (i.title) writer.write({ type: "data-title", data: { title: i.title }, transient: true } as never);
      writer.merge(
        toUIMessageStream<ToolSet, PortalUIMessage>({
          stream: result.stream,
          tools: i.tools,
          sendReasoning: true,
          messageMetadata: ({ part }) => {
            if (part.type === "start") return { createdAt: i.createdAt ?? 1, model: "mock" };
            if (part.type === "finish") return { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens };
            return undefined;
          },
        }),
      );
    },
    onEnd: ({ responseMessage }) => {
      message = responseMessage;
    },
  });
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await new Promise((r) => setTimeout(r, 0));
  if (!message) throw new Error("onEnd didn't run");
  return { chunks, message: structuredClone(message) };
}

/** What the browser's reducer makes of a chunk stream (from `message` for a continuation, else from empty). */
export async function reduce(chunks: UIMessageChunk[], message?: PortalUIMessage): Promise<PortalUIMessage> {
  let last: PortalUIMessage | undefined;
  for await (const m of readUIMessageStream<PortalUIMessage>({
    message: message ? structuredClone(message) : undefined,
    stream: convertArrayToReadableStream(chunks),
    terminateOnError: true,
  })) {
    last = m;
  }
  if (!last) throw new Error("no message");
  return last;
}

/** Builds run_events rows: chunks (transient data-* flagged like the writer does) and segment-end markers. */
export function eventLog() {
  const events: StoredEvent[] = [];
  const api = {
    events,
    chunks(segment: number, chunks: UIMessageChunk[]) {
      for (const chunk of chunks) {
        const transient = chunk.type.startsWith("data-") && (chunk as { transient?: boolean }).transient === true;
        events.push({ seq: events.length + 1, segment, kind: "chunk", chunk, transient });
      }
      return api;
    },
    end(segment: number) {
      events.push({ seq: events.length + 1, segment, kind: "segment-end", chunk: null, transient: false });
      return api;
    },
  };
  return api;
}

/** The chunks a filter lets through, up to its "end" (and whether it ended). */
export function applyFilter(filter: EventFilter, events: StoredEvent[]) {
  const out: UIMessageChunk[] = [];
  for (const e of events) {
    const r = filter(e);
    if (r === "end") return { chunks: out, ended: true };
    if (r) out.push(r);
  }
  return { chunks: out, ended: false };
}

/** JSON round trip, as the message comes back from the database. */
export const stored = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
