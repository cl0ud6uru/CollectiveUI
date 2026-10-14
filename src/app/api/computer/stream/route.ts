import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { computerViewForConversation } from "@/lib/computer/access";
import { queryConversationId } from "@/lib/computer/http";
import { computerFrameForView, computerStatusForView, MAX_COMPUTER_STREAM_MS, reserveComputerSubscriber } from "@/lib/computer/viewer";

const encoder = new TextEncoder();
const event = (name: string, value: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
const keepalive = encoder.encode(": keepalive\n\n");

/** Authenticated owner stream; it reads the persistent personal computer and never starts a Codex run. */
export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal();
    const view = await computerViewForConversation(principal, queryConversationId(request));
    const release = reserveComputerSubscriber(principal.user.id);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) abort.abort();

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let duration: ReturnType<typeof setTimeout> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (reason?: "reconnect", discard = false) => {
      if (ended) return;
      ended = true;
      if (duration) clearTimeout(duration);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      request.signal.removeEventListener("abort", onAbort);
      release();
      if (discard) {
        try { controller?.error(new Error("Computer view ended.")); } catch { /* Already cancelled. */ }
      } else {
        try {
          if (reason && controller?.desiredSize !== null && controller?.desiredSize !== undefined && controller.desiredSize > 0)
            controller.enqueue(event(reason, {}));
          controller?.close();
        } catch { /* Viewer disconnected. */ }
      }
    };
    const revoke = () => { abort.abort(); finish(undefined, true); };
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        duration = setTimeout(() => { abort.abort(); finish("reconnect"); }, MAX_COMPUTER_STREAM_MS);
        keepaliveTimer = setInterval(() => {
          if (ended) return;
          try { if (controller?.desiredSize !== null && controller?.desiredSize !== undefined && controller.desiredSize > 0) controller.enqueue(keepalive); }
          catch { abort.abort(); finish(); }
        }, 10_000);
        void (async () => {
          let lastSequence = 0;
          try {
            while (!ended && !abort.signal.aborted) {
              await view.authorize();
              const status = await computerStatusForView(view, abort.signal);
              if (ended || abort.signal.aborted) return;
              if (controller?.desiredSize !== null && controller?.desiredSize !== undefined && controller.desiredSize > 0)
                controller.enqueue(event("status", status));
              if (status.available && status.state === "running") {
                const frame = await computerFrameForView(view, abort.signal).catch(error => {
                  if (error instanceof HttpError && error.status === 409) return null;
                  throw error;
                });
                if (ended || abort.signal.aborted) return;
                // Recheck after fetching the private bytes and immediately before making them drainable.
                await view.authorize();
                if (frame && frame.sequence > lastSequence && controller?.desiredSize !== null &&
                    controller?.desiredSize !== undefined && controller.desiredSize > 0) {
                  lastSequence = frame.sequence;
                  controller.enqueue(event("frame", { sequence: frame.sequence, capturedAt: frame.capturedAt,
                    contentType: "image/jpeg", width: frame.width, height: frame.height,
                    data: Buffer.from(frame.bytes).toString("base64") }));
                }
              }
              await new Promise<void>(resolve => {
                const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
                const timer = setTimeout(done, 1000);
                abort.signal.addEventListener("abort", done, { once: true });
                if (abort.signal.aborted) done();
              });
            }
            finish();
          } catch {
            // error() clears the stream queue, so a frame already queued cannot drain after revocation.
            revoke();
          }
        })();
      },
      cancel() { abort.abort(); finish(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", Vary: "Cookie",
    } });
  } catch (error) { return errorResponse(error); }
}
