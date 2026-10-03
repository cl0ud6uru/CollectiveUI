/**
 * The portal's client for sandboxd (web and worker). Signs every request; uses node:http with its own keep-alive
 * agent rather than fetch (no proxy environment, no undici body timeout on long commands).
 *
 * SANDBOXD_URL / SANDBOXD_SECRET are infrastructure settings like DATABASE_URL (not model credentials).
 */
import http from "node:http";
import { signRequest } from "@/sandboxd/protocol/auth";
import { LineSplitter, parseFrame, type Frame } from "@/sandboxd/protocol/frames";
import type {
  ErrorCode,
  ExecRequest,
  GrepRequest,
  GrepResult,
  Health,
  ListRequest,
  ListResult,
  ReadRequest,
  SandboxState,
  WriteRequest,
  WriteResult,
} from "@/sandboxd/protocol/types";

export type ClientErrorCode = ErrorCode | "unreachable" | "not_configured" | "timeout" | "protocol";

const MESSAGES: Partial<Record<ClientErrorCode, string>> = {
  unreachable: "The workspace service isn't reachable right now. Try again in a moment.",
  not_configured: "Workspaces aren't set up on this server.",
  timeout: "The workspace service stopped responding.",
  isolation_unavailable: "Workspaces need gVisor isolation, which isn't available on this server. An admin can allow standard isolation in Admin → Workspaces.",
  busy: "The workspace is busy with other commands. Try again when they finish.",
  capacity: "All workspaces on this server are in use right now. Try again shortly.",
  image_missing: "The workspace image isn't installed on the server.",
  docker_unavailable: "The workspace service can't reach Docker right now.",
  unauthorized: "The portal couldn't authenticate to the workspace service.",
};

export class SandboxError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  /** Safe to show people (no internals). */
  readonly userFacing = true;
  constructor(code: ClientErrorCode, message: string, status = 0) {
    super(MESSAGES[code] ?? message);
    this.code = code;
    this.status = status;
  }
}

export type SandboxdConfig = { url: string; secret: string };

export function sandboxdConfig(env: Record<string, string | undefined> = process.env): SandboxdConfig | null {
  const url = env.SANDBOXD_URL;
  const secret = env.SANDBOXD_SECRET;
  if (!url || !secret) return null;
  return { url, secret };
}

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
export type ExitFrame = Extract<Frame, { t: "exit" }>;

export class SandboxdClient {
  private readonly base: URL;
  private readonly secret: string;
  private readonly agent: http.Agent;

  constructor(cfg: SandboxdConfig) {
    this.base = new URL(cfg.url);
    if (this.base.protocol !== "http:") throw new Error("SANDBOXD_URL must be http:// on the private control network");
    this.secret = cfg.secret;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  }

  private open(method: string, path: string, body: object | undefined, timeoutMs: number, signal?: AbortSignal) {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string | number> = {
      ...signRequest(this.secret, { method, path, body: payload }),
      ...(payload.length ? { "content-type": "application/json", "content-length": payload.length } : {}),
    };
    const req = http.request({ host: this.base.hostname, port: this.base.port || 80, method, path, headers, agent: this.agent, signal });
    req.setTimeout(timeoutMs, () => req.destroy(new SandboxError("timeout", "sandboxd timed out")));
    req.end(payload);
    return req;
  }

