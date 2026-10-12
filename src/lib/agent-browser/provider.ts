import { assertSecret } from "../../sandboxd/protocol/auth";
import { signedCall } from "../../agent-browserd/transport";
import { AgentBrowserSessions } from "./sessions";
import { BROWSER_LIMITS, BrowserError, parseScope, type AgentBrowserProvider, type BrowserAction, type BrowserFrame, type BrowserInspection, type BrowserScope, type BrowserState } from "./provider-contract";

export type BrowserAuthorization = (scope: BrowserScope, operation: "execute" | "view") => Promise<void>;

/** One client per authorized server caller; daemon shares live sessions across worker/web processes. */
export class PrivateBrowserProvider implements AgentBrowserProvider {
  private readonly sessions = new AgentBrowserSessions();
  constructor(private readonly socketPath: string, private readonly secret: string, private readonly authorize: BrowserAuthorization,
    private readonly mode: "execute" | "view" = "execute") {
    assertSecret(secret);
    if (!socketPath.startsWith("/")) throw new BrowserError("invalid");
  }
  private async call(path: string, scope: BrowserScope, extra: object = {}, permission: "execute" | "view" = "execute", signal?: AbortSignal) {
    if (permission === "execute" && this.mode === "view") throw new BrowserError("denied");
    await this.authorize(scope, permission);
    const result = await signedCall(this.socketPath, this.secret, path, { scope, ...extra }, BROWSER_LIMITS.frameBytes + 128 * 1024, signal);
    if (result.status !== 200) {
      let code: BrowserError["code"] = "unavailable";
      if (result.status === 403 || result.status === 404) code = "denied";
      if (result.status === 429) code = "capacity";
      if (result.status === 400) code = "invalid";
      if (result.status === 409) code = "stale_ref";
      throw new BrowserError(code);
    }
    return result;
  }
  async open(raw: BrowserScope, signal?: AbortSignal) {
    const scope = parseScope(raw);
    const r = await this.call("/v1/browser/open", scope, {}, "execute", signal);
    const value = JSON.parse(r.bytes.toString());
    this.sessions.bind(value.sessionId, scope);
    return { sessionId: value.sessionId as string };
  }
  async find(raw: BrowserScope, signal?: AbortSignal) {
    const scope = parseScope(raw);
    const r = await this.call("/v1/browser/find", scope, {}, "view", signal);
    const value = JSON.parse(r.bytes.toString());
    if (!value.sessionId) return null;
    this.sessions.bind(value.sessionId, scope);
    return { sessionId: value.sessionId as string };
  }
  private async operation(id: string, op: string, extra = {}, permission: "execute" | "view" = "execute", signal?: AbortSignal) {
    return this.call(`/v1/browser/sessions/${id}/${op}`, this.sessions.scope(id), extra, permission, signal);
  }
  async navigate(id: string, url: string, signal?: AbortSignal) { return JSON.parse((await this.operation(id, "navigate", { url }, "execute", signal)).bytes.toString()) as { title: string }; }
  async inspect(id: string, signal?: AbortSignal) { return JSON.parse((await this.operation(id, "inspect", {}, "execute", signal)).bytes.toString()) as BrowserInspection; }
  async act(id: string, action: BrowserAction, signal?: AbortSignal) { await this.operation(id, "act", { action }, "execute", signal); }
  async status(id: string, signal?: AbortSignal): Promise<BrowserState> { return JSON.parse((await this.operation(id, "status", {}, "view", signal)).bytes.toString()).state; }
  async *subscribeFrames(id: string, signal: AbortSignal): AsyncIterable<BrowserFrame> {
    const lease = JSON.parse((await this.operation(id, "subscribe", {}, "view", signal)).bytes.toString()).leaseId as string;
    let sequence = 0; const deadline = Date.now() + BROWSER_LIMITS.maxViewMs;
    try {
      while (!signal.aborted && Date.now() < deadline) {
        const r = await this.operation(id, "frame", { leaseId: lease }, "view", signal);
        const meta = JSON.parse(String(r.headers["x-agent-browser-frame"]));
        if (meta.sequence > sequence) {
          if (r.headers["content-type"] !== "image/jpeg" || r.bytes.length > BROWSER_LIMITS.frameBytes ||
              !Number.isSafeInteger(meta.sequence) || !Number.isFinite(Date.parse(meta.capturedAt)) ||
              meta.width !== BROWSER_LIMITS.width || meta.height !== BROWSER_LIMITS.height) throw new BrowserError("unavailable");
          sequence = meta.sequence;
          yield { ...meta, contentType: "image/jpeg", bytes: new Uint8Array(r.bytes) };
        }
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, BROWSER_LIMITS.frameIntervalMs);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      // Releasing a viewer never closes the page or cancels the agent run. Expiry handles revoked access.
      await this.operation(id, "unsubscribe", { leaseId: lease }, "view").catch(() => {});
    }
  }
  async close(id: string) {
    if (this.mode === "view") throw new BrowserError("denied");
    // Cleanup of an already-bound session remains valid after run/user admission is revoked.
    // Daemon still checks the immutable scope and HMAC. This cannot open or act on a browser.
    const scope = this.sessions.scope(id);
    await signedCall(this.socketPath, this.secret, `/v1/browser/sessions/${id}/close`, { scope }, 1024);
    this.sessions.forget(id);
  }
}

/** Disabled by default; isolated infrastructure must be supplied separately. No sandboxd fallback. */
export function configuredBrowserProvider(authorize: BrowserAuthorization, env: Record<string, string | undefined> = process.env): PrivateBrowserProvider | null {
  if (env.AGENT_BROWSER_ENABLED !== "1") return null;
  if (!env.AGENT_BROWSER_SOCKET || !env.AGENT_BROWSER_SECRET) throw new BrowserError("unavailable");
  return new PrivateBrowserProvider(env.AGENT_BROWSER_SOCKET, env.AGENT_BROWSER_SECRET, authorize);
}
