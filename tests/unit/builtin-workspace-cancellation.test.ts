import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
const h = vi.hoisted(() => ({ rows: new Map<unknown, unknown[]>(), blob: vi.fn() }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: (table: unknown) => {
  const q = { innerJoin: () => q, where: () => q, limit: async () => h.rows.get(table) ?? [],
    then: <T>(resolve: (rows: unknown[]) => T, reject: (error: unknown) => T) => Promise.resolve(h.rows.get(table) ?? []).then(resolve, reject) };
  return q;
} }) } }));
vi.mock("@/lib/files/storage", () => ({ storage: () => ({ get: h.blob }) }));
import { attachments, messages } from "@/db/schema";
import { PortalWorkspace } from "@/lib/sandbox/session";
import { SandboxdClient } from "@/lib/sandbox/client";
import { createServer } from "node:http";
import { workspaceTools } from "@/lib/agent/tools/workspace";
import { workspaceAttachmentTool } from "@/lib/agent/tools/workspace-attachment";
import type { SandboxSettings } from "@/lib/settings";

const settings = { enabled: true, allowRunc: false, commandTimeoutSec: 120, outputKb: 4 } as SandboxSettings;
const ctx = { principal: { user: { id: "fixture-owner" } }, conversationId: "fixture-chat" } as AgentCtx;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function environment(ref = async () => "fixture-sandbox") {
  const client = { writeFile: vi.fn<SandboxdClient["writeFile"]>(async () => ({ bytes: 7, created: true })), readFile: vi.fn(async () => null as { bytes: Buffer; size: number; truncated: boolean } | null) };
  const lookup = vi.fn(ref);
  const ws = new PortalWorkspace({ client: client as unknown as SandboxdClient, ref: lookup, isolation: "gvisor" });
  const invoke = (name: string, input: unknown, abortSignal: AbortSignal) => workspaceTools(ws, settings).find(t => t.name === name)!.tool.execute!(input, { toolCallId: "fixture-call", messages: [], context: undefined, abortSignal });
  const importAttachment = (abortSignal: AbortSignal) => workspaceAttachmentTool(ctx, ws).tool.execute!({ attachmentId: "fixtureFile" }, { toolCallId: "fixture-import", messages: [], context: undefined, abortSignal });
  return { client, lookup, ws, invoke, importAttachment };
}

