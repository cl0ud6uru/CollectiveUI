import { describe, expect, it, vi } from "vitest";
import { execIdForToolCall, workspaceTools } from "@/lib/agent/tools/workspace";
import { SandboxError } from "@/lib/sandbox/client";
import type { PortalWorkspace, WorkspaceExec } from "@/lib/sandbox/session";
import type { SandboxSettings } from "@/lib/settings";
import type { Frame } from "@/sandboxd/protocol/frames";

const SETTINGS: SandboxSettings = {
  enabled: true,
  access: "everyone",
  allowedGroupIds: [],
  allowedUpns: [],
  allowRunc: false,
  commandTimeoutSec: 120,
  outputKb: 4,
  deleteAfterDays: 30,
};

type Exit = { t: "exit"; code: number; reason: string; ms: number; dropped: number };

/**
 * An in-memory workspace. Only workspace_bash may reach exec (the read-only and file tools must never run a shell),
 * so exec throws unless a test scripts it.
 */
function fakeWorkspace(files: Record<string, string | Uint8Array> = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v]));
  let chain: Promise<unknown> = Promise.resolve();
  const script: { frames: Frame[]; exit?: Exit; error?: unknown } = { frames: [] };
  const execs: WorkspaceExec[] = [];
  const ws = {
    serialize<T>(fn: () => Promise<T>) {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    },
    readRaw: vi.fn(async (path: string, maxBytes: number) => {
      const b = store.get(path);
      return b ? { bytes: b.slice(0, maxBytes), size: b.length, truncated: b.length > maxBytes } : null;
    }),
    writeNow: vi.fn(async (path: string, content: Uint8Array) => {
      const created = !store.has(path);
      store.set(path, content);
      return { bytes: content.length, created };
    }),
    writeRaw(path: string, content: Uint8Array) {
      return this.serialize(() => this.writeNow(path, content));
    },
    list: vi.fn(async () => ({
      entries: [
        { path: "src", type: "dir", size: 0 },
        { path: "src/a.ts", type: "file", size: 12 },
      ],
      truncated: false,
    })),
    grep: vi.fn(async () => ({ matches: [{ path: "src/a.ts", line: 3, text: "token sk-proj-abcdefghijklmnopqrstuvwxyz" }], truncated: false })),
    exec: vi.fn(async (req: WorkspaceExec) => {
      execs.push(req);
      if (!script.exit && !script.error) throw new Error("exec is only for workspace_bash");
      for (const f of script.frames) req.onFrame?.(f);
      if (script.error) throw script.error;
      return { ...script.exit!, execId: req.execId ?? "x" };
    }),
    run: vi.fn(async () => {
      throw new Error("run must not be used");
    }),
    spawn: vi.fn(async () => {
      throw new Error("spawn must not be used");
    }),
  };
  return { ws: ws as unknown as PortalWorkspace & typeof ws, store, script, execs };
}

const opts = (toolCallId = "call_1", abortSignal?: AbortSignal) => ({ toolCallId, messages: [], abortSignal }) as never;
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

function tools(ws: PortalWorkspace, s = SETTINGS) {
  return Object.fromEntries(workspaceTools(ws, s).map((e) => [e.name, e]));
}

async function execute(ws: PortalWorkspace, name: string, input: unknown, o = opts()) {
  const t = tools(ws)[name].tool;
  const out = await t.execute!(input as never, o);
  if (out && typeof out === "object" && Symbol.asyncIterator in out) {
    const all: unknown[] = [];
    for await (const v of out as AsyncIterable<unknown>) all.push(v);
    return all;
  }
  return out as Record<string, unknown>;
}

