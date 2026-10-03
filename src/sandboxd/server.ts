/**
 * sandboxd's HTTP API. Every request is signed (protocol/auth.ts) and verified before its body is parsed. Only the
 * portal's web and worker processes can reach it (compose network "control"; 127.0.0.1 in dev).
 */
import http from "node:http";
import type { Config } from "./config.ts";
import { SandboxdError, type Manager } from "./manager.ts";
import { NonceCache, verifyRequest } from "./protocol/auth.ts";
import { encodeFrame, HEARTBEAT_MS, type Frame } from "./protocol/frames.ts";
import type { ErrorCode, ExecRequest, GrepRequest, Isolation, ListRequest, ReadRequest, WriteRequest } from "./protocol/types.ts";
import { fsGrep, fsList, fsRead, fsUsage, fsWrite, TemplateError } from "./templates.ts";

const MAX_BODY = 16 * 1024 * 1024;
const FRAME_CHUNK = 64 * 1024;
const MAX_FILE_WRITE = 10 * 1024 * 1024;

type Log = (msg: string, extra?: object) => void;

class BadRequest extends SandboxdError {
  constructor(message: string) {
    super("bad_request", message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: http.ServerResponse, err: unknown, log: Log) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof SandboxdError) return sendJson(res, err.status, { error: err.code, message: err.message });
  if (err instanceof TemplateError) return sendJson(res, 400, { error: "bad_request" as ErrorCode, message: err.message });
  const status = (err as { status?: number }).status;
  if (typeof status === "number" && status >= 500) return sendJson(res, 503, { error: "docker_unavailable", message: (err as Error).message });
  log("request failed", { error: String((err as Error)?.stack ?? err) });
  sendJson(res, 500, { error: "internal", message: "sandboxd hit an error" });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new SandboxdError("too_large", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const isolationOf = (v: unknown): Isolation => {
  if (v !== "gvisor" && v !== "any") throw new BadRequest("isolation must be gvisor or any");
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new BadRequest(`${what} must be a string`);
  return v;
};
const optStr = (v: unknown, what: string) => (v === undefined ? undefined : str(v, what));
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new BadRequest(`${what} must be an integer`);
  return v;
};
const optInt = (v: unknown, what: string) => (v === undefined ? undefined : int(v, what));

export function createServer(manager: Manager, config: Config, log: Log): http.Server {
  const nonces = new NonceCache();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const body = await readBody(req);
    const v = verifyRequest(config.secret, { method, path, headers: req.headers, body, now: Date.now(), nonces });
    if (!v.ok) {
      log("rejected request", { method, path: path.split("?")[0], reason: v.reason });
      return sendJson(res, 401, { error: "unauthorized", message: "Invalid or missing signature" });
    }
    let json: Record<string, unknown> = {};
    if (body.length) {
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        throw new BadRequest("Body must be JSON");
      }
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new BadRequest("Body must be a JSON object");
    }
    const url = new URL(path, "http://sandboxd");
    const m = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);

    if (method === "GET" && url.pathname === "/v1/health") return sendJson(res, 200, await manager.health());
    if (method === "GET" && url.pathname === "/v1/sandboxes") return sendJson(res, 200, { sandboxes: await manager.list() });
    if (!m) return sendJson(res, 404, { error: "not_found", message: "No such endpoint" });

    const ref = decodeURIComponent(m[1]);
    const sub = m[2] ?? "";
    if (method === "GET" && sub === "") return sendJson(res, 200, await manager.state(ref));
    if (method === "DELETE" && sub === "") {
      await manager.destroy(ref);
      return sendJson(res, 200, { destroyed: true });
    }
    if (method === "POST" && sub === "/start") {
      await manager.ensure(ref, isolationOf(json.isolation));
      return sendJson(res, 200, await manager.state(ref));
    }
    if (method === "POST" && sub === "/stop") return sendJson(res, 200, await manager.stop(ref));

    const kill = /^\/execs\/([a-z0-9]+)\/kill$/.exec(sub);
    if (method === "POST" && kill) return sendJson(res, 200, { killed: manager.killExec(ref, kill[1]) });

    if (method === "POST" && sub === "/exec") return exec(ref, json, req, res);

    if (method === "POST" && sub === "/files/read") {
      const r: ReadRequest = {
        isolation: isolationOf(json.isolation),
        path: str(json.path, "path"),
        maxBytes: int(json.maxBytes, "maxBytes"),
        startLine: optInt(json.startLine, "startLine"),
        endLine: optInt(json.endLine, "endLine"),
      };
      const { header, payload } = await manager.fsCall(ref, r.isolation, fsRead(r), { maxBytes: r.maxBytes + 4096 });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-sbx-file": JSON.stringify({ size: header.size, bytes: header.bytes, truncated: header.truncated }),
        "content-length": payload.length,
      });
      return res.end(payload);
    }
    if (method === "POST" && sub === "/files/write") {
      const w: WriteRequest = { isolation: isolationOf(json.isolation), path: str(json.path, "path"), contentB64: str(json.contentB64, "contentB64") };
      const content = Buffer.from(w.contentB64, "base64");
      if (content.length > MAX_FILE_WRITE) throw new SandboxdError("too_large", "The file is too large");
      const { header } = await manager.fsCall(ref, w.isolation, fsWrite({ path: w.path, maxBytes: MAX_FILE_WRITE }), { stdin: content });
      return sendJson(res, 200, { bytes: header.bytes, created: header.created });
    }
    if (method === "POST" && sub === "/list") {
      const l: ListRequest = { isolation: isolationOf(json.isolation), path: optStr(json.path, "path"), depth: int(json.depth, "depth"), maxEntries: int(json.maxEntries, "maxEntries") };
      const { header } = await manager.fsCall(ref, l.isolation, fsList(l));
      return sendJson(res, 200, { entries: header.entries, truncated: header.truncated });
    }
    if (method === "POST" && sub === "/grep") {
      const g: GrepRequest = {
        isolation: isolationOf(json.isolation),
        pattern: str(json.pattern, "pattern"),
        path: optStr(json.path, "path"),
        glob: optStr(json.glob, "glob"),
        ignoreCase: json.ignoreCase === true,
        maxMatches: int(json.maxMatches, "maxMatches"),
      };
      const { header } = await manager.fsCall(ref, g.isolation, fsGrep(g), { timeoutMs: 60_000 });
      return sendJson(res, 200, { matches: header.matches, truncated: header.truncated });
    }
    if (method === "POST" && sub === "/usage") {
      const state = await manager.state(ref);
      if (state.state !== "running") return sendJson(res, 200, { bytes: null });
      const { header } = await manager.fsCall(ref, isolationOf(json.isolation), fsUsage());
      return sendJson(res, 200, { bytes: header.bytes });
    }
    return sendJson(res, 404, { error: "not_found", message: "No such endpoint" });
  }

  async function exec(ref: string, json: Record<string, unknown>, req: http.IncomingMessage, res: http.ServerResponse) {
    const env = json.env;
    if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) throw new BadRequest("env must be an object");
    const r: ExecRequest = {
      isolation: isolationOf(json.isolation),
      command: str(json.command, "command"),
      cwd: optStr(json.cwd, "cwd"),
      env: env as Record<string, string> | undefined,
      timeoutMs: int(json.timeoutMs, "timeoutMs"),
      execId: str(json.execId, "execId"),
    };
    const abort = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) abort.abort();
    });
    let hb: ReturnType<typeof setInterval> | undefined;
    const write = (f: Frame) => {
      if (!res.writableEnded) res.write(encodeFrame(f));
    };
    const data = (t: "out" | "err", chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += FRAME_CHUNK) write({ t, d: chunk.subarray(i, i + FRAME_CHUNK).toString("base64") });
    };
    try {
      const result = await manager.exec(
        ref,
        r,
        {
          onStart: () => {
            res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
            write({ t: "start", id: r.execId });
            hb = setInterval(() => write({ t: "hb" }), HEARTBEAT_MS);
          },
          onOut: (c) => data("out", c),
          onErr: (c) => data("err", c),
          onGap: (s, n) => write({ t: "gap", s, n }),
        },
        abort.signal,
      );
      write({ t: "exit", code: result.code, reason: result.reason, ms: result.ms, dropped: result.dropped });
      finished = true;
      res.end();
    } catch (err) {
      finished = true;
      if (res.headersSent) {
        write({ t: "error", code: err instanceof SandboxdError ? err.code : "internal", message: err instanceof Error ? err.message : String(err) });
        res.end();
      } else throw err;
    } finally {
      if (hb) clearInterval(hb);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err, log));
  });
  server.requestTimeout = 0; // exec streams can run for up to maxExecSeconds
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
