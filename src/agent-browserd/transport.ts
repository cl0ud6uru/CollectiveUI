import http from "node:http";
import { signRequest } from "../sandboxd/protocol/auth.ts";
import { BrowserError } from "../lib/agent-browser/provider-contract.ts";

/** Unix sockets only. No caller-configurable network endpoints or environment HTTP proxies. */
export async function signedCall(socketPath: string, secret: string, path: string, value: unknown, maxBytes: number, signal?: AbortSignal) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new BrowserError("invalid");
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    const req = http.request({ socketPath, method: "POST", path, signal: combined,
      headers: { ...signRequest(secret, { method: "POST", path, body }), "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new BrowserError("unavailable", "Browser response exceeded limit")); res.destroy(); }
        else chunks.push(c);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 500, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
}

export async function boundedBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const c = Buffer.from(raw); size += c.length;
    if (size > max) throw new BrowserError("invalid", "Request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