describe("workspace tool set", () => {
  it("has the six tools; only bash is non-grantable, and only bash, write and edit are sensitive", () => {
    const { ws } = fakeWorkspace();
    const entries = workspaceTools(ws, SETTINGS);
    expect(entries.map((e) => e.name)).toEqual(["workspace_bash", "workspace_write", "workspace_edit", "workspace_read", "workspace_list", "workspace_grep"]);
    expect(entries.every((e) => e.key === "workspace")).toBe(true);
    expect(entries.filter((e) => e.grantable === false).map((e) => e.name)).toEqual(["workspace_bash"]);
    expect(entries.filter((e) => e.sensitive).map((e) => e.name)).toEqual(["workspace_bash", "workspace_write", "workspace_edit"]);
  });

  it("the read-only tools never reach a shell", async () => {
    const { ws } = fakeWorkspace({ "a.txt": "hello\nworld\n" });
    await execute(ws, "workspace_read", { path: "a.txt" });
    await execute(ws, "workspace_list", {});
    await execute(ws, "workspace_grep", { pattern: "x" });
    await execute(ws, "workspace_write", { path: "b.txt", content: "x" });
    await execute(ws, "workspace_edit", { path: "a.txt", old_string: "world", new_string: "there" });
    expect(ws.exec).not.toHaveBeenCalled();
    expect(ws.run).not.toHaveBeenCalled();
    expect(ws.spawn).not.toHaveBeenCalled();
  });

  it("the stop id is derived from the tool call id", () => {
    expect(execIdForToolCall("call_1")).toMatch(/^[0-9a-f]{16}$/);
    expect(execIdForToolCall("call_1")).toBe(execIdForToolCall("call_1"));
    expect(execIdForToolCall("call_2")).not.toBe(execIdForToolCall("call_1"));
  });
});

