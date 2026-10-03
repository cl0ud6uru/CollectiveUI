// A tiny multi-format LLM mock for local development and tests.
// - GET  /v1/models
// - POST /v1/chat/completions             (OpenAI-compatible; streaming + non-streaming, tool calls, JSON-schema output)
// - POST /v1/responses                    (OpenAI Responses API)
// - POST /v1/messages                     (Anthropic Messages API; also /anthropic/v1/messages)
// - POST /backend-api/codex/responses     (ChatGPT Codex backend: rejects requests that break its rules)
// - GET  /backend-api/codex/models, /backend-api/wham/usage   (Codex routes need a token from the mock sign-in)
// - OpenAI sign-in (device code, token, revoke) for "Sign in with ChatGPT": see chatgpt-auth.mjs
// - /openai/v1/* aliases for Azure OpenAI v1 paths
// Anthropic system blocks with cache_control report cache writes, then cache reads for the same prefix.
// - POST /v1/embeddings                   (deterministic hash embeddings)
//
// Add `[slow]` to a user message to stream it slowly (for reload/stop tests). On the Codex backend, `[limit]`
// answers 429 usage_limit_reached like a ChatGPT plan that ran out.
//
// Scripted tool calls: include `[tool:NAME {"arg":"value"}]` in a user message and the mock will call that
// tool (if offered). After the tool result arrives it summarises the result.
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { handleChatGPTAuth, validChatGPTToken } from "./chatgpt-auth.mjs";
import { anthropicToChat, codexBackendViolations, responsesToChat, writeAnthropic, writeResponses } from "./formats.mjs";

const PORT = Number(process.env.PORT ?? 4010);
const MODELS = ["mock-gpt", "mock-vision", "mock-embed"];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : p.type === "image_url" ? "[image]" : "")).join("\n");
  return "";
}

