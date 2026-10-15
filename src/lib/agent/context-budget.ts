import type { Instructions, ModelMessage } from "ai";

/** Conservative fallback for models whose context size has not been configured. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_384;
/** Reserved for generation when an app has no explicit maxTokens setting. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 2_048;

export type ContextBudget = {
  inputBudgetTokens: number;
  outputReserveTokens: number;
  contextWindowTokens: number;
};

/**
 * This is deliberately a byte-based safety estimate, not a tokenizer. Text uses one token per UTF-8 byte plus
 * per-message framing, which is conservative for ordinary text but cannot promise provider-exact accounting.
 * Images with known inline bytes receive a large fixed allowance; unknown or remote multimodal data is rejected.
 */
export function estimateModelContextTokens(messages: ModelMessage[], instructions: unknown, tools?: unknown): number {
  let total = estimateText(typeof instructions === "string" ? instructions : stableJson(instructions)) + 512;
  if (tools !== undefined) total += estimateToolDefinitions(tools) + 512;
  for (const message of messages) {
    total += 128;
    if ("providerOptions" in message && message.providerOptions) total += estimateText(stableJson(message.providerOptions));
    if (typeof message.content === "string") {
      total += estimateText(message.content);
      continue;
    }
    for (const part of message.content as unknown[]) total += estimatePart(part);
  }
  return total;
}

/** Drops whole oldest user turns; the latest turn and every tool/approval exchange within a turn stay intact. */
export function compactModelContext(
  messages: ModelMessage[],
  options: { inputBudgetTokens: number; instructions: Instructions | undefined; tools?: unknown; omittedTurnsBefore?: number },
): { messages: ModelMessage[]; omittedTurns: number; notice?: string; instructions: Instructions | undefined; estimatedInputTokens: number } {
  const turns = splitTurns(messages);
  const omittedTurnsBefore = options.omittedTurnsBefore ?? 0;
  const buildPrompt = (omittedTurns: number) => instructionsWithContextNote(
    options.instructions,
    omittedTurns ? formatOmissionNotice(omittedTurns) : undefined,
  );
  if (!turns.length) {
    const instructions = buildPrompt(omittedTurnsBefore);
    const estimatedInputTokens = estimateModelContextTokens([], instructions, options.tools);
    if (estimatedInputTokens > options.inputBudgetTokens) throw new Error("Model instructions and tools exceed this model's configured context budget.");
    return { messages: [], omittedTurns: omittedTurnsBefore, instructions, estimatedInputTokens,
      ...(omittedTurnsBefore ? { notice: formatOmissionNotice(omittedTurnsBefore) } : {}) };
  }
  const retained = turns.slice();
  const omittedTurns = () => omittedTurnsBefore + turns.length - retained.length;
  const cost = () => estimateModelContextTokens(retained.flat(), buildPrompt(omittedTurns()), options.tools);
  while (retained.length > 1 && cost() > options.inputBudgetTokens) retained.shift();
  const estimatedInputTokens = cost();
  if (estimatedInputTokens > options.inputBudgetTokens) {
    throw new Error("The latest turn is too large for this model's configured context budget. Shorten the request or increase the model context window.");
  }
  const totalOmittedTurns = omittedTurns();
  const instructions = buildPrompt(totalOmittedTurns);
  return {
    messages: retained.flat(),
    omittedTurns: totalOmittedTurns,
    instructions,
    estimatedInputTokens,
    ...(totalOmittedTurns ? { notice: formatOmissionNotice(totalOmittedTurns) } : {}),
  };
}

function instructionsWithContextNote(instructions: Instructions | undefined, notice?: string): Instructions | undefined {
  if (!notice) return instructions;
  const note = { role: "system" as const, content: `Context note: ${notice}` };
  if (Array.isArray(instructions)) return [...instructions, note];
  return instructions ? `${instructions}\n\n${note.content}` : note.content;
}

function formatOmissionNotice(omittedTurns: number): string {
  return `${omittedTurns} older conversation ${omittedTurns === 1 ? "turn was" : "turns were"} omitted to fit the configured model context budget. No summary was generated.`;
}

