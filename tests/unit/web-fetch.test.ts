import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isPrivateAddress, webTools } from "@/lib/agent/tools/web";

type Reply = { status?: number; headers?: Record<string, string>; body?: string; error?: Error };
let replies: Reply[];
const connections: { url: URL; options: RequestOptions; address: string }[] = [];
function request(url: URL, options: RequestOptions, respond: (res: Readable) => void) {
  const reply = replies.shift() ?? { body: "public page" };
  const req = new EventEmitter() as EventEmitter & { end: () => void };
  req.end = () => {
    options.lookup!(url.hostname, {}, (_err, address) => {
      connections.push({ url, options, address: address as string });
      queueMicrotask(() => {
        if (reply.error) return void req.emit("error", reply.error);
        const response = Object.assign(Readable.from([Buffer.from(reply.body ?? "")]), { statusCode: reply.status ?? 200, headers: reply.headers ?? { "content-type": "text/plain" } });
        respond(response);
      });
    });
  };
  return req;
}
const call = (url = "https://public.test/page", allowlist: string[] = [], abortSignal?: AbortSignal) =>
  Promise.resolve(webTools({ toolSettings: { fetchAllowlist: allowlist } } as unknown as AgentCtx).fetch_url.tool.execute!(
    { url }, { toolCallId: "t", messages: [], context: undefined, abortSignal },
  ));

beforeEach(() => {
  replies = [];
  connections.length = 0;
  vi.mocked(lookup).mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  vi.mocked(httpRequest).mockReset().mockImplementation(request as never);
  vi.mocked(httpsRequest).mockReset().mockImplementation(request as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("web fetch destination binding", () => {
  it("connects only to the validated address even if subsequent DNS would return loopback", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    const unpinned = vi.fn(async () => new Response("synthetic internal secret"));
    vi.stubGlobal("fetch", unpinned);
    replies.push({ body: "public page" });
    expect(await call()).toMatchObject({ content: "public page" });
    expect(unpinned).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connections[0]).toMatchObject({ address: "93.184.216.34", options: { agent: false, family: 4 } });
    // Passing the hostname URL unchanged preserves HTTP Host and HTTPS SNI/certificate verification.
    expect(connections[0].url.hostname).toBe("public.test");
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });
  it("revalidates and pins every public redirect", async () => {
    replies.push({ status: 302, headers: { location: "https://other.test/next" } }, { body: "second page" });
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never);
    expect(await call()).toMatchObject({ content: "second page", url: "https://other.test/next" });
    expect(connections.map(c => c.address)).toEqual(["93.184.216.34", "8.8.8.8"]);
  });
  it("blocks redirect to private DNS and direct mapped IPv6 before opening a socket", async () => {
    replies.push({ status: 302, headers: { location: "http://private.test/" } });
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "::ffff:7f00:1", family: 6 }] as never);
    await expect(call()).rejects.toThrow("Private network");
    expect(connections).toHaveLength(1);
    await expect(call("http://[::ffff:127.0.0.1]/")).rejects.toThrow("Private network");
    expect(connections).toHaveLength(1);
  });
  it("rejects mixed public/private DNS answers", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] as never);
    await expect(call()).rejects.toThrow("Private network");
    expect(connections).toHaveLength(0);
  });
  it("preserves explicitly approved internal hosts and enforces the allowlist after redirect", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "10.0.0.1", family: 4 }] as never);
    replies.push({ body: "approved local docs" });
    expect(await call("http://docs.corp.test/", ["corp.test"])).toMatchObject({ content: "approved local docs" });
    replies.push({ status: 302, headers: { location: "https://evilcorp.test/" } });
    await expect(call("http://docs.corp.test/", ["corp.test"])).rejects.toThrow("allowlist");
    expect(connections).toHaveLength(2);
  });
  it("handles public IPv6 and normalized public mapped IPv6", async () => {
    for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8"]) {
      replies.push({ body: "IPv6 page" });
      expect(await call(`https://[${ip}]/`)).toMatchObject({ content: "IPv6 page" });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(connections.every(c => c.options.family === 6)).toBe(true);
  });
  it("bounds redirects, body size, and treats unsupported content as unreadable", async () => {
    replies.push(...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/again" } })));
    await expect(call()).rejects.toThrow("Too many redirects");
    replies.push({ body: "x".repeat(2_000_001) });
    await expect(call()).rejects.toThrow("2 MB");
    replies.push({ headers: { "content-type": "image/png" }, body: "synthetic binary" });
    expect(await call()).toMatchObject({ error: expect.stringContaining("image/png") });
  });
  it("turns nonstandard HTTP status and socket errors into tool errors", async () => {
    replies.push({ status: 600 });
    await expect(call()).rejects.toThrow("Invalid HTTP response status");
    replies.push({ error: new Error("socket failed") });
    await expect(call()).rejects.toThrow("socket failed");
  });
  it("refuses aborted requests, missing DNS answers and unsupported protocols", async () => {
    await expect(call("https://public.test/", [], AbortSignal.abort())).rejects.toThrow();
    vi.mocked(lookup).mockResolvedValue([] as never);
    await expect(call()).rejects.toThrow("no addresses");
    await expect(call("file:///etc/hosts")).rejects.toThrow("http(s)");
    expect(connections).toHaveLength(0);
  });
  it.each(["::ffff:7f00:1", "0:0:0:0:0:ffff:0a00:0001", "fe90::1", "ff02::1", "224.0.0.1", "0.0.0.0"])("blocks non-public %s", ip => expect(isPrivateAddress(ip)).toBe(true));
});
