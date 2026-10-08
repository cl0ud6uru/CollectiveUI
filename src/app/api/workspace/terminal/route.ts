import { randomBytes } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/authz";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { audit } from "@/lib/audit";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { sandboxd } from "@/lib/sandbox/client";
import { cleanText, isHardDenied, requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { getOrCreateRef, touchSandbox } from "@/lib/sandbox/store";
import { browserPath } from "@/lib/sandbox/browser";

const input = z.object({ command: z.string().trim().min(1).max(16384).refine(s => !s.includes("\0")), cwd: z.string().max(1024).default(".") }).strict();

/** A person's explicit Run command action. Bot commands still use the separate chat approval flow. */
export async function POST(req: Request) {
  try {
    assertAuthOrigin(req.headers);
    const p = await requirePrincipal();
    const settings = await getSetting("sandbox");
    if (!userMayUseWorkspace(p, settings)) throw new HttpError(403, "Workspace access is unavailable");
    if (!req.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(400, "Invalid command request");
    const reader = req.body?.getReader();
    if (!reader) throw new HttpError(400, "Invalid command request");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 70000) { await reader.cancel(); throw new HttpError(413, "Command is too long"); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "Invalid command request"); }
    const data = input.safeParse(parsed);
    if (!data.success) throw new HttpError(400, "Invalid command request");
    const cwd = browserPath(data.data.cwd, true);
    if (!cwd) throw new HttpError(400, "Invalid workspace directory");
    const denied = isHardDenied(data.data.command);
    if (denied) throw new HttpError(400, denied);
    const client = sandboxd();
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    const ref = await getOrCreateRef(p.user.id);
    const execId = randomBytes(8).toString("hex");
    // Record ownership/action, never command strings that may contain sensitive literals.
    await audit(p.user.id, "workspace.terminal", undefined, { execId });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });
    if (req.signal.aborted) abort.abort();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        const send = (event: object) => { if (!ended && !abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
        let outputBytes = 0;
        const outputLimit = settings.outputKb * 1024;
        const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
        void client.exec(ref, { isolation: requiredIsolation(settings), command: data.data.command, cwd, timeoutMs: settings.commandTimeoutSec * 1000, execId }, {
          signal: abort.signal,
          onFrame(frame) {
            if (frame.t === "start") send({ type: "start" });
            if (frame.t === "out" || frame.t === "err") {
              const bytes = Buffer.from(frame.d, "base64");
              const remaining = Math.max(0, outputLimit - outputBytes);
              if (remaining) send({ type: "output", stream: frame.t, text: cleanText(bytes.subarray(0, remaining)) });
              outputBytes += bytes.length;
            }
          },
        }).then(async result => {
          await touchSandbox(p.user.id);
          send({ type: "exit", code: result.code, reason: result.reason, truncated: outputBytes > outputLimit });
        }).catch(() => send({ type: "error", text: "The command stopped or the workspace connection was interrupted. Check its output before retrying." }))
          .finally(() => { clearInterval(heartbeat); req.signal.removeEventListener("abort", onAbort); ended = true; if (!abort.signal.aborted) controller.close(); });
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
  } catch (err) { return errorResponse(err); }
}
