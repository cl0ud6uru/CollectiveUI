import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, open, unlink } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { LocalController, LocalError } from "./controller";

export async function body(req: IncomingMessage, maxBytes = 256 * 1024) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const part of req) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > maxBytes) throw new LocalError(413, "Local request is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  catch { throw new LocalError(400, "Invalid JSON"); }
}
export const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data));
};

/** Filesystem permissions are the IPC authentication boundary; no TCP listener or browser endpoint. */
export async function listenController(controller: LocalController) {
  const { config } = controller;
  const lockPath = path.join(config.stateDir, "controller.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Controller ownership is locked. Do not remove controller.lock until its recorded process and Hermes descendants are confirmed stopped."); });
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.origin || req.headers.upgrade) throw new LocalError(403, "Browser and upgrade requests are not supported");
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/control/status") { json(res, 200, controller.status()); return; }
      if (req.method === "POST" && ["/control/start", "/control/reconnect", "/control/stop", "/control/pair"].includes(url)) {
        const data = await body(req);
        if (url === "/control/start") await controller.start();
        if (url === "/control/reconnect") await controller.reconnect();
        if (url === "/control/stop") await controller.stop();
        if (url === "/control/pair") { json(res, 200, controller.pair(data)); return; }
        json(res, 200, controller.status()); return;
      }
      const match = /^\/p\/([A-Za-z0-9_-]+)(\/v1\/.*)$/.exec(url);
      if (!match) throw new LocalError(404, "Unknown local operation");
      await serveNative(controller, match[1], match[2], req, res);
    })().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof LocalError ? error.status : error instanceof ZodError ? 400 : 503;
      const message = error instanceof LocalError ? error.message : error instanceof ZodError ? "Invalid Local Hermes request" : "Local Hermes operation failed. Check controller readiness and the selected native profile's logs.";
      json(res, status, { error: message });
    });
  });
  server.requestTimeout = 45_000; server.headersTimeout = 10_000; server.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.socketPath, resolve); });
    await chmod(config.socketPath, 0o660);
  } catch (error) { await unlink(lockPath); throw error; }
  return { server, close: async () => {
    await controller.stop(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await unlink(lockPath);
  } };
}

/** Shared adapter: callers must authorize their runtime/profile binding before dispatch. */
export async function serveNative(controller: LocalController, bindingId: string, route: string, req: IncomingMessage, res: ServerResponse) {
      controller.assertBinding(bindingId);

      if (req.method === "GET" && route === "/v1/capabilities") {
        json(res, 200, { features: { run_submission: true, run_events_sse: true, run_stop: true, run_approval_response: true, approval_events: true, native_attachments: true, native_run_view: true, native_run_controls: true } }); return;
      }
      if(req.method==='POST' && route==='/v1/learning') {
        const input=await body(req,1024);
        if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length)throw new LocalError(400,'Invalid native learning admission.');
        return json(res,202,{run_id:controller.beginLearning(bindingId)});
      }
      // The first pilot does not proxy arbitrary native management/commands, profile config or model discovery.
      if (req.method === "POST" && route === "/v1/runs") {
        const runId = controller.begin(bindingId, await body(req, 24 * 1024 * 1024), String(req.headers["idempotency-key"] ?? ""));
        json(res, 202, { run_id: runId }); return;
      }
      const runMatch = /^\/v1\/runs\/(run_[A-Za-z0-9]+)(?:\/(events|approval|stop|native))?$/.exec(route);
      if (!runMatch) throw new LocalError(404, "This capability is not supported by the Local Hermes pilot");
      const [, runId, operation] = runMatch;
      if (operation === "native") {
        if (req.method === "GET") { json(res, 200, await controller.nativeView(runId)); return; }
        if (req.method === "POST") { json(res, 200, await controller.nativeControl(runId, await body(req))); return; }
        throw new LocalError(405, "Method not allowed");
      }
      if (req.method === "POST" && operation === "approval") { controller.approve(runId, await body(req)); json(res, 200, { status: "resolved" }); return; }
      if (req.method === "POST" && operation === "stop") { await controller.cancel(runId); json(res, 200, { status: "requested" }); return; }
      if (req.method !== "GET") throw new LocalError(405, "Method not allowed");
      if (!operation) { json(res, 200, controller.getRun(runId)); return; }
      if (operation !== "events") throw new LocalError(404, "Unknown local operation");
      let cursor = Number(req.headers["last-event-id"] ?? 0);
      controller.events(runId, cursor); // validate before starting SSE
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      const drain = () => {
        let batch:ReturnType<LocalController['events']>;
        try { batch = controller.events(runId, cursor); }
        catch { res.destroy(); return; } // Expired/revoked candidate streams cannot deliver cached private events.
        for (const event of batch.events) {
          cursor = Number(event._seq);
          if (!res.write(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`)) {
            // A slow subscriber reconnects from its last delivered cursor; it cannot grow controller memory.
            res.destroy(); return;
          }
        }
        if (batch.ended) res.end();
      };
      controller.changes.on(runId, drain);
      const heartbeat = setInterval(() => { if (!res.write(": keepalive\n\n")) res.destroy(); }, 10_000);
      res.once("close", () => { clearInterval(heartbeat); controller.changes.off(runId, drain); });
      drain();
}
