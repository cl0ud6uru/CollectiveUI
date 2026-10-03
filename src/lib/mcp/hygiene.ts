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

/**
 * Cleans a tools/call result and caps it at the server's budget (characters, roughly bytes of text), so one
 * chatty tool can't flood the model's context or the stored conversation. Text is cut with a note saying so;
 * images or audio that don't fit are replaced by a note. structuredContent is dropped when content exists (the
 * model reads content) or when it doesn't fit.
 */
export function capResult(result: McpCallResult, budgetChars: number): McpCallResult {
  if (!Array.isArray(result.content)) {
    const raw = stripHidden(JSON.stringify(result) ?? "");
    if (raw.length <= budgetChars) return JSON.parse(raw) as McpCallResult;
    return { content: [note(`${raw.slice(0, budgetChars)}\n[Truncated: the result was ${kb(raw.length)}, the limit is ${kb(budgetChars)}.]`)] };
  }

  let left = budgetChars;
  const out: ContentPart[] = [];
  const parts = result.content;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "text" && typeof part.text === "string") {
      const text = stripHidden(part.text);
      if (text.length <= left) {
        out.push({ ...part, text });
        left -= text.length;
        continue;
      }
      out.push({ ...part, text: text.slice(0, Math.max(0, left)) });
      const rest = parts.length - i - 1;
      out.push(note(`[Truncated: the result was longer than ${kb(budgetChars)}${rest ? `; ${rest} more part(s) omitted` : ""}.]`));
      left = 0;
      break;
    }
    if ((part.type === "image" || part.type === "audio") && typeof part.data === "string") {
      if (part.data.length <= left) {
        out.push(part);
        left -= part.data.length;
      } else out.push(note(`[${part.type === "image" ? "Image" : "Audio"} omitted: ${kb(part.data.length)} is over the ${kb(budgetChars)} limit.]`));
      continue;
    }
    // Resources, links and anything newer: pass as text (what the SDK does too).
    const text = stripHidden(JSON.stringify(part));
    if (text.length <= left) {
      out.push(note(text));
      left -= text.length;
    } else {
      out.push(note(`[A ${part.type} part was omitted: over the ${kb(budgetChars)} limit.]`));
    }
  }
  const capped: McpCallResult = { content: out };
  if (result.isError) capped.isError = true;
  if (!out.length && result.structuredContent !== undefined) {
    const structured = stripHidden(JSON.stringify(result.structuredContent) ?? "");
    if (structured.length <= budgetChars) capped.structuredContent = JSON.parse(structured);
    else capped.content = [note(`${structured.slice(0, budgetChars)}\n[Truncated: over the ${kb(budgetChars)} limit.]`)];
  }
  return capped;
}

function kb(chars: number) {
  return chars < 1024 ? `${chars} characters` : `${Math.round(chars / 1024)} KB`;
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
