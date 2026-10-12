import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Page } from "playwright-core";
import { browserUrl, type EgressRequest, type EgressResponse } from "./network.ts";
import { BROWSER_LIMITS as L, BrowserError, parseAction, parseScope, scopeKey, type BrowserAction, type BrowserFrame, type BrowserInspection, type BrowserScope } from "../lib/agent-browser/provider-contract.ts";

export type RuntimeOptions = {
  egress: (request: EgressRequest, signal: AbortSignal) => Promise<EgressResponse>;
  executablePath?: string; idleMs?: number; maxSessions?: number; maxPerOwner?: number;
  /** Dependency injection for isolated synthetic tests. Production entrypoint never accepts a launcher. */
  launch?: () => Promise<Browser>;
};
type Session = {
  id: string; scope: BrowserScope; browser: Browser; context: BrowserContext; page: Page;
  lastUsed: number; leases: Map<string, number>; refs: Map<string, ElementHandle>;
  chain: Promise<unknown>; frame: BrowserFrame | null; sequence: number; closed: boolean;
  requests: number; pending: number; abort: AbortController; cdp: CDPSession | null;
};
const token = (bytes = 16) => randomBytes(bytes).toString("hex");
const safeText = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max);

/** Separate Chromium processes and in-memory cookie contexts. No persistent user data or frame storage. */
export class BrowserRuntime {
  private readonly sessions = new Map<string, Session>();
  private opening: Promise<unknown> = Promise.resolve();
  private pendingOpen = 0;
  private readonly options: RuntimeOptions;
  constructor(options: RuntimeOptions) { this.options = options; }
  private async launch() {
    if (this.options.launch) return this.options.launch();
    const privateConfig = await mkdtemp(join(tmpdir(), "agent-browser-config-"));
    try {
      const browser = await chromium.launch({ executablePath: this.options.executablePath,
        chromiumSandbox: true, headless: true, timeout: L.actionTimeoutMs,
        // Do not inherit broker signing/egress secrets, portal credentials or host proxy settings.
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", XDG_CONFIG_HOME: privateConfig, XDG_CACHE_HOME: privateConfig },
        args: ["--disable-background-networking", "--disable-component-update", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
      browser.on("disconnected", () => { void rm(privateConfig, { recursive: true, force: true }); });
      return browser;
    } catch (e) { await rm(privateConfig, { recursive: true, force: true }); throw e; }
  }
  async open(raw: BrowserScope, signal?: AbortSignal) {
    const scope = Object.freeze(parseScope(raw));
    if (this.pendingOpen >= 16) throw new BrowserError("capacity");
    this.pendingOpen++;
    const task = this.opening.then(async () => {
      signal?.throwIfAborted();
      const prior = this.find(scope);
      if (prior) return prior;
      if (this.sessions.size >= (this.options.maxSessions ?? 8) ||
          [...this.sessions.values()].filter(s => s.scope.ownerUserId === scope.ownerUserId).length >= (this.options.maxPerOwner ?? 2)) throw new BrowserError("capacity");
      if ([...this.sessions.values()].some(s => s.scope.ownerUserId === scope.ownerUserId && s.scope.workspaceInstanceId === scope.workspaceInstanceId)) throw new BrowserError("capacity", "This private workspace already has a browser run");
      const browser = await this.launch();
      try {
        const context = await browser.newContext({ viewport: { width: L.width, height: L.height }, serviceWorkers: "block", acceptDownloads: false });
        context.setDefaultTimeout(L.actionTimeoutMs); context.setDefaultNavigationTimeout(L.actionTimeoutMs);
        const session: Session = { id: token(), scope, browser, context, page: undefined as unknown as Page,
          lastUsed: Date.now(), leases: new Map(), refs: new Map(), chain: Promise.resolve(), frame: null,
          sequence: 0, closed: false, requests: 0, pending: 0, abort: new AbortController(), cdp: null };
        await context.routeWebSocket("**/*", ws => ws.close());
        context.on("page", page => {
          if (session.page) { void page.close(); return; }
          session.page = page;
          page.on("dialog", d => { void d.dismiss(); });
          page.on("download", d => { void d.cancel(); });
          page.on("filechooser", () => { /* Never supply files to a page. */ });
          page.on("framenavigated", frame => {
            this.clearRefs(session);
            if (frame.url() !== "about:blank") {
              try { browserUrl(frame.url()); } catch { void this.dispose(session); }
            }
          });
          page.on("crash", () => { void this.dispose(session); });
        });
        session.page = await context.newPage();
        // Fetch interception sees EVERY redirected request. Playwright route handlers only see the
        // first URL in a redirect chain. The CDP session is private IPC, never a listener/DTO/tool input.
        session.cdp = await context.newCDPSession(session.page);
        const cdp = session.cdp;
        const redirectCounts = new Map<string, number>();
        cdp.on("Fetch.requestPaused", event => {
          void (async () => {
            const fail = () => cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
            if (session.closed || session.requests >= 8) { await fail(); return; }
            session.requests++;
            try {
              const req = event.request; browserUrl(req.url);
              const redirects = event.redirectedRequestId ? (redirectCounts.get(event.redirectedRequestId) ?? 0) + 1 : 0;
              if (event.redirectedRequestId) redirectCounts.delete(event.redirectedRequestId);
              if (redirects > 5 || redirectCounts.size >= 1024) throw new BrowserError("denied");
              redirectCounts.set(event.requestId, redirects);
              // Only use bounded data already in the pause event; never fetch omitted bodies through CDP.
              const body = req.postData;
              if (req.hasPostData && body === undefined) throw new BrowserError("invalid");
              if (req.hasPostData && !/^(text\/plain|application\/(json|x-www-form-urlencoded))(;|$)/i.test(
                Object.entries(req.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "")) throw new BrowserError("invalid");
              if (body && Buffer.byteLength(body) > L.maxRequestBytes) throw new BrowserError("invalid");
              const result = await this.options.egress({ url: req.url, method: req.method, headers: req.headers,
                bodyB64: body ? Buffer.from(body).toString("base64") : undefined }, AbortSignal.any([session.abort.signal, AbortSignal.timeout(15_000)]));
              if (session.closed || Buffer.from(result.bodyB64, "base64").length > L.maxResponseBytes) throw new BrowserError("unavailable");
              await cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: result.status,
                responseHeaders: result.headers, body: result.bodyB64 });
              if (result.status < 300 || result.status >= 400) redirectCounts.delete(event.requestId);
            } catch { redirectCounts.delete(event.requestId); await fail(); }
            finally { session.requests--; }
          })().catch(() => { void this.dispose(session); });
        });
        await cdp.send("Network.enable", { maxPostDataSize: L.maxRequestBytes });
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
        signal?.throwIfAborted();
        browser.on("disconnected", () => { void this.dispose(session); });
        this.sessions.set(session.id, session);
        return { sessionId: session.id };
      } catch (err) { await browser.close(); throw err; }
    });
    const completed = task.finally(() => { this.pendingOpen--; });
    this.opening = completed.catch(() => {}); return completed;
  }
  find(scope: BrowserScope) {
    const s = [...this.sessions.values()].find(s => !s.closed && s.browser.isConnected() && scopeKey(s.scope) === scopeKey(scope));
    return s ? { sessionId: s.id } : null;
  }
  private get(id: string, scope: BrowserScope) {
    const s = this.sessions.get(id);
    if (!s || s.closed || !s.browser.isConnected() || scopeKey(s.scope) !== scopeKey(scope)) throw new BrowserError("denied");
    return s;
  }
  private serialize<T>(s: Session, fn: () => Promise<T>, signal?: AbortSignal, execute = true): Promise<T> {
    if (s.pending >= 4) return Promise.reject(new BrowserError("capacity"));
    s.pending++;
    const timeout = AbortSignal.timeout(L.actionTimeoutMs);
    const abort = AbortSignal.any([s.abort.signal, timeout, ...(signal ? [signal] : [])]);
    const task = s.chain.then(async () => {
      if (s.closed || abort.aborted) throw new BrowserError("denied");
      const work = fn();
      let onAbort: () => void;
      try {
        return await Promise.race([work, new Promise<never>((_ok, fail) => {
          onAbort = () => {
            // Viewer cancellation only ends its read; execute timeout/cancel stops pending actions.
            if (execute || timeout.aborted) void this.dispose(s);
            fail(new BrowserError("unavailable"));
          };
          abort.addEventListener("abort", onAbort, { once: true });
          if (abort.aborted) onAbort();
        })]);
      } finally {
        abort.removeEventListener("abort", onAbort!);
        // A viewer disconnect must not release the capture queue while screenshot is still running.
        if (!execute) await work.catch(() => {});
      }
    }).finally(() => { s.pending--; });
    s.chain = task.catch(() => {}); return task;
  }
  private clearRefs(s: Session) {
    for (const handle of s.refs.values()) void handle.dispose().catch(() => {});
    s.refs.clear();
  }
  async navigate(id: string, scope: BrowserScope, raw: string, signal?: AbortSignal) {
    const s = this.get(id, scope); const url = browserUrl(raw);
    return this.serialize(s, async () => {
      this.clearRefs(s); s.lastUsed = Date.now();
      await s.page.goto(url.href, { waitUntil: "domcontentloaded" });
      browserUrl(s.page.url()); return { title: safeText(await s.page.title(), 300) };
    }, signal);
  }
  async inspect(id: string, scope: BrowserScope, signal?: AbortSignal): Promise<BrowserInspection> {
    const s = this.get(id, scope);
    return this.serialize(s, async () => {
      s.lastUsed = Date.now(); this.clearRefs(s);
      // Fixed implementation script; no script/eval argument is accepted by tools or transport.
      const text = await s.page.evaluate(max => (document.body?.innerText ?? "").slice(0, max), L.maxText);
      const locator = s.page.locator("a[href],button,input:not([type=file]):not([type=password]):not([type=hidden]),textarea,select,[role=button]");
      const count = Math.min(await locator.count(), L.maxElements);
      const elements: BrowserInspection["elements"] = [];
      for (let i = 0; i < count; i++) {
        const handle = await locator.nth(i).elementHandle();
        if (!handle) continue;
        if (!await handle.isVisible()) { await handle.dispose(); continue; }
        const info = await handle.evaluate(el => ({ role: (el.getAttribute("role") ?? el.tagName.toLowerCase()).slice(0, 40),
          name: (el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 160), type: (el.getAttribute("type") ?? "").slice(0, 40) }));
        if (info.type === "password" || info.type === "file") { await handle.dispose(); continue; }
        const ref = token(12); s.refs.set(ref, handle);
        elements.push({ ref, role: safeText(info.role, 40), name: safeText(info.name, 160) });
      }
      return { text: safeText(text, L.maxText), elements };
    }, signal);
  }
  async act(id: string, scope: BrowserScope, raw: BrowserAction, signal?: AbortSignal) {
    const s = this.get(id, scope); const action = parseAction(raw);
    return this.serialize(s, async () => {
      s.lastUsed = Date.now();
      if (action.kind === "scroll") {
        await s.page.mouse.wheel(0, action.pixels * (action.direction === "up" ? -1 : 1)); return;
      }
      const handle = s.refs.get(action.ref);
      if (!handle || !await handle.evaluate(el => el.isConnected).catch(() => false)) throw new BrowserError("stale_ref");
      const forbidden = await handle.evaluate(el => {
        const input = el as HTMLInputElement;
        return input.tagName === "INPUT" && ["password", "file", "hidden"].includes(input.type);
      });
      if (forbidden) throw new BrowserError("denied");
      if (action.kind === "type") await handle.fill(action.text);
      else {
        const href = await handle.getAttribute("href"); if (href) browserUrl(new URL(href, s.page.url()).href);
        await handle.click();
      }
      this.clearRefs(s);
    }, signal);
  }
  status(id: string, scope: BrowserScope) {
    const s = this.get(id, scope);
    return { state: Date.now() - s.lastUsed < 10_000 ? "active" : "idle", viewOnly: true, lastFrameAt: s.frame?.capturedAt ?? null };
  }
  subscribe(id: string, scope: BrowserScope) {
    const s = this.get(id, scope); this.expireLeases(s);
    if (s.leases.size >= L.maxSubscribers) throw new BrowserError("capacity");
    const leaseId = token(); s.leases.set(leaseId, Date.now()); return { leaseId };
  }
  unsubscribe(id: string, scope: BrowserScope, leaseId: string) { this.get(id, scope).leases.delete(leaseId); }
  private expireLeases(s: Session) { for (const [id, at] of s.leases) if (Date.now() - at >= L.subscriberTtlMs) s.leases.delete(id); }
  async frame(id: string, scope: BrowserScope, leaseId: string, signal?: AbortSignal): Promise<BrowserFrame> {
    const s = this.get(id, scope); this.expireLeases(s);
    if (!s.leases.has(leaseId)) throw new BrowserError("denied");
    s.leases.set(leaseId, Date.now());
    return this.serialize(s, async () => {
      if (s.frame && Date.now() - Date.parse(s.frame.capturedAt) < L.frameIntervalMs) return s.frame;
      const bytes = await s.page.screenshot({ type: "jpeg", quality: 50, timeout: L.actionTimeoutMs });
      if (bytes.length > L.frameBytes) throw new BrowserError("unavailable", "Browser frame exceeded limit");
      s.frame = { sequence: ++s.sequence, capturedAt: new Date().toISOString(), contentType: "image/jpeg", bytes: new Uint8Array(bytes), width: L.width, height: L.height };
      return s.frame;
    }, signal, false);
  }
  async close(id: string, scope: BrowserScope) { await this.dispose(this.get(id, scope)); }
  private async dispose(s: Session) {
    if (s.closed) return;
    s.closed = true; this.sessions.delete(s.id); s.leases.clear(); s.frame = null;
    s.abort.abort(); this.clearRefs(s); await s.browser.close().catch(() => {});
  }
  async sweep(now = Date.now()) {
    await Promise.all([...this.sessions.values()].filter(s => now - s.lastUsed >= (this.options.idleMs ?? 5 * 60_000)).map(s => this.dispose(s)));
  }
  async shutdown() { await this.opening; await Promise.all([...this.sessions.values()].map(s => this.dispose(s))); }
}
