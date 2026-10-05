export async function probe(c, model, options = {}) {
  active(c);
  if (!model) throw Error("Specify --model from models");
  return request(
    `${options.apiBase ?? RESOURCE}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.access_token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        instructions: "Reply with exactly CHATGPT_PLAN_OK and nothing else.",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Reply CHATGPT_PLAN_OK" }],
          },
        ],
      }),
    },
    {
      ...options,
      consume: async (r) => {
        if (!r.headers.get("content-type")?.includes("text/event-stream"))
          throw Error("Expected SSE");
        let line = "",
          data = [],
          bytes = 0,
          terminal = false,
          result;
        const decoder = new TextDecoder();
        function dispatch() {
          if (!data.length) return;
          const raw = data.join("\n");
          data = [];
          if (raw === "[DONE]") return;
          const e = JSON.parse(raw);
          if (e.type === "response.failed" || e.type === "response.incomplete")
            throw Error("Response failed");
          if (e.type === "response.completed") {
            if (terminal || e.response?.status !== "completed")
              throw Error("Invalid completion");
            terminal = true;
            result = (e.response.output ?? [])
              .filter((x) => x.type === "message")
              .flatMap((x) => x.content ?? [])
              .filter((x) => x.type === "output_text")
              .map((x) => x.text)
              .join("");
            if (result !== "CHATGPT_PLAN_OK") throw Error("Marker mismatch");
          }
        }
        function parse(text) {
          for (const char of text) {
            if (char === "\n") {
              const l = line.endsWith("\r") ? line.slice(0, -1) : line;
              line = "";
              if (l === "") dispatch();
              else if (l.startsWith("data:"))
                data.push(l.slice(5).replace(/^ /, ""));
            } else line += char;
          }
        }
        for await (const chunk of r.body) {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? 1024 * 1024))
            throw Error("Body too large");
          parse(decoder.decode(chunk, { stream: true }));
        }
        parse(decoder.decode());
        if (line || data.length) throw Error("Truncated SSE event");
        if (!terminal) throw Error("Stream ended without completion");
        return result;
      },
    },
  );
}
export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export function active(c) {
  if (!c?.access_token || !c.scopes?.includes("chatgpt.tokens.use.direct"))
    throw Error("ChatGPT plan permission required; run auth");
  if (!Number.isFinite(c.expires_at) || c.expires_at <= Date.now())
    throw Error("Credentials expired; refresh is not implemented; run auth");
}
export async function request(url, init = {}, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30000,
  );
  try {
    const response = await (options.fetch ?? fetch)(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Upstream HTTP ${response.status}`);
    }
    return await options.consume(response);
  } catch (e) {
    if (e.message?.startsWith("Upstream HTTP")) throw e;
    throw Error("Upstream request or response validation failed");
  } finally {
    clearTimeout(timer);
  }
}
export async function boundedText(response, maxBytes = 1024 * 1024) {
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw Error("Body too large");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
export function jsonRequest(url, init = {}, options = {}) {
  return request(url, init, {
    ...options,
    consume: async (r) => JSON.parse(await boundedText(r, options.maxBytes)),
  });
}
export async function discovery(options = {}) {
  const d = await jsonRequest(
    `${options.issuerBase ?? ISSUER}/.well-known/openid-configuration`,
    {},
    options,
  );
  if (d.issuer !== ISSUER || typeof d.jwks_uri !== "string")
    throw Error("Unexpected discovery metadata");
  return d;
}
export async function models(c, options = {}) {
  active(c);
  const data = await jsonRequest(
    `${options.apiBase ?? RESOURCE}/models`,
    { headers: { Authorization: `Bearer ${c.access_token}` } },
    options,
  );
  if (!Array.isArray(data.models))
    throw Error("Expected account-visible models array");
  return data.models
    .filter((m) => m.visibility === "list" && typeof m.slug === "string")
    .map((m) => ({ slug: m.slug, display_name: m.display_name ?? m.slug }));
}
