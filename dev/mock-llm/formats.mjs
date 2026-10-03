// Request/response adapters so the mock can speak three wire formats with one brain (`decide` in server.mjs):
// - OpenAI Responses API        POST /v1/responses
// - ChatGPT Codex backend       POST /backend-api/codex/responses (same wire format, stricter rules)
// - Anthropic Messages API      POST /v1/messages
// Each adapter turns the request into the Chat Completions shape ({messages, tools, response_format}) and
// writes the decision back in the native streaming format.
import { createHash, randomUUID } from "node:crypto";

const sse = (res) => res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
const tokensOf = (text) => text.match(/\S+\s*|\s+/g) ?? [];
const pause = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

function responsesPartText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p.type === "input_text" || p.type === "output_text" || p.type === "text" ? p.text : p.type === "input_image" ? "[image]" : ""))
    .join("\n");
}

export function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  for (const item of body.input ?? []) {
    if (item.type === "function_call") {
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] });
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    } else if (item.role) {
      const hasImage = Array.isArray(item.content) && item.content.some((p) => p.type === "input_image");
      messages.push({
        role: item.role === "developer" ? "system" : item.role,
        content: hasImage ? [{ type: "text", text: responsesPartText(item.content) }, { type: "image_url" }] : responsesPartText(item.content),
      });
    }
  }
  const format = body.text?.format?.type;
  return {
    messages,
    tools: (body.tools ?? []).filter((t) => t.type === "function").map((t) => ({ type: "function", function: { name: t.name } })),
    response_format: format === "json_schema" || format === "json_object" ? { type: format } : undefined,
  };
}

/** The Codex backend rejects requests the public API accepts. Mirror the rules the portal must follow. */
export function codexBackendViolations(req, body) {
  const v = [];
  if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) v.push("missing bearer token");
  if (!req.headers["chatgpt-account-id"]) v.push("missing ChatGPT-Account-ID header");
  if (body.store !== false) v.push("store must be false");
  if (body.stream !== true) v.push("stream must be true");
  if (typeof body.instructions !== "string" || !body.instructions.trim()) v.push("instructions are required");
  for (const k of ["max_output_tokens", "temperature", "top_p"]) if (k in body) v.push(`unsupported parameter: ${k}`);
  for (const item of body.input ?? []) {
    if (item.type === "item_reference") v.push("item_reference is not supported with store=false");
    if (item.id) v.push("input items must not carry ids with store=false");
    if (item.role && typeof item.content === "string") v.push("message content must be typed parts");
    if (item.role === "system") v.push("use the developer role instead of system");
  }
  return v;
}

export async function writeResponses(res, body, d, usage, delayMs = 0) {
  const id = `resp_${randomUUID()}`;
  const created_at = Math.floor(Date.now() / 1000);
  const model = body.model ?? "mock-gpt";
  const callId = `call_${randomUUID().slice(0, 8)}`;
  const itemId = `${d.toolCall ? "fc" : "msg"}_${randomUUID().slice(0, 8)}`;
  const text = d.text ?? "";
  const doneItem = d.toolCall
    ? { type: "function_call", id: itemId, call_id: callId, name: d.toolCall.name, arguments: d.toolCall.args, status: "completed" }
    : { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const u = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id, object: "response", created_at, model, status: "completed", output: [doneItem], usage: u }));
  }
  sse(res);
  let seq = 0;
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  ev("response.created", { response: { id, created_at, model, status: "in_progress" } });
  if (d.toolCall) {
    ev("response.output_item.added", { output_index: 0, item: { ...doneItem, arguments: "", status: "in_progress" } });
    ev("response.function_call_arguments.delta", { item_id: itemId, output_index: 0, delta: d.toolCall.args });
    ev("response.function_call_arguments.done", { item_id: itemId, output_index: 0, arguments: d.toolCall.args });
  } else {
    ev("response.output_item.added", { output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
    for (const t of tokensOf(text)) {
      if (res.destroyed) return;
      ev("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: t });
      await pause(delayMs);
    }
  }
  ev("response.output_item.done", { output_index: 0, item: doneItem });
  ev("response.completed", { response: { id, created_at, model, status: "completed", usage: u } });
  res.end();
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n");
}

export function anthropicToChat(body) {
  const messages = [];
  const system = typeof body.system === "string" ? body.system : anthropicText(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const m of body.messages ?? []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const results = blocks.filter((b) => b.type === "tool_result");
    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: typeof r.content === "string" ? r.content : anthropicText(r.content) });
    }
    const text = anthropicText(blocks.filter((b) => b.type !== "tool_result"));
    if (toolUses.length) {
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } })),
      });
    } else if (text || !results.length) {
      const hasImage = blocks.some((b) => b.type === "image");
      messages.push({ role: m.role, content: hasImage ? [{ type: "text", text }, { type: "image_url" }] : text });
    }
  }
  // Structured output: a forced tool ("json" tool) → answer with the object as that tool's input; native
  // structured output (output_config.format / output_format) → answer with JSON text.
  const forced = body.tool_choice?.type === "tool" ? body.tool_choice.name : undefined;
  const nativeJson = body.output_config?.format?.type === "json_schema" || body.output_format?.type === "json_schema";
  return {
    messages,
    tools: (body.tools ?? []).map((t) => ({ type: "function", function: { name: t.name } })),
    response_format: forced || nativeJson ? { type: "json_schema" } : undefined,
    forcedTool: forced,
  };
}

// Prompt caching: system blocks marked with cache_control are "written" the first time a prefix is seen and
// "read" afterwards, so tests can check cache accounting end to end.
const seenPrefixes = new Set();
function cacheUsage(body, promptTokens) {
  const blocks = Array.isArray(body.system) ? body.system : [];
  const cut = blocks.findLastIndex((b) => b.cache_control);
  if (cut < 0) return { input_tokens: promptTokens };
  const prefix = JSON.stringify([body.model, blocks.slice(0, cut + 1).map((b) => b.text)]);
  const cached = Math.max(1, Math.ceil(prefix.length / 4));
  const key = createHash("sha256").update(prefix).digest("hex");
  const hit = seenPrefixes.has(key);
  seenPrefixes.add(key);
  return {
    input_tokens: Math.max(1, promptTokens - cached),
    ...(hit ? { cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } : { cache_creation_input_tokens: cached, cache_read_input_tokens: 0 }),
  };
}

export async function writeAnthropic(res, body, d, usage, forcedTool, delayMs = 0) {
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const inputUsage = cacheUsage(body, usage.prompt_tokens);
  const model = body.model ?? "mock-claude";
  // Structured output through a forced tool: the JSON text becomes that tool's input.
  if (forcedTool && d.text) d = { toolCall: { name: forcedTool, args: d.text } };
  const toolId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const content = d.toolCall
    ? [{ type: "tool_use", id: toolId, name: d.toolCall.name, input: JSON.parse(d.toolCall.args || "{}") }]
    : [{ type: "text", text: d.text ?? "" }];
  const stop_reason = d.toolCall ? "tool_use" : "end_turn";

  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ id, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage: { ...inputUsage, output_tokens: usage.completion_tokens } }),
    );
  }
  sse(res);
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...inputUsage, output_tokens: 0 } } });
  ev("ping", {});
  if (d.toolCall) {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: toolId, name: d.toolCall.name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: d.toolCall.args || "{}" } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const t of tokensOf(d.text ?? "")) {
      if (res.destroyed) return;
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } });
      await pause(delayMs);
    }
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.completion_tokens } });
  ev("message_stop", {});
  res.end();
}
