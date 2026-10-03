import type { UIMessageChunk } from "ai";

/**
 * Pure delta coalescer for the event log. `push` returns the drafts that must be flushed now (in order); `drain`
 * returns whatever is buffered. Merges consecutive text-delta / reasoning-delta chunks with the same id and
 * tool-input-delta chunks with the same toolCallId (the last providerMetadata wins); never merges across other chunk
 * types or transient chunks, so order is preserved. `bytes` is the buffered JSON size (for the flush threshold).
 */
export type Coalescer = {
  push(chunk: UIMessageChunk, transient?: boolean): { chunk: UIMessageChunk; transient: boolean }[];
  drain(): { chunk: UIMessageChunk; transient: boolean }[];
  readonly bytes: number;
  readonly size: number;
};

type Draft = { chunk: UIMessageChunk; transient: boolean };

/** The JSON size of a chunk as stored (and sent). */
export const chunkBytes = (chunk: UIMessageChunk) => JSON.stringify(chunk).length;

/** A string's length inside JSON (escapes counted), without the quotes. */
const jsonLength = (s: string) => JSON.stringify(s).length - 2;

/**
 * `next` folded into `prev` and how many bytes that adds, or null when they don't merge. Never mutates either. The
 * growth is counted from the appended text (re-serializing a growing chunk on every delta would be quadratic).
 */
function merge(prev: UIMessageChunk, next: UIMessageChunk): { chunk: UIMessageChunk; growth: number } | null {
  if (prev.type !== next.type) return null;
  if ((next.type === "text-delta" || next.type === "reasoning-delta") && (prev.type === "text-delta" || prev.type === "reasoning-delta")) {
    if (prev.id !== next.id) return null;
    const providerMetadata = next.providerMetadata ?? prev.providerMetadata;
    const chunk = { ...prev, delta: prev.delta + next.delta, ...(providerMetadata ? { providerMetadata } : {}) };
    return { chunk, growth: next.providerMetadata ? chunkBytes(chunk) - chunkBytes(prev) : jsonLength(next.delta) };
  }
  if (next.type === "tool-input-delta" && prev.type === "tool-input-delta") {
    if (prev.toolCallId !== next.toolCallId) return null;
    return { chunk: { ...prev, inputTextDelta: prev.inputTextDelta + next.inputTextDelta }, growth: jsonLength(next.inputTextDelta) };
  }
  return null;
}

export function createCoalescer(): Coalescer {
  let buf: Draft[] = [];
  let bytes = 0;
  const drain = () => {
    const out = buf;
    buf = [];
    bytes = 0;
    return out;
  };
  return {
    push(chunk, transient = false) {
      if (transient || isUrgentChunk(chunk)) return [...drain(), { chunk, transient }];
      const last = buf.at(-1);
      const merged = last && !last.transient ? merge(last.chunk, chunk) : null;
      if (merged) {
        bytes += merged.growth;
        buf[buf.length - 1] = { chunk: merged.chunk, transient: false };
      } else {
        buf.push({ chunk, transient });
        bytes += chunkBytes(chunk);
      }
      return [];
    },
    drain,
    get bytes() {
      return bytes;
    },
    get size() {
      return buf.length;
    },
  };
}

const URGENT = new Set<string>([
  "start",
  "finish",
  "abort",
  "error",
  "tool-approval-request",
  "tool-approval-response",
  "tool-input-available",
  "tool-input-error",
  "tool-output-available",
  "tool-output-error",
  "tool-output-denied",
]);

/** A `data-*` chunk that isn't part of the message (title, notices): stored with transient=true, never replayed. */
export const isTransientChunk = (chunk: UIMessageChunk) => chunk.type.startsWith("data-") && (chunk as { transient?: boolean }).transient === true;

/** Chunks that must reach the log immediately (the browser acts on them). */
export function isUrgentChunk(chunk: UIMessageChunk): boolean {
  return URGENT.has(chunk.type) || isTransientChunk(chunk);
}
