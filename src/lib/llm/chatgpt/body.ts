/**
 * Request-body rules of the ChatGPT Codex backend (verified against Codex CLI, Hermes, pi and OpenCode). Pure, so it
 * is unit-tested directly; the model fetch applies it to every POST /responses.
 *
 *  - only fields Codex itself sends; no max_output_tokens / temperature / top_p / metadata / user;
 *  - store:false and stream:true always; non-empty instructions; encrypted reasoning included;
 *  - with store:false, no item ids and no item_reference;
 *  - message content as typed parts, developer instead of system;
 *  - function tools default to strict:false (Codex parity; MCP schemas often aren't strict-compatible).
 */

export const FALLBACK_INSTRUCTIONS = "You are a helpful assistant.";

const ALLOWED_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
]);

type Item = Record<string, unknown>;

function typedContent(role: string, content: unknown): unknown {
  if (typeof content !== "string") return content;
  return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
}

function rewriteItem(item: Item): Item | null {
  if (item.type === "item_reference") return null;
  const { id: _id, ...rest } = item;
  void _id;
  if (rest.type === "reasoning" && !rest.encrypted_content) return null; // nothing to replay without the blob
  if (typeof rest.role === "string") {
    const role = rest.role === "system" ? "developer" : rest.role;
    return { ...rest, role, content: typedContent(role, rest.content) };
  }
  return rest;
}

export function rewriteCodexRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (ALLOWED_KEYS.has(k) && v !== undefined && v !== null) out[k] = v;

  out.store = false;
  out.stream = true;
  if (typeof out.instructions !== "string" || !out.instructions.trim()) out.instructions = FALLBACK_INSTRUCTIONS;

  const include = Array.isArray(out.include) ? (out.include as unknown[]).filter((x) => typeof x === "string") : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  out.include = include;

  out.input = (Array.isArray(out.input) ? (out.input as Item[]) : []).map(rewriteItem).filter((x): x is Item => x !== null);

  const tools = Array.isArray(out.tools) ? (out.tools as Item[]) : [];
  if (tools.length) {
    out.tools = tools.map((t) => (t.type === "function" && t.strict === undefined ? { ...t, strict: false } : t));
  } else {
    delete out.tools;
    delete out.tool_choice;
    delete out.parallel_tool_calls;
  }
  return out;
}
