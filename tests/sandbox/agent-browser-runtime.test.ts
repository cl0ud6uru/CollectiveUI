/** Actual Chromium + synthetic routed pages; no accounts, paid tools, or external network requests. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "@/agent-browserd/runtime";
import { createBrowserServer } from "@/agent-browserd/server";
import { PrivateBrowserProvider } from "@/lib/agent-browser/provider";
import { BROWSER_LIMITS, type BrowserFrame, type BrowserScope } from "@/lib/agent-browser/provider-contract";
import { signedCall } from "@/agent-browserd/transport";
import type { EgressRequest, EgressResponse } from "@/agent-browserd/network";
import { agentBrowserTools } from "@/lib/agent/tools/agent-browser";
import type { AgentCtx } from "@/lib/agent/types";
import type { RuntimeBrowserSource } from "@/lib/agent-browser/sessions";

// Database admission is separately tested; this fixture tests the admitted tool-to-provider-to-page path.
vi.mock("@/lib/agent-browser/admission", () => ({ assertBrowserAdmission: vi.fn(async () => {}) }));
const enabled = process.env.AGENT_BROWSER_RUNTIME_TEST === "1";
const unsandboxedFixture = process.env.AGENT_BROWSER_TEST_UNSANDBOXED === "1";
const scope: BrowserScope = { ownerUserId: "owner-a", botId: "bot-a", runId: "run-a", conversationId: "conversation-a", workspaceInstanceId: null };
const secret = "synthetic-test-only-browser-".repeat(2);
const html = `<!doctype html><html><head><title>Synthetic page</title></head><body style="background:rgb(200,20,20)">
<h1>Before</h1><button onclick="document.body.style.background='rgb(20,200,20)';document.querySelector('h1').textContent='After';document.cookie='private=owner-a'">Change</button>
<input aria-label="Message"><input type="password"><input type="file">
<a href="/next">Next</a><a href="http://169.254.169.254/latest/meta-data">Blocked</a></body></html>`;
const pageResponse = (body: string): EgressResponse => ({ status: 200, headers: [{ name: "content-type", value: "text/html" }], bodyB64: Buffer.from(body).toString("base64") });
const cookieHeader = (req: EgressRequest) => Object.entries(req.headers).find(([k]) => k.toLowerCase() === "cookie")?.[1];
async function pixel(frame: BrowserFrame) {
  const { data, info } = await sharp(frame.bytes).raw().toBuffer({ resolveWithObject: true });
  const offset = (500 * info.width + 800) * info.channels;
  return [...data.subarray(offset, offset + 3)];
}

describe.skipIf(!enabled)("actual private agent browser runtime", () => {
  let runtime: BrowserRuntime; let server: ReturnType<typeof createBrowserServer>;
  let dir: string; let socket: string; let provider: PrivateBrowserProvider;
  let launched: Browser[]; let requests: EgressRequest[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "browser-real-")); socket = join(dir, "broker.sock"); launched = []; requests = [];
    runtime = new BrowserRuntime({ idleMs: 30_000, maxPerOwner: 2, egress: async (req, signal) => {
      requests.push(req);
      if (new URL(req.url).hostname !== "fixture.example" && new URL(req.url).hostname !== "other.example") throw new Error("Synthetic pages only");
      if (req.url.endsWith("/redirect")) return { status: 302, headers: [{ name: "location", value: "https://other.example/landing" },
        { name: "set-cookie", value: "private=fixture; Path=/; HttpOnly" }, { name: "set-cookie", value: "second=retained; Path=/; HttpOnly" }], bodyB64: "" };
      if (req.url.endsWith("/landing")) return pageResponse(`<h1>${cookieHeader(req) ?? "no-cookie"}</h1>`);
      if (req.url.endsWith("/next")) return pageResponse("<h1>Next page</h1>");
      if (req.url.endsWith("/embedded")) return pageResponse('<h1>Parent</h1><iframe src="https://other.example/embedded-child"></iframe>');
      if (req.url.endsWith("/embedded-child")) return pageResponse("<h1>Child</h1>");
      if (req.url.endsWith("/post")) return pageResponse(`<h1>Waiting</h1>
        <button onclick="fetch('/small-post',{method:'POST',body:'abc',headers:{'Content-Type':'text/plain'}}).catch(()=>{})">Small post</button>
        <button onclick="fetch('/large-post',{method:'POST',body:'x'.repeat(2097152),headers:{'Content-Type':'text/plain'}}).catch(()=>document.querySelector('h1').textContent='Large blocked')">Large post</button>`);
      if (req.url.endsWith("/slow")) return new Promise((_ok, fail) => {
        const stop = () => fail(new Error("Synthetic request cancelled"));
        signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
      });
      return pageResponse(html);
    }, launch: async () => {
      const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium", chromiumSandbox: !unsandboxedFixture });
      launched.push(browser); return browser;
    } });
    server = createBrowserServer(runtime, secret);
    await new Promise<void>(resolve => server.listen(socket, resolve));
    provider = new PrivateBrowserProvider(socket, secret, async () => {});
  });
  afterEach(async () => {
    await runtime.shutdown(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done())); await rm(dir, { recursive: true, force: true });
  });
  it("native agent tools navigate/click the exact private viewer frame page", async () => {
    let source: RuntimeBrowserSource | undefined;
    const ctx = { principal: { user: { id: scope.ownerUserId } }, bot: { id: scope.botId }, conversationId: scope.conversationId, usage: { runId: scope.runId } } as unknown as AgentCtx;
    const tools = await agentBrowserTools(ctx, { workspace: null, provider, registerSource: s => { source = s; } });
    const execute = async (name: string, input: unknown) => {
      const entry = tools.entries.find(e => e.name === name)!;
      return await (entry.tool.execute as (input: unknown, options: object) => Promise<unknown>)(input, { toolCallId: "fixture", messages: [], abortSignal: new AbortController().signal });
    };
    await execute("browser_navigate", { url: "https://fixture.example/start" });
    expect(source).toBeDefined(); expect(launched).toHaveLength(1);
    const abort = new AbortController(); const frames = source!.subscribeFrames(abort.signal)[Symbol.asyncIterator]();
    const before = (await frames.next()).value as BrowserFrame;
    expect(before.bytes.length).toBeLessThanOrEqual(BROWSER_LIMITS.frameBytes);
    expect(await pixel(before)).toEqual(expect.arrayContaining([expect.any(Number)]));
    const beforePixel = await pixel(before); expect(beforePixel[0]).toBeGreaterThan(150); expect(beforePixel[1]).toBeLessThan(60);
    const inspection = await execute("browser_inspect", {}) as { text: string; elements: { ref: string; name: string }[] };
    expect(inspection.text).toContain("Before"); expect(inspection.elements).toHaveLength(4);
    const button = inspection.elements.find(e => e.name === "Change")!;
    await execute("browser_act", { action: { kind: "click", ref: button.ref } });
    const after = (await frames.next()).value as BrowserFrame;
    expect(after.sequence).toBeGreaterThan(before.sequence); expect(after.bytes).not.toEqual(before.bytes);
    const afterPixel = await pixel(after); expect(afterPixel[1]).toBeGreaterThan(150); expect(afterPixel[0]).toBeLessThan(60);
    expect((await execute("browser_inspect", {}) as { text: string }).text).toContain("After");
    expect(launched).toHaveLength(1); // Capture never creates an unrelated page/context/browser.
    expect(launched[0].contexts()[0].pages()).toHaveLength(1);
    abort.abort(); await frames.return?.();
    expect(await provider.status(source!.sessionId)).toBe("active"); // Viewer close doesn't stop agent.
    await tools.close(); expect(launched[0].isConnected()).toBe(false);
  });
  it("isolates owner processes/cookies and denies every spoofed scope selector", async () => {
    const a = await provider.open(scope);
    const bScope = { ...scope, ownerUserId: "owner-b" }; const b = await provider.open(bScope);
    await provider.navigate(a.sessionId, "https://fixture.example/start");
    const inspection = await provider.inspect(a.sessionId); const change = inspection.elements.find(e => e.name === "Change")!;
    await provider.act(a.sessionId, { kind: "click", ref: change.ref });
    await provider.navigate(b.sessionId, "https://fixture.example/start");
    expect(launched).toHaveLength(2); expect(launched[0]).not.toBe(launched[1]);
    expect(await launched[0].contexts()[0].cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "private", value: "owner-a" })]));
    expect(await launched[1].contexts()[0].cookies()).toEqual([]);
    for (const key of ["ownerUserId", "botId", "runId", "conversationId", "workspaceInstanceId"])
      for (const op of ["status", "subscribe", "inspect", "close"])
        expect((await signedCall(socket, secret, `/v1/browser/sessions/${a.sessionId}/${op}`, { scope: { ...scope, [key]: "spoof" } }, 1024)).status).toBe(403);
    await expect(provider.act(a.sessionId, { kind: "click", ref: change.ref })).rejects.toThrow();
  });
  it("keeps redirect origin/cookies correct, refuses private destinations and never provides local input refs", async () => {
    const { sessionId } = await provider.open(scope);
    await provider.navigate(sessionId, "https://fixture.example/redirect");
    expect(launched[0].contexts()[0].pages()[0].url()).toBe("https://other.example/landing");
    expect(cookieHeader(requests.find(r => r.url.endsWith("/landing"))!)).toBeUndefined();
    expect((await provider.inspect(sessionId)).text).toBe("no-cookie");
    await provider.navigate(sessionId, "https://fixture.example/start");
    expect(cookieHeader(requests.findLast(r => r.url.endsWith("/start"))!)).toContain("private=fixture");
    expect(cookieHeader(requests.findLast(r => r.url.endsWith("/start"))!)).toContain("second=retained");
    const inspection = await provider.inspect(sessionId); const blocked = inspection.elements.find(e => e.name === "Blocked")!;
    await expect(provider.act(sessionId, { kind: "click", ref: blocked.ref })).rejects.toThrow();
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/", "file:///etc/passwd", "data:text/html,bad"])
      await expect(provider.navigate(sessionId, url)).rejects.toThrow();
    expect(requests.every(r => !r.url.includes("169.254") && !r.url.includes("127.0.0.1"))).toBe(true);
  });
  it("bounds subscribers/processes, opens idempotently, and closes idle/restarted profiles", async () => {
    const opened = await Promise.all([provider.open(scope), provider.open(scope)]);
    expect(opened[0]).toEqual(opened[1]); expect(launched).toHaveLength(1);
    const id = opened[0].sessionId;
    for (let i = 0; i < 2; i++) expect((await signedCall(socket, secret, `/v1/browser/sessions/${id}/subscribe`, { scope }, 1024)).status).toBe(200);
    expect((await signedCall(socket, secret, `/v1/browser/sessions/${id}/subscribe`, { scope }, 1024)).status).toBe(429);
    await expect(provider.open({ ...scope, runId: "run-b" })).rejects.toThrow();
    await runtime.sweep(Date.now() + 60_000);
    expect(launched[0].isConnected()).toBe(false); expect(await provider.find(scope)).toBeNull();
    const reopened = await provider.open(scope); expect(reopened.sessionId).not.toBe(id);
    await provider.navigate(reopened.sessionId, "https://fixture.example/start");
    expect(await launched[1].contexts()[0].cookies()).toEqual([]);
    await runtime.shutdown(); expect(await provider.find(scope)).toBeNull();
  });
  it("mediates cross-origin embedded documents and stops a cancelled native request", async () => {
    const { sessionId } = await provider.open(scope);
    await provider.navigate(sessionId, "https://fixture.example/embedded");
    expect(requests.some(r => r.url.endsWith("/embedded-child"))).toBe(true);
    const abort = new AbortController(); const pending = provider.navigate(sessionId, "https://fixture.example/slow", abort.signal);
    await vi.waitFor(() => { expect(requests.some(r => r.url.endsWith("/slow"))).toBe(true); });
    abort.abort(); await expect(pending).rejects.toThrow();
    await vi.waitFor(() => { expect(launched[0].isConnected()).toBe(false); });
  });
  it("forwards small text POSTs and blocks oversized browser-generated bodies before egress", async () => {
    const { sessionId } = await provider.open(scope);
    await provider.navigate(sessionId, "https://fixture.example/post");
    const small = (await provider.inspect(sessionId)).elements.find(e => e.name === "Small post")!;
    await provider.act(sessionId, { kind: "click", ref: small.ref });
    await vi.waitFor(() => expect(requests.some(r => r.url.endsWith("/small-post"))).toBe(true));
    expect(Buffer.from(requests.find(r => r.url.endsWith("/small-post"))!.bodyB64!, "base64").toString()).toBe("abc");
    const large = (await provider.inspect(sessionId)).elements.find(e => e.name === "Large post")!;
    await provider.act(sessionId, { kind: "click", ref: large.ref });
    await vi.waitFor(async () => expect((await provider.inspect(sessionId)).text).toContain("Large blocked"));
    expect(requests.some(r => r.url.endsWith("/large-post"))).toBe(false);
  });
});
