import { GATEWAY_BOOTSTRAP } from "./gateway-bootstrap";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ControllerConfig } from "./config";
import { childEnvironment } from "./config";
import { stopOwnedGroup } from "./process-group";

export type RpcObject = Record<string, unknown>;
export type RpcFrame = { jsonrpc: string; id?: string | number; method?: string; params?: RpcObject; result?: RpcObject; error?: RpcObject };
export const object = (v: unknown): RpcObject => v && typeof v === "object" && !Array.isArray(v) ? v as RpcObject : {};
export const string = (v: unknown) => typeof v === "string" ? v : "";

/** Trusted controller extension, never populated from a browser request. */
export type RpcTransport = {
  spawn: () => ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
};

/** One private stdio channel. No arbitrary executable, argv, RPC, or environment comes from HTTP. */
export class NativeRpc {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: RpcObject) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready?: { resolve: () => void; reject: (e: Error) => void };
  private exiting?: Promise<void>;
  private cleaning?: Promise<void>;
  private exitNotified = false;
  alive = false;
  serverRequests: string[] = [];
  constructor(private config: ControllerConfig, private onFrame: (f: RpcFrame) => void, private onExit: () => void, private onCleanupError: () => void, private transport?: RpcTransport) {}

  async start() {
    if (this.child) throw new Error("Gateway already started");
    const ready = new Promise<void>((resolve, reject) => { this.ready = { resolve, reject }; });
    const child = this.transport?.spawn() ?? spawn(this.config.python, ["-u", "-c", GATEWAY_BOOTSTRAP], {
      cwd: this.config.source, env: childEnvironment(this.config), shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.alive = true;
    let buffer = "";
    const fail = () => { void this.stop().catch(() => {}); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { fail(); return; }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as RpcFrame;
          if (!frame || frame.jsonrpc !== "2.0") { fail(); return; }
          if (frame.method === "event" && frame.params?.type === "gateway.ready") this.ready?.resolve();
          else if (!frame.method && typeof frame.id === "number") {
            const p = this.pending.get(frame.id);
            if (p) {
              clearTimeout(p.timer); this.pending.delete(frame.id);
              // Raw Python errors may include credentials/paths. Keep them in the native runtime only.
              if (frame.error) p.reject(new Error(`Hermes refused a native request (code ${Number(frame.error.code) || "unknown"}). Check the selected profile in Hermes.`));
              else p.resolve(object(frame.result));
            }
          } else this.onFrame(frame);
        } catch { fail(); return; }
      }
    });
    // Drain without storing or logging: native stderr may contain secrets.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    this.exiting = new Promise<void>(resolve => {
      const ended = () => {
        if (!this.alive) return;
        this.alive = false;
        const error = new Error("Native Hermes exited. Check its own profile logs, then restart the runtime in its settings.");
        this.ready?.reject(error);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
        this.pending.clear(); resolve();
        // Parent death is not proof that its child processes stopped. Cleanup starts immediately.
        void this.cleanGroup().catch(() => {});
      };
      child.once("error", ended); child.once("exit", ended);
    });
    const timer = setTimeout(() => this.ready?.reject(new Error("Hermes startup timed out. Check installation dependencies and the native profile logs.")), 30_000);
    try {
      await ready;
      if ((await this.call("ping")).pong !== true) throw new Error("Hermes did not answer the readiness probe");
      const caps = await this.call("client.capabilities", { server_requests: true });
      this.serverRequests = Array.isArray(caps.server_requests) ? caps.server_requests.filter((s): s is string => typeof s === 'string') : [];
      if (!Array.isArray(caps.server_requests) || !caps.server_requests.includes("approval")) throw new Error("Hermes does not support native approval requests");
      if ((await this.call("gateway.capabilities")).per_session_exclusive_submit !== true) throw new Error("Hermes lacks exclusive turn admission");
    } catch (e) { await this.stop(); throw e; }
    finally { clearTimeout(timer); this.ready = undefined; }
  }

  call(method: string, params: RpcObject = {}, timeoutMs = 30_000): Promise<RpcObject> {
    if (!this.alive) return Promise.reject(new Error("Start your native Hermes runtime first."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hermes ${method} timed out; admission may be uncertain. Stop the engine before retrying.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  answer(id: string | number, result?: RpcObject) {
    this.write(result ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error: { code: -32601, message: "This interaction is not supported by the CollectiveUI Native Hermes pilot" } });
  }
  private write(frame: RpcFrame) {
    if (this.alive) this.child?.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  async stop() {
    if (!this.child) return;
    await this.cleanGroup();
    await this.exiting;
  }
  private cleanGroup() {
    this.cleaning ??= (async () => {
      if (this.transport) await this.transport.stop();
      else if (this.child?.pid) await stopOwnedGroup(this.child.pid);
      if (!this.exitNotified) {
        this.exitNotified = true;
        // Controller persistence errors cannot escape the process event handler or hang its exit promise.
        try { this.onExit(); } catch { /* controller marks storage failures and refuses further work */ }
      }
    })().catch(error => { this.onCleanupError(); throw error; });
    return this.cleaning;
  }
}
