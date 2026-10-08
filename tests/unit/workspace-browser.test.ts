import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserPath, previewFile, PREVIEW_BYTES } from "@/lib/sandbox/browser";
const f = vi.hoisted(() => ({ principal: vi.fn(), setting: vi.fn(), find: vi.fn(), list: vi.fn(), read: vi.fn(), state: vi.fn(), touch: vi.fn(), create: vi.fn(), exec: vi.fn(), audit: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: (e: { status?: number; message: string }) => Response.json({ error: e.message }, { status: e.status ?? 500 }) }));
vi.mock("@/lib/settings", () => ({ getSetting: f.setting }));
vi.mock("@/lib/audit", () => ({ audit: f.audit }));
vi.mock("@/lib/sandbox/store", () => ({ findSandbox: f.find, touchSandbox: f.touch, getOrCreateRef: f.create }));
vi.mock("@/lib/sandbox/client", async original => ({ ...await original<object>(), sandboxd: () => ({ listFiles: f.list, readFile: f.read, state: f.state, exec: f.exec, writeFile: f.write }) }));
import { GET } from "@/app/api/workspace/browser/route";
import { POST as terminal } from "@/app/api/workspace/terminal/route";
import { POST as upload } from "@/app/api/workspace/upload/route";
const get = (query: string) => new Request(`https://portal.test/api/workspace/browser?${query}`);
const run = (value: unknown = { command: "printf ready" }, origin = "https://portal.test") => new Request("https://portal.test/api/workspace/terminal", { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(value) });
beforeEach(() => {
  vi.clearAllMocks(); process.env.AUTH_URL = "https://portal.test";
  f.principal.mockResolvedValue({ user: { id: "owner", upn: "owner@test" }, groupIds: [], isAdmin: false });
  f.setting.mockResolvedValue({ enabled: true, access: "everyone", allowRunc: false, commandTimeoutSec: 120, outputKb: 32 });
  f.find.mockResolvedValue({ ref: "ownerworkspace" }); f.create.mockResolvedValue("ownerworkspace");
  f.list.mockResolvedValue({ entries: [{ path: "reports", type: "dir", size: 0 }, { path: "reports/summary.csv", type: "file", size: 20 }], truncated: false });
  f.read.mockResolvedValue({ bytes: Buffer.from("<script>alert(1)</script>"), size: 25, truncated: false });
  f.state.mockResolvedValue({ state: "running", runtime: "runsc", ref: "must-not-leak" });
  f.exec.mockImplementation(async (_ref, _req, options) => { options.onFrame({ t: "out", d: Buffer.from("ready\n").toString("base64") }); return { code: 0, reason: "exit" }; });
  f.write.mockResolvedValue({ bytes: 4, created: true });
});

