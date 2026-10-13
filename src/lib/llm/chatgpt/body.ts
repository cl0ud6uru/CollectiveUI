/** Public Responses API request shaping for Sign in with ChatGPT. */

export const FALLBACK_INSTRUCTIONS = "You are a helpful assistant.";

const ALLOWED_KEYS = new Set([
  "model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls",
  "reasoning", "store", "stream", "text",
]);

type Item = Record<string, unknown>;

function typedContent(role: string, content: unknown): unknown {
  if (typeof content !== "string") return content;
  return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
}

function rewriteItem(item: Item): Item | null {
  // Public SIWC requests replay the full local history. Server item references and sealed Codex reasoning are
  // private-backend state and cannot be sent to the public Responses API.
  if (item.type === "item_reference" || item.type === "reasoning") return null;
  const { id: _id, ...rest } = item;
  void _id;
  if (typeof rest.role === "string") {
    const role = rest.role === "system" ? "developer" : rest.role;
    return { ...rest, role, content: typedContent(role, rest.content) };
  }
  return rest;
}

export function rewriteChatGPTRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (ALLOWED_KEYS.has(k) && v !== undefined && v !== null) out[k] = v;

  out.store = false;
  out.stream = true;
  if (typeof out.instructions !== "string" || !out.instructions.trim()) out.instructions = FALLBACK_INSTRUCTIONS;
  out.input = (Array.isArray(out.input) ? (out.input as Item[]) : []).map(rewriteItem).filter((x): x is Item => x !== null);

  // Keep only local functions in the documented namespace shape.
  // Hosted tools and tool_search are unsupported for SIWC, including client-side tool_search.
  const tools = Array.isArray(out.tools) ? (out.tools as Item[]).filter((tool) => tool.type === "function") : [];
  if (tools.length) {
    out.tools = [{ type: "namespace", name: "collectiveui", description: "CollectiveUI local tools", tools }];
  } else {
    delete out.tools;
    delete out.tool_choice;
    delete out.parallel_tool_calls;
  }
  return out;
}
