import http from "node:http";
import { listenPrivateSocket } from "./private-socket.mjs";
import { assertSecret, NonceCache, verifyRequest } from "../sandboxd/protocol/auth.ts";
import { boundedBody, signedCall } from "./transport.ts";
import { fetchPublic, type EgressRequest, type EgressResponse } from "./network.ts";
import { BROWSER_LIMITS } from "../lib/agent-browser/provider-contract.ts";

export function createEgressServer(secret: string, fetcher = fetchPublic) {
  assertSecret(secret); const nonces = new NonceCache(); let running = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await boundedBody(req, 2 * BROWSER_LIMITS.maxRequestBytes);
      if (req.method !== "POST" || req.url !== "/v1/egress" || !verifyRequest(secret, { method: req.method, path: req.url, body, headers: req.headers, now: Date.now(), nonces }).ok) {
        res.writeHead(401); res.end(); return;
      }
      if (running >= 32) { res.writeHead(429); res.end(); return; }
      const input = JSON.parse(body.toString()) as EgressRequest;
      if (!input || typeof input !== "object" || Object.keys(input).some(k => !["url", "method", "headers", "bodyB64"].includes(k))) throw new Error("Invalid request");
      const abort = new AbortController();
      res.on("close", () => abort.abort()); running++;
      try {
        const result = await fetcher(input, abort.signal);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(result));
      } finally { running--; }
    })().catch(() => { if (!res.headersSent) res.writeHead(403); res.end(); });
  });
  server.requestTimeout = 20_000; server.headersTimeout = 5000; server.maxConnections = 64;
  return server;
}

export function unixEgress(socketPath: string, secret: string) {
  return async (input: EgressRequest, signal: AbortSignal): Promise<EgressResponse> => {
    const r = await signedCall(socketPath, secret, "/v1/egress", input, BROWSER_LIMITS.maxResponseBytes * 2, signal);
    if (r.status !== 200) throw new Error("Browser network request blocked");
    return JSON.parse(r.bytes.toString());
  };
}

if (process.argv[1]?.endsWith("/egress.ts")) {
  const socket = process.env.AGENT_BROWSER_EGRESS_SOCKET;
  if (!socket?.startsWith("/")) throw new Error("An absolute private egress socket is required");
  const server = createEgressServer(process.env.AGENT_BROWSER_EGRESS_SECRET ?? "");
  await listenPrivateSocket(server, socket);
  for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => server.close());
}
