/** Disposable browser-test worker. Every fetch is intercepted; there is no live provider access. */
import { searchResponse } from "./openai-search";
if (process.env.NATIVE_SEARCH_FIXTURES !== "1" || new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" || new URL(process.env.DATABASE_URL!).pathname !== "/collective_native_search_test") throw new Error("Disposable native-search database required");
let sequence = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url !== "https://api.openai.com/v1/responses") throw new Error(`Fixture worker refused network access: ${new URL(url).origin}`);
  const body = JSON.parse(String(init?.body));
  const id = `browser_${Date.now()}_${sequence++}`;
  if (!body.stream) return Response.json({ id: `resp_${id}`, created_at: 1, model: "gpt-4.1", output: [{ type: "message", id: `msg_${id}`, role: "assistant", content: [{ type: "output_text", text: "Fixture weather", annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 1 } });
  const search = body.tools?.some((t: { type: string }) => t.type === "web_search");
  if (search && (!Number.isInteger(body.max_tool_calls) || body.max_tool_calls < 1)) throw new Error("Fixture requires a hosted tool-call cap");
  const response = searchResponse({ calls: search ? 1 : 0, id });
  const chunks = (await response.text()).split("\n\n").filter(Boolean);
  const slow = JSON.stringify(body.input).toLowerCase().includes("slow");
  let index = 0;
  const stream = new ReadableStream({ async pull(controller) {
    await new Promise(resolve => setTimeout(resolve, slow ? 1200 : 35));
    if (init?.signal?.aborted) { controller.error(new DOMException("Aborted", "AbortError")); return; }
    if (index >= chunks.length) { controller.close(); return; }
    controller.enqueue(new TextEncoder().encode(`${chunks[index++]}\n\n`));
  } });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
};
void import("../../src/worker/index");
