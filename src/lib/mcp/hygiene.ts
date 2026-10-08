import type { Tool } from "ai";

/**
 * Characters that hide text from the people reviewing a tool while the model still reads it: Unicode tag
 * characters (ASCII smuggling), variation selectors 17-256 (byte smuggling), bidi embeddings/overrides/isolates
 * and zero-width spaces. ZWJ/ZWNJ and ordinary variation selectors stay (emoji and some scripts need them).
 */
const HIDDEN = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}‪-‮⁦-⁩​⁠-⁤﻿᠎]/gu;

export function stripHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

/** Longest tool description passed to the model; the rest is dropped. */
export const MAX_DESCRIPTION_CHARS = 2000;

export function cleanDescription(text: string | undefined): string | undefined {
  if (!text) return text;
  const clean = stripHidden(text).trim();
  return clean.length > MAX_DESCRIPTION_CHARS ? `${clean.slice(0, MAX_DESCRIPTION_CHARS)}…` : clean;
}

type ContentPart = { type: string; [k: string]: unknown };
export type McpCallResult = { content?: ContentPart[]; structuredContent?: unknown; isError?: boolean; [k: string]: unknown };

const note = (text: string): ContentPart => ({ type: "text", text });

/** Hard limit on returned parts, including the single omission/truncation note. */
export const MAX_RESULT_PARTS = 64;

/**
 * Budget is UTF-8 bytes of JSON.stringify(returned result), including the envelope and notes.
 * Only model-facing content fields, structuredContent and the boolean isError flag survive.
 * Stops at the first omission; never emits one uncharged note per rejected part.
 * Budgets smaller than the empty result envelope (or non-finite budgets) are rejected.
 * This is a post-parse bound, not a transport/memory allocation limit.
 */
export function capResult(result: McpCallResult, budgetBytes: number): McpCallResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) result = {};
  const capped: McpCallResult = { content: [] };
  if (typeof result.isError === "boolean") capped.isError = result.isError;
  const bytes = () => Buffer.byteLength(JSON.stringify(capped), "utf8");
  if (!Number.isFinite(budgetBytes) || Math.floor(budgetBytes) < bytes())
    throw new RangeError("MCP result budget cannot fit the empty result envelope.");
  const budget = Math.floor(budgetBytes);
  const out = capped.content!;
  const add = (part: ContentPart) => {
    if (out.length >= MAX_RESULT_PARTS) return false;
    out.push(part);
    if (bytes() <= budget) return true;
    out.pop();
    return false;
  };
  const truncate = (text?: string, message = "[Truncated.]") => {
    // Charge the note first; then spend the remaining space on a text prefix.
    const hasNote = add(note(message));
    if (text !== undefined && out.length < MAX_RESULT_PARTS) {
      const part = note("");
      if (hasNote) out.splice(out.length - 1, 0, part);
      else out.push(part);
      if (bytes() > budget) { out.splice(out.indexOf(part), 1); return; }
      let low = 0, high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        part.text = text.slice(0, mid);
        if (bytes() <= budget) low = mid;
        else high = mid - 1;
      }
      // Do not split an astral character at the byte boundary.
      if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
      part.text = text.slice(0, low);
    }
  };
  const parts = Array.isArray(result.content) ? result.content : [];
  if (!parts.length) {
    if (result.structuredContent !== undefined) {
      const raw = stripHidden(JSON.stringify(result.structuredContent) ?? "null");
      capped.structuredContent = JSON.parse(raw);
      if (bytes() > budget) {
        delete capped.structuredContent;
        truncate(raw);
      }
    } else if (!Array.isArray(result.content)) truncate();
    return capped;
  }
  for (const part of parts) {
    // Reserve one part slot for the final omission note.
    if (out.length >= MAX_RESULT_PARTS - 1) { truncate(); break; }
    if (!part || typeof part !== "object") { truncate(); break; }
    if (part.type === "text" && typeof part.text === "string") {
      const text = stripHidden(part.text);
      if (!add(note(text))) { truncate(text); break; }
    } else if ((part.type === "image" || part.type === "audio") &&
      typeof part.data === "string" && typeof part.mimeType === "string") {
      if (!add({ type: part.type, data: stripHidden(part.data), mimeType: stripHidden(part.mimeType) })) {
        truncate(undefined, `[${part.type === "image" ? "Image" : "Audio"} omitted: over the result budget.]`);
        break;
      }
    } else if (part.type === "resource_link" || part.type === "resource") {
      const clean: ContentPart = { type: part.type };
      const fields = (source: Record<string, unknown>, keys: string[]) => {
        const value: Record<string, unknown> = {};
        for (const key of keys) {
          if (typeof source[key] === "string") value[key] = stripHidden(source[key]);
        }
        return value;
      };
      if (part.type === "resource_link") Object.assign(clean, fields(part, ["uri", "name", "title", "description", "mimeType"]));
      else if (part.resource && typeof part.resource === "object" && !Array.isArray(part.resource))
        clean.resource = fields(part.resource as Record<string, unknown>, ["uri", "mimeType", "text", "blob"]);
      else { truncate(); break; }
      const text = JSON.stringify(clean);
      if (!add(note(text))) { truncate(text); break; }
    } else {
      truncate(undefined, "[Truncated: unsupported content part omitted.]");
      break;
    }
  }
  return capped;
}

type ModelOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;

/** What the model sees for a (capped) result: the same mapping as @ai-sdk/mcp's own tools. */
export function mcpResultToModelOutput({ output }: { output: unknown }): ModelOutput {
  const result = output as McpCallResult;
  if (!result || !Array.isArray(result.content)) return { type: "json", value: (result ?? null) as never };
  if (!result.content.length && result.structuredContent !== undefined) return { type: "json", value: result.structuredContent as never };
  return {
    type: "content",
    value: result.content.map((part) => {
      if (part.type === "text" && typeof part.text === "string") return { type: "text" as const, text: part.text };
      if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
        return { type: "file" as const, mediaType: part.mimeType, data: { type: "data" as const, data: part.data } };
      return { type: "text" as const, text: JSON.stringify(part) };
    }),
  };
}