describe("workspace browser ownership and passive reads", () => {
  it("returns only the owner's public status and never exposes a ref", async () => {
    const response = await GET(get("operation=status"));
    expect(await response.json()).toEqual({ allowed: true, configured: true, state: "running", runtime: "runsc" });
    expect(f.find).toHaveBeenCalledWith("owner"); expect(f.create).not.toHaveBeenCalled();
  });
  it("lists owner directories under the required isolation", async () => {
    await GET(get("operation=list&path=reports"));
    expect(f.list).toHaveBeenCalledWith("ownerworkspace", { path: "reports", isolation: "gvisor", depth: 1, maxEntries: 500 });
  });
  it("does not allocate a workspace for an empty browser", async () => {
    f.find.mockResolvedValue(null);
    expect(await (await GET(get("operation=list"))).json()).toEqual({ entries: [], truncated: false });
    expect(f.create).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });
  it("rejects traversal, extra ownership selectors and duplicate paths before a daemon call", async () => {
    for (const query of ["operation=preview&path=../secret", "operation=list&ref=someoneelse", "operation=list&userId=other", "operation=list&path=a&path=b", "operation=preview&path=/etc/passwd"])
      expect((await GET(get(query))).status).toBe(400);
    expect(f.list).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("returns inert JSON text for active HTML/SVG content, bounded to 256 KB", async () => {
    const response = await GET(get("operation=preview&path=drawing.svg"));
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).text).toContain("<script>");
    expect(f.read).toHaveBeenCalledWith("ownerworkspace", { isolation: "gvisor", path: "drawing.svg", maxBytes: PREVIEW_BYTES });
  });
  it("checks audience before file access, including for administrators outside an enabled rollout", async () => {
    f.setting.mockResolvedValue({ enabled: false });
    expect((await GET(get("operation=list"))).status).toBe(403);
    expect(f.find).not.toHaveBeenCalled();
  });
});
describe("direct terminal commands", () => {
  it("requires the configured same origin", async () => {
    expect((await terminal(run(undefined, "https://evil.test"))).status).toBe(403);
    expect(f.create).not.toHaveBeenCalled(); expect(f.exec).not.toHaveBeenCalled();
  });
  it("rejects client-controlled refs, cwd traversal and hard-denied commands", async () => {
    for (const value of [{ command: "ls", ref: "other" }, { command: "ls", cwd: "../" }, { command: "mkfs.ext4 /dev/sda" }]) expect((await terminal(run(value))).status).toBe(400);
    expect(f.exec).not.toHaveBeenCalled();
  });
  it("streams only the owner's command, applies limits and keeps command literals out of audit logs", async () => {
    const response = await terminal(run());
    expect(response.status).toBe(200);
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames[0]).toMatchObject({ type: "output", text: "ready\n" }); expect(frames.at(-1)).toMatchObject({ type: "exit", code: 0 });
    expect(f.create).toHaveBeenCalledWith("owner");
    expect(f.exec.mock.calls[0][0]).toBe("ownerworkspace");
    expect(f.exec.mock.calls[0][1]).toMatchObject({ isolation: "gvisor", cwd: ".", timeoutMs: 120000 });
    expect(f.exec.mock.calls[0][1].execId).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain("printf");
  });
  it("stops execution when the response reader cancels", async () => {
    let signal: AbortSignal | undefined;
    f.exec.mockImplementation((_ref, _req, options) => new Promise((_resolve, reject) => { signal = options.signal; signal!.addEventListener("abort", () => reject(new Error("stopped"))); }));
    const response = await terminal(run()); await response.body!.cancel(); expect(signal!.aborted).toBe(true);
  });
  it("preserves daemon gaps between head and tail without double-counting exit totals", async () => {
    f.exec.mockImplementation(async (_ref, _req, options) => {
      options.onFrame({ t: "out", d: Buffer.from("head\n").toString("base64") });
      options.onFrame({ t: "gap", s: "out", n: 100000 });
      options.onFrame({ t: "gap", s: "err", n: 25 });
      options.onFrame({ t: "out", d: Buffer.from("tail\n").toString("base64") });
      return { code: 0, reason: "exited", dropped: { out: 100000, err: 25 } };
    });
    const frames = (await (await terminal(run())).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames).toEqual([
      { type: "output", stream: "out", text: "head\n" },
      { type: "gap", stream: "out", bytes: 100000, source: "daemon" },
      { type: "gap", stream: "err", bytes: 25, source: "daemon" },
      { type: "output", stream: "out", text: "tail\n" },
      { type: "exit", code: 0, reason: "exited", truncated: true, dropped: { out: 100000, err: 25 }, limited: { out: 0, err: 0 } },
    ]);
  });
  it("reports omissions supplied only in daemon exit metadata", async () => {
    f.exec.mockResolvedValue({ code: 0, reason: "exited", dropped: { out: 20, err: 30 } });
    const frames = (await (await terminal(run())).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames.at(-1)).toMatchObject({ truncated: true, dropped: { out: 20, err: 30 }, limited: { out: 0, err: 0 } });
  });
  it("keeps gap information available when execution is interrupted before its exit", async () => {
    f.exec.mockImplementation(async (_ref, _req, options) => {
      options.onFrame({ t: "gap", s: "err", n: 120 });
      throw new Error("connection lost");
    });
    const frames = (await (await terminal(run())).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames[0]).toEqual({ type: "gap", stream: "err", bytes: 120, source: "daemon" });
    expect(frames.at(-1)).toMatchObject({ type: "error" });
  });
  it("does not report clipping for complete output exactly at the portal limit", async () => {
    f.exec.mockImplementation(async (_ref, _req, options) => {
      options.onFrame({ t: "out", d: Buffer.alloc(32 * 1024, 65).toString("base64") });
      return { code: 0, reason: "exited", dropped: { out: 0, err: 0 } };
    });
    const frames = (await (await terminal(run())).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames.filter(frame => frame.type === "gap")).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ truncated: false, dropped: { out: 0, err: 0 }, limited: { out: 0, err: 0 } });
  });
  it("counts portal clipping separately from daemon omissions across stdout and stderr", async () => {
    f.exec.mockImplementation(async (_ref, _req, options) => {
      options.onFrame({ t: "out", d: Buffer.alloc(32 * 1024 - 2, 65).toString("base64") });
      options.onFrame({ t: "err", d: Buffer.from("error").toString("base64") });
      options.onFrame({ t: "out", d: Buffer.from("tail").toString("base64") });
      return { code: 0, reason: "exited", dropped: { out: 100, err: 0 } };
    });
    const frames = (await (await terminal(run())).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(frames.filter(frame => frame.type === "output").map(frame => frame.text).join("").length).toBe(32 * 1024);
    expect(frames.filter(frame => frame.type === "gap")).toEqual([
      { type: "gap", stream: "err", bytes: 3, source: "limit" },
      { type: "gap", stream: "out", bytes: 4, source: "limit" },
    ]);
    expect(frames.at(-1)).toMatchObject({ truncated: true, dropped: { out: 100, err: 0 }, limited: { out: 4, err: 3 } });
  });
});
describe("uploads and previews", () => {
  it("preserves existing names by placing uploads in a fresh owner-local folder", async () => {
    const form = new FormData(); form.set("file", new File(["data"], "inventory.csv"));
    const response = await upload(new Request("https://portal.test/api/workspace/upload", { method: "POST", headers: { origin: "https://portal.test" }, body: form }));
    expect(response.status).toBe(200);
    const result = await response.json(); expect(result.path).toMatch(/^uploads\/[a-f0-9]{24}\/inventory.csv$/);
    expect(f.write).toHaveBeenCalledWith("ownerworkspace", { isolation: "gvisor", path: result.path, contentB64: "ZGF0YQ==" });
  });
  it("treats binary/invalid UTF-8 files as downloads and handles truncated UTF-8 without executing markup", () => {
    expect(previewFile("a", { bytes: new Uint8Array([0, 1]), size: 2, truncated: false }).binary).toBe(true);
    expect(previewFile("a", { bytes: new Uint8Array([255]), size: 1, truncated: false }).text).toBeNull();
    expect(previewFile("a", { bytes: new Uint8Array([65, 226]), size: 4, truncated: true }).text).toBe("A");
    expect(browserPath("../a")).toBeNull(); expect(browserPath(".", true)).toBe(".");
  });
});