function embedding(text, dim = 64) {
  const v = new Array(dim).fill(0);
  for (const word of String(text).toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = createHash("sha256").update(word).digest();
    for (let i = 0; i < dim; i++) v[i] += (h[i % h.length] / 255 - 0.5);
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

const DEMO = `Here's a quick demo of what I can render:

## Markdown
- **Bold**, *italic*, \`inline code\`
- [A link](https://example.com)

| Feature | Supported |
|---|---|
| Tables | ✅ |
| Code | ✅ |

\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`

And some math: $$E = mc^2$$`;

/**
 * A deterministic bot draft whose starters are user requests. "[draft:malformed]" in the description returns
 * truncated JSON, so the error path can be exercised end to end.
 */
function botDraft(description, body) {
  if (/\[draft:malformed\]/.test(description)) return '{"name":"Half a bot","starters":["Help me';
  const topic = description.replace(/\[[^\]]*\]/g, "").replace(/\(The creator's name is[^)]*\)/, "").trim().split(/\s+/).slice(0, 4).join(" ") || "Helper";
  const offered = body.response_format?.json_schema?.schema?.properties?.tools?.items?.enum ?? [];
  return JSON.stringify({
    name: `${topic.charAt(0).toUpperCase()}${topic.slice(1)} bot`,
    label: "Draft helper",
    description: `Helps with: ${topic}.`,
    instructions: "- Ask clarifying questions when the request is ambiguous.\n- Keep answers short.",
    boundaries: "Never share confidential data outside the company.",
    starters: ["Help me draft an email.", "Summarize this and list the action items."],
    tools: offered.slice(0, 1),
  });
}

function decide(body) {
  const messages = body.messages ?? [];
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const last = messages[messages.length - 1];
  const tools = (body.tools ?? []).map((t) => t.function?.name);

  // Structured output. "Draft my bot" is recognised by its schema (or, for adapters that drop it, its instructions).
  const structured = body.response_format?.type === "json_schema" || body.response_format?.type === "json_object";
  const schemaKeys = Object.keys(body.response_format?.json_schema?.schema?.properties ?? {});
  if (structured && (schemaKeys.includes("starters") || /You design AI teammates/.test(system))) return { text: botDraft(textOf(last?.content), body) };
  if (structured) {
    const convo = messages.map((m) => textOf(m.content)).join("\n");
    const facts = [...convo.matchAll(/remember that ([^.\n]+)/gi)].map((m) => ({ content: m[1].trim(), shared: true }));
    return { text: JSON.stringify({ memories: facts }) };
  }
  if (/Write a short title/i.test(system)) {
    const words = textOf(last?.content).replace(/\[tool:[^\]]+\]/g, "").trim().split(/\s+/).slice(0, 5).join(" ");
    return { text: words ? words.charAt(0).toUpperCase() + words.slice(1) : "New chat" };
  }
  if (last?.role === "tool") {
    // Several "[tool:…]" markers in the user's message run one after another (multi-step replies).
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    const markers = [...textOf(messages[lastUser]?.content).matchAll(/\[tool:([\w-]+)\s*(\{[\s\S]*?\})?\]/g)].filter((x) => tools.includes(x[1]));
    const called = messages.slice(lastUser + 1).reduce((count, m) => count + (m.tool_calls?.length ?? 0), 0);
    if (called < markers.length) return { toolCall: { name: markers[called][1], args: markers[called][2] ?? "{}" } };
    const name = messages.slice().reverse().find((m) => m.tool_calls)?.tool_calls?.find((c) => c.id === last.tool_call_id)?.function?.name;
    const content = textOf(last.content);
    return { text: `The \`${name ?? "tool"}\` tool returned:\n\n\`\`\`json\n${content.slice(0, 1500)}\n\`\`\`\n\nLet me know if you need anything else.` };
  }
  const userText = textOf(last?.content);
  // OpenAI-compatible browser fixture for concurrent tool calls in one model step.
  if (userText.includes("[parallel]")) {
    const markers = [...userText.matchAll(/\[tool:([\w-]+)\s*(\{[\s\S]*?\})?\]/g)].filter(m => tools.includes(m[1]));
    if (markers.length) return { toolCalls: markers.map(m => ({ name: m[1], args: m[2] ?? "{}" })) };
  }
  const m = /\[tool:([\w-]+)\s*(\{[\s\S]*?\})?\]/.exec(userText);
  if (m && tools.includes(m[1])) {
    return { toolCall: { name: m[1], args: m[2] ?? "{}" } };
  }
  if (/\bdelegate\b/i.test(userText)) {
    const ask = tools.find((t) => t?.startsWith("ask_"));
    if (ask) return { toolCall: { name: ask, args: JSON.stringify({ task: userText.replace(/\bdelegate\b/i, "").replace(/\[async\]/, "").trim(), ...(/\[async\]/.test(userText) ? { mode: "async" } : {}) }) } };
  }
  // Delegation continuation fixture: expose exactly the model-visible ordered history.
  if (userText.includes("[history]")) return { text: `History: ${messages.filter(m => ["user", "assistant"].includes(m.role)).map(m => `${m.role}: ${textOf(m.content)}`).join(" | ")}` };
  if (/\bdemo\b/i.test(userText)) return { text: DEMO };
  // Group chats: "[handoff:Name]" makes the addressed bot hand the work to Name with an @mention.
  const handoff = /\[handoff:([^\]]+)\]/.exec(userText);
  if (handoff && /## Group chat/.test(system) && !system.includes(`You are "${handoff[1]}"`)) {
    return { text: `On it — handing the details to @${handoff[1]}.` };
  }
  const images = Array.isArray(last?.content) && last.content.some((p) => p.type === "image_url");
  const fileMatch = /<file name="([^"]+)">/.exec(userText);
  let reply = `You said: "${userText.replace(/<file[\s\S]*?<\/file>/g, "").trim().slice(0, 300)}"`;
  if (fileMatch) reply += `\n\nI can see the attached file **${fileMatch[1]}** (${userText.length} characters).`;
  if (images) reply += "\n\nI can see the image you attached.";
  if (/Your job/.test(system)) reply += `\n\n_(Running as a bot with ${tools.length} tools available.)_`;
  const mem = /What you remember about the user\n([\s\S]*?)\nUse this context/.exec(system);
  if (mem) reply += `\n\nI remember: ${mem[1].trim().split("\n").length} thing(s) about you.`;
  return { text: reply };
}

function usage(body, out) {
  const prompt = JSON.stringify(body.messages ?? []).length / 4;
  return { prompt_tokens: Math.ceil(prompt), completion_tokens: Math.ceil(out.length / 4), total_tokens: Math.ceil(prompt + out.length / 4) };
}

