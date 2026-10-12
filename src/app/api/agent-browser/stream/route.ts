import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { browserViewForConversation } from "@/lib/agent-browser/session-source";
import { boundedAgentBrowserFrames, MAX_AGENT_BROWSER_STREAM_MS, reserveAgentBrowserSubscriber } from "@/lib/agent-browser/viewer";

const encoder = new TextEncoder();
const eventBytes = (event: string, value: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
const keepalive = encoder.encode(": keepalive\n\n");

/** View-only, owner-authorized SSE. Cancelling this stream only unsubscribes the viewer; it never stops the run. */
export async function GET(req: Request) {
  try {
    const principal = await requirePrincipal();
    const query = new URL(req.url).searchParams;
    if ([...query.keys()].some(key => key !== "conversationId") || query.getAll("conversationId").length !== 1)
      throw new HttpError(400, "Invalid browser-view request");
    const conversationId = query.get("conversationId")!;
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(conversationId)) throw new HttpError(400, "Invalid browser-view request");
    const view = await browserViewForConversation(principal, conversationId, req.signal);
    if (!view || (await view.source.status(req.signal).catch(() => "disconnected")) === "disconnected")
      throw new HttpError(409, "The agent browser is disconnected.");

    const release = reserveAgentBrowserSubscriber(principal.user.id);
    const abort = new AbortController();
    const onRequestAbort = () => abort.abort();
    req.signal.addEventListener("abort", onRequestAbort, { once: true });
    if (req.signal.aborted) abort.abort();

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let duration: ReturnType<typeof setTimeout> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let authorizeTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (event?: "disconnected" | "reconnect", discardQueued = false) => {
      if (ended) return;
      ended = true;
      if (duration) clearTimeout(duration);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (authorizeTimer) clearInterval(authorizeTimer);
      req.signal.removeEventListener("abort", onRequestAbort);
      release();
      if (discardQueued) {
        // error() clears the stream queue; close() would allow an unread frame to drain after revocation.
        try { controller?.error(new Error("Browser view authorization expired.")); } catch { /* Already cancelled. */ }
        return;
      }
      try {
        if (event && controller && controller.desiredSize !== null && controller.desiredSize > 0) controller.enqueue(eventBytes(event, {}));
        controller?.close();
      } catch { /* The viewer closed its connection. */ }
    };
    let authorizationFailed = false;
    const checkAuthorization = async () => {
      try { await view.authorize(); }
      catch (error) { authorizationFailed = true; throw error; }
    };
    const revoke = () => { abort.abort(); finish(undefined, true); };
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        duration = setTimeout(() => { abort.abort(); finish("reconnect"); }, MAX_AGENT_BROWSER_STREAM_MS);
        keepaliveTimer = setInterval(() => {
          if (ended) return;
          try {
            if (controller?.desiredSize !== null && controller?.desiredSize !== undefined && controller.desiredSize > 0) controller.enqueue(keepalive);
          } catch { abort.abort(); finish(); }
        }, 10_000);
        authorizeTimer = setInterval(() => { void checkAuthorization().catch(revoke); }, 3_000);
        void (async () => {
          let lastAuthorization = Date.now();
          try {
            await checkAuthorization();
            for await (const frame of boundedAgentBrowserFrames(view.source, abort.signal)) {
              if (ended || abort.signal.aborted) return;
              if (Date.now() - lastAuthorization >= 3_000) { await checkAuthorization(); lastAuthorization = Date.now(); }
              const payload = {
                sequence: frame.sequence,
                capturedAt: frame.capturedAt,
                contentType: "image/jpeg" as const,
                width: frame.width,
                height: frame.height,
                data: Buffer.from(frame.bytes).toString("base64"),
              };
              // The default stream queue holds at most one bounded frame. Slow clients drop frames instead of buffering.
              if (controller?.desiredSize !== null && controller?.desiredSize !== undefined && controller.desiredSize > 0) {
                controller.enqueue(eventBytes("frame", payload));
              }
            }
            finish("disconnected");
          } catch {
            if (authorizationFailed) revoke();
            else finish("disconnected");
          }
        })();
      },
      cancel() { abort.abort(); finish(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    } });
  } catch (err) { return errorResponse(err); }
}