export function resolveContextBudget(contextWindowTokens?: number | null, maxOutputTokens?: number | null): ContextBudget {
  const outputReserve = maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const contextWindow = contextWindowTokens ?? Math.max(DEFAULT_CONTEXT_WINDOW_TOKENS, outputReserve + 1_024);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || !Number.isSafeInteger(outputReserve) || outputReserve < 1 || outputReserve >= contextWindow) {
    throw new Error("The model context window must be larger than its output token reserve.");
  }
  return { contextWindowTokens: contextWindow, outputReserveTokens: outputReserve, inputBudgetTokens: contextWindow - outputReserve };
}

function splitTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" && turns.at(-1)?.length) turns.push([]);
    if (!turns.length) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns;
}

function estimatePart(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("Unknown model content cannot be safely budgeted.");
  const part = value as Record<string, unknown>;
  if (part.type === "text" && typeof part.text === "string") return estimateText(part.text) + estimateMetadata(part) + 8;
  if (part.type === "reasoning" && typeof part.text === "string") return estimateText(part.text) + estimateMetadata(part) + 8;
  if (part.type === "image") {
    const mediaType = typeof part.mediaType === "string" ? part.mediaType : undefined;
    const data = part.image ?? part.data;
    const inline = typeof data === "string" && /^(data:image\/[a-z0-9.+-]+;base64,|[A-Za-z0-9+/]+={0,2}$)/i.test(data);
    const bytes = data instanceof Uint8Array;
    if (!mediaType?.startsWith("image/") || (!inline && !bytes)) throw new Error("Unknown or remote multimodal content cannot be safely budgeted.");
    const byteLength = typeof data === "string" ? data.slice(data.indexOf(",") + 1).length * 3 / 4 : (data as Uint8Array).byteLength;
    if (byteLength > 8 * 1024 * 1024) throw new Error("Inline images larger than 8 MiB cannot be safely budgeted.");
    return 8_192 + Math.ceil(byteLength / (64 * 1024)) * 256 + estimateMetadata(part);
  }
  if (part.type === "file" && typeof part.mediaType === "string") {
    const data = part.data;
    if (typeof data === "string" && data.startsWith("data:")) {
      const byteLength = data.slice(data.indexOf(",") + 1).length * 3 / 4;
      if (part.mediaType.startsWith("image/")) {
        if (byteLength > 8 * 1024 * 1024) throw new Error("Inline images larger than 8 MiB cannot be safely budgeted.");
        return 8_192 + Math.ceil(byteLength / (64 * 1024)) * 256 + estimateMetadata(part);
      }
      return estimateText(data) + estimateMetadata(part);
    }
    if (data instanceof Uint8Array) {
      if (part.mediaType.startsWith("image/")) {
        if (data.byteLength > 8 * 1024 * 1024) throw new Error("Inline images larger than 8 MiB cannot be safely budgeted.");
        return 8_192 + Math.ceil(data.byteLength / (64 * 1024)) * 256 + estimateMetadata(part);
      }
      return data.byteLength + estimateMetadata(part);
    }
    throw new Error("Unknown or remote multimodal content cannot be safely budgeted.");
  }
  if (part.type === "file" && typeof part.data === "string" && part.data.startsWith("data:text/")) return estimateText(part.data) + estimateMetadata(part) + 16;
  // Tool calls/results and approval protocol parts are small JSON structures with potentially large text outputs.
  if (typeof part.type === "string" && (part.type.startsWith("tool-") || part.type === "dynamic-tool")) {
    return estimateText(stableJson(part)) + 32;
  }
  throw new Error("Unknown model content cannot be safely budgeted.");
}

function estimateMetadata(part: Record<string, unknown>): number {
  const metadata = Object.fromEntries(Object.entries(part).filter(([key]) =>
    key !== "type" && key !== "text" && key !== "image" && key !== "data" && key !== "url" && key !== "filename" && key !== "mediaType",
  ));
  return Object.keys(metadata).length ? estimateText(stableJson(metadata)) : 0;
}

function estimateToolDefinitions(tools: unknown): number {
  if (!tools || typeof tools !== "object") return estimateText(stableJson(tools));
  return Object.entries(tools as Record<string, unknown>).reduce((sum, [name, tool]) => sum + 256 + estimateText(name) + estimateText(stableJson(tool)), 0);
}

function estimateText(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function stableJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; }
  catch { throw new Error("Model tool definitions cannot be safely budgeted."); }
}