describe("workspace_read", () => {
  it("numbers lines from start_line, masks secrets, and flags binary files", async () => {
    const { ws } = fakeWorkspace({ "a.txt": "one\nkey=sk-proj-abcdefghijklmnopqrstuvwxyz\n", "b.bin": new Uint8Array([1, 0, 2]) });
    const r = await execute(ws, "workspace_read", { path: "a.txt", start_line: 7 });
    expect(r).toMatchObject({ ok: true, path: "a.txt", truncated: false });
    expect((r as { content: string }).content).toBe("    7  one\n    8  key=[redacted]");
    expect(await execute(ws, "workspace_read", { path: "b.bin" })).toEqual({ ok: true, path: "b.bin", binary: true, size: 3 });
    expect(await execute(ws, "workspace_read", { path: "missing" })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("turns sandbox errors into results with the friendly message", async () => {
    const { ws } = fakeWorkspace();
    ws.readRaw.mockRejectedValueOnce(new SandboxError("outside_workspace", "That path is outside the workspace."));
    expect(await execute(ws, "workspace_read", { path: "../etc/passwd" })).toEqual({ ok: false, reason: "outside_workspace", message: "That path is outside the workspace." });
  });
});

describe("workspace_write and workspace_edit", () => {
  it("writes raw content and reports whether the file was created", async () => {
    const { ws, store } = fakeWorkspace();
    expect(await execute(ws, "workspace_write", { path: "n.txt", content: "héllo" })).toEqual({ ok: true, path: "n.txt", bytes: 6, created: true });
    expect(new TextDecoder().decode(store.get("n.txt"))).toBe("héllo");
    expect(await execute(ws, "workspace_write", { path: "n.txt", content: "x" })).toMatchObject({ ok: true, created: false });
  });

  it("refuses to write back a masked secret", async () => {
    const { ws, store } = fakeWorkspace();
    expect(await execute(ws, "workspace_write", { path: ".env", content: "KEY=[redacted]" })).toMatchObject({ ok: false, reason: "redacted" });
    expect(await execute(ws, "workspace_edit", { path: ".env", old_string: "[redacted]", new_string: "x" })).toMatchObject({ ok: false, reason: "redacted" });
    expect(store.size).toBe(0);
  });

  it("edits need exactly one match unless replace_all, and keep $ patterns literal", async () => {
    const { ws, store } = fakeWorkspace({ "a.ts": "let a = 1;\nlet a = 1;\nconst b = 2;\n" });
    expect(await execute(ws, "workspace_edit", { path: "a.ts", old_string: "nope", new_string: "x" })).toMatchObject({ ok: false, reason: "no_match" });
    expect(await execute(ws, "workspace_edit", { path: "a.ts", old_string: "let a = 1;", new_string: "x" })).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(await execute(ws, "workspace_edit", { path: "a.ts", old_string: "const b = 2;", new_string: "const b = '$&$1';" })).toEqual({ ok: true, path: "a.ts", replacements: 1 });
    expect(await execute(ws, "workspace_edit", { path: "a.ts", old_string: "let a = 1;", new_string: "let a = 3;", replace_all: true })).toEqual({ ok: true, path: "a.ts", replacements: 2 });
    expect(new TextDecoder().decode(store.get("a.ts"))).toBe("let a = 3;\nlet a = 3;\nconst b = '$&$1';\n");
  });

  it("refuses binary, missing and oversized files", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1).fill(97);
    const { ws } = fakeWorkspace({ "b.bin": new Uint8Array([0, 1]), "big.txt": big });
    expect(await execute(ws, "workspace_edit", { path: "b.bin", old_string: "a", new_string: "b" })).toMatchObject({ ok: false, reason: "binary" });
    expect(await execute(ws, "workspace_edit", { path: "nope", old_string: "a", new_string: "b" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await execute(ws, "workspace_edit", { path: "big.txt", old_string: "a", new_string: "b" })).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("parallel edits of one file don't lose changes (read-modify-write under the lock)", async () => {
    const { ws, store } = fakeWorkspace({ "a.txt": "A B C\n" });
    // Slow reads make an unlocked read-modify-write interleave.
    const read = ws.readRaw.getMockImplementation()!;
    ws.readRaw.mockImplementation(async (...a) => {
      await new Promise((r) => setTimeout(r, 5));
      return read(...a);
    });
    const rs = await Promise.all([
      execute(ws, "workspace_edit", { path: "a.txt", old_string: "A", new_string: "1" }),
      execute(ws, "workspace_edit", { path: "a.txt", old_string: "B", new_string: "2" }),
      execute(ws, "workspace_edit", { path: "a.txt", old_string: "C", new_string: "3" }),
    ]);
    expect(rs.every((r) => (r as { ok: boolean }).ok)).toBe(true);
    expect(new TextDecoder().decode(store.get("a.txt"))).toBe("1 2 3\n");
  });
});

describe("workspace_list and workspace_grep", () => {
  it("formats entries and matches, masking secrets in paths and text", async () => {
    const { ws } = fakeWorkspace();
    expect(await execute(ws, "workspace_list", { depth: 1 })).toEqual({ ok: true, entries: ["d src", "- src/a.ts (12 B)"], truncated: false });
    expect(ws.list).toHaveBeenCalledWith({ path: undefined, depth: 1, maxEntries: 500 });
    expect(await execute(ws, "workspace_grep", { pattern: "token", glob: "*.ts", ignore_case: true })).toEqual({
      ok: true,
      matches: ["src/a.ts:3: token [redacted]"],
      truncated: false,
    });
    expect(ws.grep).toHaveBeenCalledWith({ pattern: "token", path: undefined, glob: "*.ts", ignoreCase: true, maxMatches: 200 });
  });
});

describe("workspace_bash", () => {
  it("streams a throttled preview, then a final result with exit code, cleaned output and duration", async () => {
    const { ws, script, execs } = fakeWorkspace();
    script.frames = [
      { t: "start", id: "x" } as Frame,
      { t: "out", d: b64("uid=1000(agent)\n") } as Frame,
      { t: "err", d: b64("warning: token ghp_abcdefghijklmnopqrstuvwxyz0123\n") } as Frame,
    ];
    script.exit = { t: "exit", code: 0, reason: "exited", ms: 1234, dropped: 0 };
    const all = (await execute(ws, "workspace_bash", { command: "id", cwd: "src", timeout_seconds: 5 }, opts("call_9"))) as Record<string, unknown>[];
    expect(execs[0]).toMatchObject({ command: "id", cwd: "src", timeoutMs: 5000, execId: execIdForToolCall("call_9") });
    // At most one preview for a burst of frames, and the final result is always last.
    expect(all.filter((u) => u.status === "running").length).toBeLessThanOrEqual(1);
    expect(all.at(-1)).toEqual({
      status: "done",
      ok: true,
      exitCode: 0,
      reason: "exited",
      stdout: "uid=1000(agent)\n",
      stderr: "warning: token [redacted]\n",
      truncated: false,
      durationMs: 1234,
    });
  });

  it("defaults the timeout to the admin limit and never exceeds it", async () => {
    const { ws, script, execs } = fakeWorkspace();
    script.exit = { t: "exit", code: 0, reason: "exited", ms: 1, dropped: 0 };
    await execute(ws, "workspace_bash", { command: "true" });
    expect(execs[0].timeoutMs).toBe(120_000);
    const schema = tools(ws)["workspace_bash"].tool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ command: "true", timeout_seconds: 121 }).success).toBe(false);
  });

  it("keeps the start and end of long output, and says it was shortened", async () => {
    const { ws, script } = fakeWorkspace();
    const long = `${"a".repeat(3000)}MIDDLE${"z".repeat(3000)}`;
    script.frames = [{ t: "out", d: b64(long) } as Frame];
    script.exit = { t: "exit", code: 1, reason: "exited", ms: 10, dropped: 0 };
    const done = ((await execute(ws, "workspace_bash", { command: "cat big" })) as Record<string, unknown>[]).at(-1) as { stdout: string; truncated: boolean; ok: boolean };
    expect(done.ok).toBe(false);
    expect(done.truncated).toBe(true);
    expect(done.stdout.startsWith("a".repeat(2048))).toBe(true);
    expect(done.stdout.endsWith("z".repeat(2048))).toBe(true);
    expect(done.stdout).not.toContain("MIDDLE");
    expect(done.stdout.length).toBeLessThan(4096 + 100);
  });

  it("marks output sandboxd dropped as shortened, and reports why a command stopped", async () => {
    const { ws, script } = fakeWorkspace();
    script.frames = [{ t: "out", d: b64("x") } as Frame, { t: "gap", stream: "out", bytes: 10 } as unknown as Frame];
    script.exit = { t: "exit", code: 124, reason: "timeout", ms: 5000, dropped: 10 };
    const done = ((await execute(ws, "workspace_bash", { command: "sleep 99" })) as Record<string, unknown>[]).at(-1);
    expect(done).toMatchObject({ status: "done", ok: false, exitCode: 124, reason: "timeout", truncated: true });
    const t = tools(ws)["workspace_bash"].tool;
    expect(t.toModelOutput!({ toolCallId: "c", input: {}, output: done } as never)).toMatchObject({ type: "text", value: expect.stringContaining("exit code 124 (timed out)") });
  });

  it("returns sandbox failures as results, not throws", async () => {
    const { ws, script } = fakeWorkspace();
    script.error = new SandboxError("busy", "raw", 429);
    const all = (await execute(ws, "workspace_bash", { command: "make" })) as Record<string, unknown>[];
    expect(all.at(-1)).toEqual({ status: "error", ok: false, reason: "busy", message: "The workspace is busy with other commands. Try again when they finish." });
    const t = tools(ws)["workspace_bash"].tool;
    expect(t.toModelOutput!({ toolCallId: "c", input: {}, output: all.at(-1) } as never)).toEqual({ type: "error-text", value: expect.stringContaining("busy") });
  });

  it("masks secrets in unexpected errors", async () => {
    const { ws, script } = fakeWorkspace();
    script.error = new Error("connect failed: Bearer abcdefghijklmnop");
    const last = ((await execute(ws, "workspace_bash", { command: "x" })) as Record<string, unknown>[]).at(-1);
    expect(last).toMatchObject({ status: "error", reason: "error", message: "connect failed: Bearer [redacted]" });
  });

  it("refuses hard-denied commands without running them", async () => {
    const { ws } = fakeWorkspace();
    const all = (await execute(ws, "workspace_bash", { command: "rm -rf /" })) as Record<string, unknown>[];
    expect(all).toEqual([{ status: "error", ok: false, reason: "blocked", message: expect.stringContaining("isn't run") }]);
    expect(ws.exec).not.toHaveBeenCalled();
  });

  it("passes the abort signal through to the command", async () => {
    const { ws, script, execs } = fakeWorkspace();
    script.exit = { t: "exit", code: 143, reason: "killed", ms: 3, dropped: 0 };
    const ac = new AbortController();
    const last = ((await execute(ws, "workspace_bash", { command: "sleep 9" }, opts("c", ac.signal))) as Record<string, unknown>[]).at(-1);
    expect(execs[0].signal).toBe(ac.signal);
    expect(last).toMatchObject({ status: "done", ok: false, reason: "killed" });
  });

  it("an interrupted preview tells the model it didn't finish", () => {
    const { ws } = fakeWorkspace();
    const t = tools(ws)["workspace_bash"].tool;
    expect(t.toModelOutput!({ toolCallId: "c", input: {}, output: { status: "running", stdout: "", stderr: "", bytes: 0 } } as never)).toEqual({
      type: "text",
      value: "The command was interrupted before it finished.",
    });
  });
});
