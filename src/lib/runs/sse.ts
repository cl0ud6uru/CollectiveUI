import { UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from "ai";
import { runConfig } from "./types";

const encoder = new TextEncoder();
const KEEPALIVE = encoder.encode(": keepalive\n\n");
const DONE = encoder.encode("data: [DONE]\n\n");

/**
 * The UI message stream as an SSE Response: same framing as the SDK's JsonToSseTransformStream (`data: <json>\n\n`,
 * `data: [DONE]\n\n` at the end), a `: keepalive` comment every runConfig().keepaliveMs, UI_MESSAGE_STREAM_HEADERS.
 * Cancelling the response cancels `stream` (a tail: unsubscribes only).
 */
export function sseResponse(stream: ReadableStream<UIMessageChunk>, init?: ResponseInit): Response {
  const reader = stream.getReader();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const stop = () => {
    open = false;
    if (keepalive) clearInterval(keepalive);
    keepalive = undefined;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Proxies and browsers drop idle connections: a comment line keeps a waiting tail (tool call, queue) alive.
      keepalive = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(KEEPALIVE);
        } catch {
          stop();
        }
      }, runConfig().keepaliveMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!open) return;
        if (done) {
          stop();
          controller.enqueue(DONE);
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (err) {
        if (!open) return;
        stop();
        controller.error(err);
      }
    },
    async cancel(reason) {
      stop();
      await reader.cancel(reason).catch(() => {});
    },
  });

  // Like the SDK's createUIMessageStreamResponse: the caller's headers win, the stream headers fill in the rest.
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}
