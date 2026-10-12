import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserError, parseAction, parseScope, type BrowserScope } from "@/lib/agent-browser/provider-contract";
import { AgentBrowserSessions, browserSource } from "@/lib/agent-browser/sessions";
import { PrivateBrowserProvider, configuredBrowserProvider } from "@/lib/agent-browser/provider";
import { browserUrl, fetchPublic, publicAddress, publicDestination } from "@/agent-browserd/network";
import { assertBrowserIsolation } from "@/agent-browserd/index";
import { createBrowserServer } from "@/agent-browserd/server";
import type { BrowserRuntime } from "@/agent-browserd/runtime";
import { signRequest } from "@/sandboxd/protocol/auth";
import { signedCall } from "@/agent-browserd/transport";

const scope: BrowserScope = { ownerUserId: "owner-a", botId: "bot-a", runId: "run-a", conversationId: "conversation-a", workspaceInstanceId: null };
const secret = "synthetic-browser-secret-".repeat(2);
afterEach(() => vi.restoreAllMocks());

describe("private browser contract", () => {
  it("rejects extra owner/profile/script/credential claims and only accepts bounded native actions", () => {
    expect(parseScope(scope)).toEqual(scope);
    expect(() => parseScope({ ...scope, owner: "other" })).toThrow(BrowserError);
    expect(() => parseScope({ ...scope, workspaceInstanceId: "/home/agent" })).toThrow();
    expect(parseAction({ kind: "click", ref: "a".repeat(24) })).toEqual({ kind: "click", ref: "a".repeat(24) });
    for (const bad of [{ kind: "eval", script: "alert(1)" }, { kind: "click", ref: "body" },
      { kind: "click", ref: "a".repeat(24), cookie: "secret" }, { kind: "type", ref: "a".repeat(24), text: "x".repeat(4001) },
      { kind: "scroll", direction: "down", pixels: 2001 }]) expect(() => parseAction(bad)).toThrow();
  });
  it("binds opaque sessions immutably and exposes only view closures", () => {
    const sessions = new AgentBrowserSessions(); const id = "a".repeat(32);
    sessions.bind(id, scope);
    expect(() => sessions.bind(id, { ...scope, ownerUserId: "owner-b" })).toThrow();
    expect(() => sessions.scope("b".repeat(32))).toThrow();
    const copy = sessions.scope(id); copy.ownerUserId = "owner-b";
    expect(sessions.scope(id)).toEqual(scope);
    const provider = { status: vi.fn(), subscribeFrames: vi.fn() } as unknown as PrivateBrowserProvider;
    const source = browserSource(provider, scope, id);
    expect(Object.keys(source).sort()).toEqual([...Object.keys(scope), "sessionId", "status", "subscribeFrames"].sort());
    source.status(); expect(provider.status).toHaveBeenCalledWith(id);
  });
  it("has no default provider and rejects missing isolation, root and external interfaces", () => {
    expect(configuredBrowserProvider(async () => {}, {})).toBeNull();
    expect(() => configuredBrowserProvider(async () => {}, { AGENT_BROWSER_ENABLED: "1" })).toThrow();
    const env = { AGENT_BROWSERD_ENABLED: "1", AGENT_BROWSERD_ISOLATION: "network-none" };
    expect(() => assertBrowserIsolation(env, {}, 1000)).not.toThrow();
    expect(() => assertBrowserIsolation(env, {}, 0)).toThrow();
    expect(() => assertBrowserIsolation({}, {}, 1000)).toThrow();
    expect(() => assertBrowserIsolation(env, { eth0: [{ internal: false } as never] }, 1000)).toThrow();
  });
});