beforeEach(() => {
  h.rows.clear(); h.blob.mockReset(); h.blob.mockResolvedValue(Buffer.from("fixture"));
  h.rows.set(attachments, [{ id: "fixtureFile", userId: "fixture-owner", filename: "fixture.txt", storageKey: "fixture-blob", size: 7 }]);
  h.rows.set(messages, [{ id: "fixture-message" }]);
});
describe("native workspace side-effect cancellation", () => {
  it("does not resolve or write a workspace after an already stopped write", async () => {
    const f = environment(), reason = new Error("fixture stopped");
    await expect(f.invoke("workspace_write", { path: "fixture.txt", content: "fixture" }, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it.each(["workspace_write", "workspace_edit"])("does not start a queued %s after Stop", async name => {
    const f = environment(), controller = new AbortController(), hold = deferred<void>();
    const reason = new Error("fixture stopped while queued");
    const held = f.ws.serialize(() => hold.promise);
    const input = name === "workspace_write" ? { path: "fixture.txt", content: "fixture" } : { path: "fixture.txt", old_string: "old", new_string: "new" };
    const result = f.invoke(name, input, controller.signal);
    controller.abort(reason); hold.resolve(); await held;
    await expect(result).rejects.toBe(reason);
    expect(f.client.readFile).not.toHaveBeenCalled(); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it("does not write after an edit read finishes following Stop", async () => {
    const f = environment(), controller = new AbortController(), read = deferred<{ bytes: Buffer; size: number; truncated: boolean }>(), started = deferred<void>();
    const reason = new Error("fixture stopped during read");
    f.client.readFile.mockImplementation(async () => { started.resolve(); return read.promise; });
    const result = f.invoke("workspace_edit", { path: "fixture.txt", old_string: "old", new_string: "new" }, controller.signal);
    await started.promise; controller.abort(reason); read.resolve({ bytes: Buffer.from("old"), size: 3, truncated: false });
    await expect(result).rejects.toBe(reason); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it("rechecks Stop after workspace reference resolution", async () => {
    const reference = deferred<string>(), started = deferred<void>(), controller = new AbortController();
    const reason = new Error("fixture stopped during resolution");
    const f = environment(async () => { started.resolve(); return reference.promise; });
    const result = f.ws.writeNow("fixture.txt", Buffer.from("fixture"), controller.signal);
    await started.promise; controller.abort(reason); reference.resolve("fixture-sandbox");
    await expect(result).rejects.toBe(reason); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it("passes the signal to a dispatched workspace write", async () => {
    const f = environment(), controller = new AbortController(), entered = deferred<void>();
    const reason = new Error("fixture stopped in flight");
    f.client.writeFile.mockImplementation((_ref, _request, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      entered.resolve(); signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const result = f.invoke("workspace_write", { path: "fixture.txt", content: "fixture" }, controller.signal);
    await entered.promise; controller.abort(reason);
    await expect(result).rejects.toBe(reason); expect(f.client.writeFile).toHaveBeenCalledTimes(1);
  });
  it("does not read blob bytes for an already canceled import", async () => {
    const f = environment(), reason = new Error("fixture stopped before import");
    await expect(f.importAttachment(AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(h.blob).not.toHaveBeenCalled(); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it("does not import a blob that finishes reading after Stop", async () => {
    const f = environment(), controller = new AbortController(), blob = deferred<Buffer>(), started = deferred<void>();
    const reason = new Error("fixture stopped during blob read");
    h.blob.mockImplementation(async () => { started.resolve(); return blob.promise; });
    const result = f.importAttachment(controller.signal);
    await started.promise; controller.abort(reason); blob.resolve(Buffer.from("fixture"));
    await expect(result).rejects.toBe(reason); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it("does not begin a queued import after Stop", async () => {
    const f = environment(), controller = new AbortController(), hold = deferred<void>(), loaded = deferred<void>();
    const reason = new Error("fixture stopped while import queued");
    const held = f.ws.serialize(() => hold.promise);
    h.blob.mockImplementation(async () => { loaded.resolve(); return Buffer.from("fixture"); });
    const result = f.importAttachment(controller.signal);
    await loaded.promise; controller.abort(reason); hold.resolve(); await held;
    await expect(result).rejects.toBe(reason); expect(f.client.writeFile).not.toHaveBeenCalled();
  });
  it("keeps an acknowledged write successful if Stop follows its effect", async () => {
    const f = environment(), controller = new AbortController();
    f.client.writeFile.mockImplementation(async () => { controller.abort(); return { bytes: 7, created: true }; });
    await expect(f.invoke("workspace_write", { path: "fixture.txt", content: "fixture" }, controller.signal)).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(f.client.writeFile).toHaveBeenCalledTimes(1);
  });

  it("closes a real in-flight sandbox write HTTP request on Stop without retrying it", async () => {
    const entered = deferred<void>(), disconnected = deferred<void>();
    let attempts = 0;
    const server = createServer((request, response) => {
      attempts++; request.resume();
      response.on("close", () => disconnected.resolve());
      entered.resolve();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const client = new SandboxdClient({ url: `http://127.0.0.1:${address.port}`, secret: "synthetic-control-secret-not-a-live-key" });
    const controller = new AbortController();
    try {
      const result = client.writeFile("fixture-sandbox", { isolation: "gvisor", path: "fixture.txt", contentB64: Buffer.from("fixture").toString("base64") }, controller.signal);
      await entered.promise;
      controller.abort(new Error("fixture stopped HTTP write"));
      await expect(result).rejects.toThrow();
      await disconnected.promise;
      expect(attempts).toBe(1);
    } finally {
      controller.abort(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