const isSlow = (body) => body.messages?.at(-1)?.role === "user" && /\[slow\]/.test(textOf(body.messages.at(-1).content));
const delayFor = (body) => (isSlow(body) ? 400 : Number(process.env.MOCK_DELAY_MS ?? 15));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Azure OpenAI v1 paths (https://<resource>.openai.azure.com/openai/v1/...) map onto the plain OpenAI routes.
  if (url.pathname.startsWith("/openai/v1/")) url.pathname = url.pathname.slice("/openai".length);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return send(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "mock" })) });
  }
  if (url.pathname.startsWith("/backend-api/") && !validChatGPTToken(req)) return send(res, 401, { detail: "Unauthorized" });
  if (req.method === "GET" && url.pathname === "/codex/device") return handleChatGPTAuth(req, res, url, "");
  if (req.method === "GET" && url.pathname === "/backend-api/codex/models") {
    return send(res, 200, { models: [{ slug: "mock-codex", display_name: "Mock Codex", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] }] });
  }
  if (req.method === "GET" && url.pathname === "/backend-api/wham/usage") {
    return send(res, 200, { plan_type: "enterprise", rate_limit: { primary_window: { used_percent: 12, reset_after_seconds: 3600 } } });
  }
  if (req.method !== "POST") return send(res, 404, { error: "not found" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (handleChatGPTAuth(req, res, url, raw)) return;
  const body = raw ? JSON.parse(raw) : {};

  if (url.pathname === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return send(res, 200, {
      object: "list",
      data: inputs.map((t, i) => ({ object: "embedding", index: i, embedding: embedding(t) })),
      model: body.model,
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  if (url.pathname === "/v1/responses" || url.pathname === "/backend-api/codex/responses") {
    if (url.pathname.startsWith("/backend-api/")) {
      const violations = codexBackendViolations(req, body);
      if (violations.length) return send(res, 400, { detail: violations.join("; ") });
      if (/\[limit\]/.test(JSON.stringify(body.input?.at(-1) ?? ""))) {
        return send(res, 429, { error: { type: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1000) + 3600 } });
      }
      res.setHeader("x-codex-primary-used-percent", "12.5");
      res.setHeader("x-codex-primary-window-minutes", "300");
      res.setHeader("x-codex-primary-reset-at", String(Math.floor(Date.now() / 1000) + 3600));
      res.setHeader("x-codex-secondary-used-percent", "3");
      res.setHeader("x-codex-secondary-window-minutes", "10080");
      res.setHeader("x-codex-turn-state", "mock-turn-state");
    }
    const chat = responsesToChat(body);
    const d = decide(chat);
    return writeResponses(res, body, d, usage(chat, d.text ?? d.toolCall?.args ?? ""), delayFor(chat));
  }
  if (url.pathname === "/v1/messages" || url.pathname === "/anthropic/v1/messages") {
    const chat = anthropicToChat(body);
    const d = decide(chat);
    return writeAnthropic(res, body, d, usage(chat, d.text ?? d.toolCall?.args ?? ""), chat.forcedTool, delayFor(chat));
  }
  if (url.pathname !== "/v1/chat/completions") return send(res, 404, { error: "not found" });
  if (/\[draft:reject\]/.test(textOf(body.messages?.at(-1)?.content)) ||
      (/\[task-error\]/.test(textOf(body.messages?.at(-1)?.content)) && body.messages?.some(m => m.role === "system" && /## Delegated task/.test(textOf(m.content))))) {
    return send(res, 400, { error: { message: "Mock provider rejected the request (secret detail sk-mock-provider-detail)", type: "invalid_request_error" } });
  }

  const d = decide(body);
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? "mock-gpt";
  const calls = d.toolCalls ?? (d.toolCall ? [d.toolCall] : []);

  if (!body.stream) {
    const message = calls.length
      ? { role: "assistant", content: null, tool_calls: calls.map(call => ({ id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: call.name, arguments: call.args } })) }
      : { role: "assistant", content: d.text };
    return send(res, 200, {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
      usage: usage(body, d.text ?? ""),
    });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);

  chunk({ role: "assistant", content: "" });
  if (calls.length) {
    for (const [index, call] of calls.entries()) {
      chunk({ tool_calls: [{ index, id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: call.name, arguments: "" } }] });
      chunk({ tool_calls: [{ index, function: { arguments: call.args } }] });
    }
    chunk({}, "tool_calls");
  } else {
    // Keep the first concurrent browser-fixture task observable regardless of admission order.
    if (body.messages?.at(-1)?.role === "user" && /\[hold\]/.test(textOf(body.messages.at(-1).content)))
      await new Promise(resolve => setTimeout(resolve, 8000));
    const tokens = d.text.match(/\S+\s*|\s+/g) ?? [];
    const delay = delayFor(body);
    for (const t of tokens) {
      if (res.destroyed) return;
      chunk({ content: t });
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    chunk({}, "stop");
  }
  if (body.stream_options?.include_usage) {
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usage(body, d.text ?? "") })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, () => console.log(`mock-llm listening on http://localhost:${PORT}/v1`));