describe("browser egress policy", () => {
  it.each(["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.1.1", "192.168.0.1", "100.100.100.200", "169.254.169.254",
    "198.18.1.1", "224.0.0.1", "255.255.255.255", "192.0.2.4", "::", "::1", "fc00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "2001::1"])("blocks %s", ip => {
    expect(publicAddress(ip)).toBe(false);
  });
  it("allows public IPv4 and IPv6 only, and rejects unsafe schemes/ports/credentials/normalized addresses", async () => {
    expect(publicAddress("8.8.8.8")).toBe(true); expect(publicAddress("2606:4700::1111")).toBe(true);
    expect(publicAddress("2001:4860:4860::8888")).toBe(true);
    for (const url of ["file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "https://localhost/", "http://2130706433/",
      "https://user:password@example.com/", "https://example.com:444/", "http://metadata.google.internal/", "http://[::ffff:127.0.0.1]/"])
      expect(() => browserUrl(url)).toThrow();
    await expect(publicDestination("https://example.com/", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.1.1.1", family: 4 }])).rejects.toThrow();
  });
  function mockRequest(status = 200, headers: Record<string, string> = {}, rawHeaders: string[] = ["content-type", "text/html"]) {
    const request = vi.spyOn(http, "request").mockImplementation(((_url: URL, opts: http.RequestOptions, callback: (r: http.IncomingMessage) => void) => {
      const req = new EventEmitter() as http.ClientRequest;
      req.destroy = vi.fn(e => { queueMicrotask(() => req.emit("error", e)); return req; });
      req.end = vi.fn(() => {
        queueMicrotask(() => {
          const res = new EventEmitter() as http.IncomingMessage;
          res.statusCode = status; res.headers = headers; res.rawHeaders = rawHeaders;
          callback(res); res.emit("data", Buffer.from("synthetic")); res.emit("end");
        });
        return req;
      }) as never;
      return req;
    }) as never);
    return request;
  }
  it("pins a validated DNS answer instead of resolving again; preserves original Host/TLS semantics and cookie headers", async () => {
    const request = mockRequest(); const dns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const result = await fetchPublic({ url: "http://example.com/", method: "GET", headers: { Cookie: "private=owner-a", Host: "169.254.169.254", "Proxy-Authorization": "secret" } }, new AbortController().signal, dns);
    expect(result.status).toBe(200); expect(dns).toHaveBeenCalledTimes(1);
    const args = request.mock.calls[0] as unknown as [URL, http.RequestOptions];
    expect(args[0].hostname).toBe("example.com"); expect(args[1].agent).toBe(false);
    expect(args[1].headers).toEqual({ Cookie: "private=owner-a", "accept-encoding": "identity" });
    const callback = vi.fn(); (args[1].lookup as unknown as (a: string, b: object, c: typeof callback) => void)("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4); expect(dns).toHaveBeenCalledTimes(1);
  });
  it("denies redirected private destinations and preserves allowed redirects without forwarding cookies to another origin", async () => {
    const dns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    mockRequest(302, { location: "http://169.254.169.254/latest/meta-data" });
    await expect(fetchPublic({ url: "http://example.com/", method: "GET", headers: {} }, new AbortController().signal, dns)).rejects.toThrow();
    vi.restoreAllMocks(); const request = mockRequest(302, { location: "https://other.example/" }, ["Location", "https://other.example/", "Set-Cookie", "a=b", "Set-Cookie", "c=d"]);
    const result = await fetchPublic({ url: "http://example.com/", method: "GET", headers: { Cookie: "owner=a" } }, new AbortController().signal, dns);
    expect(result.status).toBe(302); expect(request).toHaveBeenCalledTimes(1);
    expect(result.headers.filter(h => h.name === "Set-Cookie")).toHaveLength(2);
  });
  it("aborts unresolved DNS and refuses oversized input", async () => {
    const abort = new AbortController();
    const pending = fetchPublic({ url: "https://example.com/", method: "GET", headers: {} }, abort.signal, () => new Promise(() => {}));
    abort.abort(); await expect(pending).rejects.toThrow();
    await expect(fetchPublic({ url: "https://example.com/", method: "CONNECT", headers: {} }, new AbortController().signal, async () => [{ address: "8.8.8.8", family: 4 }])).rejects.toThrow();
  });
});

describe("authenticated broker and read-only provider", () => {
  it("rejects unsigned/tampered/replayed and spoofed scope; read-only calls never open a browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-unit-")); const socket = join(dir, "broker.sock");
    const id = "a".repeat(32); let current = false;
    const fake = {
      open: vi.fn(async () => { current = true; return { sessionId: id }; }),
      find: vi.fn((s: BrowserScope) => current && s.ownerUserId === scope.ownerUserId ? { sessionId: id } : null),
      status: vi.fn((_id: string, s: BrowserScope) => { if (JSON.stringify(s) !== JSON.stringify(scope)) throw new BrowserError("denied"); return { state: "idle" }; }),
      close: vi.fn(async () => { current = false; }),
    } as unknown as BrowserRuntime;
    const server = createBrowserServer(fake, secret);
    await new Promise<void>(done => server.listen(socket, done));
    const raw = (body: string, headers: Record<string, string>) => new Promise<number>(done => {
      const req = http.request({ socketPath: socket, path: "/v1/browser/open", method: "POST", headers }, res => { res.resume(); res.on("end", () => done(res.statusCode!)); }); req.end(body);
    });
    try {
      const authorizer = vi.fn(async () => {}); const provider = new PrivateBrowserProvider(socket, secret, authorizer);
      expect(await provider.find(scope)).toBeNull(); expect(fake.open).not.toHaveBeenCalled();
      const body = JSON.stringify({ scope }); const headers = signRequest(secret, { path: "/v1/browser/open", method: "POST", body });
      expect(await raw(body, {})).toBe(401);
      expect(await raw(JSON.stringify({ scope: { ...scope, ownerUserId: "owner-b" } }), headers)).toBe(401);
      expect(await raw(body, headers)).toBe(200); expect(await raw(body, headers)).toBe(401);
      const spoof = await signedCall(socket, secret, `/v1/browser/sessions/${id}/status`, { scope: { ...scope, runId: "run-b" } }, 1024);
      expect(spoof.status).toBe(403);
      const viewer = new PrivateBrowserProvider(socket, secret, authorizer, "view");
      await viewer.find(scope); expect(await viewer.status(id)).toBe("idle");
      await expect(viewer.open(scope)).rejects.toThrow(); await expect(viewer.navigate(id, "https://example.com")).rejects.toThrow(); await expect(viewer.close(id)).rejects.toThrow();
      await provider.find(scope); authorizer.mockRejectedValue(new BrowserError("denied"));
      await expect(provider.status(id)).rejects.toThrow();
      await provider.close(id); expect(fake.close).toHaveBeenCalled();
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(dir, { recursive: true, force: true }); }
  });
});
