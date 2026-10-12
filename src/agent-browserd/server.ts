import http from "node:http";
import { assertSecret, NonceCache, verifyRequest } from "../sandboxd/protocol/auth.ts";
import { BROWSER_LIMITS, BrowserError, parseAction, parseScope } from "../lib/agent-browser/provider-contract.ts";
import { boundedBody } from "./transport.ts";
import { BrowserRuntime } from "./runtime.ts";

const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" }); res.end(JSON.stringify(value));
};
export function createBrowserServer(runtime: BrowserRuntime, secret: string) {
  assertSecret(secret); const nonces = new NonceCache();
  const server = http.createServer((req, res) => {
    void (async () => {
      const abort = new AbortController(); res.on("close", () => abort.abort());
      const body = await boundedBody(req, 16 * 1024);
      const path = req.url ?? "";
      if (req.method !== "POST" || !verifyRequest(secret, { method: req.method, path, body, headers: req.headers, now: Date.now(), nonces }).ok)
        return json(res, 401, { error: "denied" });
      const b = JSON.parse(body.toString());
      if (!b || typeof b !== "object" || Array.isArray(b)) throw new BrowserError("invalid");
      const scope = parseScope(b.scope);
      if (path === "/v1/browser/open" || path === "/v1/browser/find") {
        if (Object.keys(b).length !== 1) throw new BrowserError("invalid");
        return json(res, 200, path.endsWith("/open") ? await runtime.open(scope, abort.signal) : runtime.find(scope) ?? { sessionId: null });
      }
      const m = /^\/v1\/browser\/sessions\/([a-f0-9]{32})\/(navigate|inspect|act|status|subscribe|unsubscribe|frame|close)$/.exec(path);
      if (!m) return json(res, 404, { error: "denied" });
      const [, id, op] = m;
      const fields = op === "navigate" ? ["scope", "url"] : op === "act" ? ["scope", "action"] : ["frame", "unsubscribe"].includes(op) ? ["scope", "leaseId"] : ["scope"];
      if (Object.keys(b).some(k => !fields.includes(k)) || Object.keys(b).length !== fields.length) throw new BrowserError("invalid");
      switch (op) {
        case "navigate": return json(res, 200, await runtime.navigate(id, scope, b.url, abort.signal));
        case "inspect": return json(res, 200, await runtime.inspect(id, scope, abort.signal));
        case "act": await runtime.act(id, scope, parseAction(b.action), abort.signal); return json(res, 200, {});
        case "status": return json(res, 200, runtime.status(id, scope));
        case "subscribe": return json(res, 200, runtime.subscribe(id, scope));
        case "unsubscribe": runtime.unsubscribe(id, scope, b.leaseId); return json(res, 200, {});
        case "close": await runtime.close(id, scope); return json(res, 200, {});
        case "frame": {
          if (typeof b.leaseId !== "string" || !/^[a-f0-9]{32}$/.test(b.leaseId)) throw new BrowserError("invalid");
          const f = await runtime.frame(id, scope, b.leaseId, abort.signal);
          if (f.bytes.length > BROWSER_LIMITS.frameBytes) throw new BrowserError("unavailable");
          const { bytes, ...meta } = f;
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, no-store", "content-length": bytes.length, "x-agent-browser-frame": JSON.stringify(meta) });
          res.end(Buffer.from(bytes)); return;
        }
      }
    })().catch(e => {
      const status = e instanceof BrowserError ? ({ denied: 403, invalid: 400, capacity: 429, stale_ref: 409, unavailable: 503 } as const)[e.code] : 503;
      if (!res.headersSent) json(res, status, { error: e instanceof BrowserError ? e.code : "unavailable" }); else res.destroy();
    });
  });
  server.requestTimeout = 25_000; server.headersTimeout = 5000; server.maxConnections = 64;
  return server;
}