  private request(method: string, path: string, body?: object, timeoutMs = 60_000): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const req = this.open(method, path, body, timeoutMs);
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", (err) => reject(asError(err)));
      });
      req.on("error", (err) => reject(asError(err)));
    });
  }

  private async json<T>(method: string, path: string, body?: object, timeoutMs?: number): Promise<T> {
    const r = await this.request(method, path, body, timeoutMs);
    if (r.status >= 400) throw fromResponse(r);
    return JSON.parse(r.body.toString("utf8")) as T;
  }

  health() {
    return this.json<Health>("GET", "/v1/health", undefined, 60_000);
  }
  list() {
    return this.json<{ sandboxes: SandboxState[] }>("GET", "/v1/sandboxes").then((r) => r.sandboxes);
  }
  state(ref: string) {
    return this.json<SandboxState>("GET", `/v1/sandboxes/${ref}`);
  }
  start(ref: string, isolation: ExecRequest["isolation"]) {
    return this.json<SandboxState>("POST", `/v1/sandboxes/${ref}/start`, { isolation }, 120_000);
  }
  stop(ref: string) {
    return this.json<SandboxState>("POST", `/v1/sandboxes/${ref}/stop`, {}, 60_000);
  }
  destroy(ref: string) {
    return this.json<{ destroyed: boolean }>("DELETE", `/v1/sandboxes/${ref}`, undefined, 120_000);
  }
  usage(ref: string, isolation: ExecRequest["isolation"]) {
    return this.json<{ bytes: number | null }>("POST", `/v1/sandboxes/${ref}/usage`, { isolation }, 120_000);
  }
  kill(ref: string, execId: string) {
    return this.json<{ killed: boolean }>("POST", `/v1/sandboxes/${ref}/execs/${execId}/kill`, {});
  }
  listFiles(ref: string, req: ListRequest) {
    return this.json<ListResult>("POST", `/v1/sandboxes/${ref}/list`, req, 120_000);
  }
  grep(ref: string, req: GrepRequest) {
    return this.json<GrepResult>("POST", `/v1/sandboxes/${ref}/grep`, req, 120_000);
  }
  writeFile(ref: string, req: WriteRequest) {
    return this.json<WriteResult>("POST", `/v1/sandboxes/${ref}/files/write`, req, 120_000);
  }

  /** The file's bytes, or null when it doesn't exist. */
  async readFile(ref: string, req: ReadRequest): Promise<{ bytes: Buffer; size: number; truncated: boolean } | null> {
    const r = await this.request("POST", `/v1/sandboxes/${ref}/files/read`, req, 120_000);
    if (r.status === 404) {
      const e = safeJson(r.body);
      if (e?.error === "not_found") return null;
    }
    if (r.status >= 400) throw fromResponse(r);
    const meta = JSON.parse(String(r.headers["x-sbx-file"] ?? "{}")) as { size?: number; truncated?: boolean };
    return { bytes: r.body, size: meta.size ?? r.body.length, truncated: !!meta.truncated };
  }

  /**
   * Runs a command. Rejects with a SandboxError if it never started (safe to retry); after that, frames arrive through
   * onFrame and the promise resolves with the exit frame. Aborting the signal kills the command. A stream silent for
   * `idleTimeoutMs` (sandboxd sends a heartbeat every 15 s) is treated as lost.
   */
  exec(ref: string, req: ExecRequest, opts: { onFrame?: (f: Frame) => void; signal?: AbortSignal; idleTimeoutMs?: number } = {}): Promise<ExitFrame> {
    const idleMs = opts.idleTimeoutMs ?? 45_000;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onAbort);
      if (opts.signal?.aborted) controller.abort();
      const req_ = this.open("POST", `/v1/sandboxes/${ref}/exec`, req, idleMs, controller.signal);
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      req_.on("response", (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => done(() => reject(fromResponse({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))));
          return;
        }
        const split = new LineSplitter();
        let exit: ExitFrame | null = null;
        let failure: SandboxError | null = null;
        res.on("data", (c: Buffer) => {
          try {
            for (const line of split.push(c)) {
              const f = parseFrame(line);
              if (f.t === "exit") exit = f;
              else if (f.t === "error") failure = new SandboxError((f.code as ClientErrorCode) ?? "internal", f.message);
              if (f.t !== "hb") opts.onFrame?.(f);
            }
          } catch {
            failure = new SandboxError("protocol", "Malformed response from sandboxd");
            res.destroy();
          }
        });
        res.on("end", () =>
          done(() => {
            if (exit) resolve(exit);
            else reject(failure ?? new SandboxError("unreachable", "The command's stream ended early"));
          }),
        );
        res.on("error", (err) => done(() => reject(failure ?? asError(err))));
      });
      req_.on("error", (err) => done(() => reject(opts.signal?.aborted ? new SandboxError("timeout", "Stopped") : asError(err))));
    });
  }
}

function safeJson(b: Buffer): { error?: ErrorCode; message?: string } | null {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return null;
  }
}

function fromResponse(r: Raw): SandboxError {
  const e = safeJson(r.body);
  return new SandboxError(e?.error ?? "internal", e?.message ?? `sandboxd returned ${r.status}`, r.status);
}

function asError(err: unknown): SandboxError {
  if (err instanceof SandboxError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "EHOSTUNREACH") return new SandboxError("unreachable", String(err));
  if ((err as Error)?.name === "AbortError") return new SandboxError("timeout", "Stopped");
  return new SandboxError("unreachable", String((err as Error)?.message ?? err));
}

const g = globalThis as unknown as { __sandboxd?: SandboxdClient | null };

/** The shared client, or null when sandboxd isn't configured. */
export function sandboxd(): SandboxdClient | null {
  if (g.__sandboxd === undefined) {
    const cfg = sandboxdConfig();
    g.__sandboxd = cfg ? new SandboxdClient(cfg) : null;
  }
  return g.__sandboxd;
}
