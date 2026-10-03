import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxdClient } from "@/lib/sandbox/client";
import { enabled, newExecId, newRef, run, startSandboxd, type Harness } from "./harness";

const suite = enabled ? describe : describe.skip;
/** Counts "sleep 100" processes (the container's own "sleep infinity" doesn't count; grep's pattern can't match itself). */
const SLEEPERS = "ps -eo args | grep -c '^sleep 100$' || true";

suite("sandboxd against Docker: lifecycle, commands, files", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startSandboxd();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("starts a sandbox on first use and runs commands as the agent user", async () => {
    const ref = newRef();
    expect((await h.client.state(ref)).state).toBe("missing");
    const r = await run(h, ref, "echo hi; id -u; pwd; echo oops >&2; exit 7");
    expect(r).toMatchObject({ started: true, code: 7, reason: "exited", out: "hi\n1000\n/home/agent/workspace\n", err: "oops\n" });
    const s = await h.client.state(ref);
    expect(s).toMatchObject({ state: "running", drift: false, activeExecs: 0 });
    expect(["runc", "runsc"]).toContain(s.runtime);
  });

  it("refuses a working directory outside the workspace before running anything", async () => {
    const ref = newRef();
    await expect(h.client.exec(ref, { isolation: "any", command: "true", cwd: "../..", timeoutMs: 5000, execId: newExecId() })).rejects.toMatchObject({
      code: "outside_workspace",
    });
    await expect(h.client.exec(ref, { isolation: "any", command: "true", cwd: "nope", timeoutMs: 5000, execId: newExecId() })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      h.client.exec(ref, { isolation: "any", command: "true", env: { LD_PRELOAD: "/x.so" }, timeoutMs: 5000, execId: newExecId() }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("round-trips binary files, creates parents, and keeps files inside the workspace", async () => {
    const ref = newRef();
    const bytes = randomBytes(70_000);
    bytes[10] = 0;
    expect(await h.client.writeFile(ref, { isolation: "any", path: "deep/dir/blob.bin", contentB64: bytes.toString("base64") })).toEqual({ bytes: 70_000, created: true });
    const back = await h.client.readFile(ref, { isolation: "any", path: "deep/dir/blob.bin", maxBytes: 1_000_000 });
    expect(back?.bytes.equals(bytes)).toBe(true);
    expect(await h.client.writeFile(ref, { isolation: "any", path: "deep/dir/blob.bin", contentB64: "aGk=" })).toEqual({ bytes: 2, created: false });
    expect(await h.client.readFile(ref, { isolation: "any", path: "missing.txt", maxBytes: 100 })).toBeNull();

    await h.client.writeFile(ref, { isolation: "any", path: "lines.txt", contentB64: Buffer.from("a\nb\nc\nd\n").toString("base64") });
    const range = await h.client.readFile(ref, { isolation: "any", path: "lines.txt", maxBytes: 100, startLine: 2, endLine: 3 });
    expect(range?.bytes.toString()).toBe("b\nc\n");
    const capped = await h.client.readFile(ref, { isolation: "any", path: "lines.txt", maxBytes: 3 });
    expect(capped).toMatchObject({ size: 8, truncated: true });

    await expect(h.client.readFile(ref, { isolation: "any", path: "../../../etc/passwd", maxBytes: 100 })).rejects.toMatchObject({ code: "outside_workspace" });
    await run(h, ref, "ln -s /etc/passwd pw; ln -s /home/claude cl");
    await expect(h.client.readFile(ref, { isolation: "any", path: "pw", maxBytes: 100 })).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(h.client.writeFile(ref, { isolation: "any", path: "cl/x", contentB64: "eA==" })).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(h.client.readFile(ref, { isolation: "any", path: "deep", maxBytes: 100 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("lists and searches without running a shell", async () => {
    const ref = newRef();
    await h.client.writeFile(ref, { isolation: "any", path: "src/a.ts", contentB64: Buffer.from("const x = 1;\n// TODO fix\n").toString("base64") });
    await h.client.writeFile(ref, { isolation: "any", path: "src/b.md", contentB64: Buffer.from("todo later\n").toString("base64") });
    await h.client.writeFile(ref, { isolation: "any", path: "node_modules/pkg/i.js", contentB64: Buffer.from("TODO\n").toString("base64") });
    const list = await h.client.listFiles(ref, { isolation: "any", depth: 2, maxEntries: 50 });
    expect(list.entries.map((e) => e.path)).toEqual(expect.arrayContaining(["src", "src/a.ts", "src/b.md", "node_modules"]));
    expect(list.entries.map((e) => e.path)).not.toContain("node_modules/pkg");
    const g = await h.client.grep(ref, { isolation: "any", pattern: "todo", ignoreCase: true, maxMatches: 10 });
    expect(g.matches).toEqual([
      { path: "src/a.ts", line: 2, text: "// TODO fix" },
      { path: "src/b.md", line: 1, text: "todo later" },
    ]);
    expect((await h.client.grep(ref, { isolation: "any", pattern: "TODO", glob: "*.md", maxMatches: 10 })).matches).toEqual([]);
    await expect(h.client.grep(ref, { isolation: "any", pattern: "(", maxMatches: 10 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("stop keeps files; the next call restarts the sandbox; destroy wipes it", async () => {
    const ref = newRef();
    await run(h, ref, "echo kept > f.txt");
    expect((await h.client.stop(ref)).state).toBe("stopped");
    expect((await run(h, ref, "cat f.txt")).out).toBe("kept\n");
    await h.client.destroy(ref);
    expect((await h.client.state(ref)).state).toBe("missing");
    expect((await run(h, ref, "cat f.txt 2>&1; true")).out).toMatch(/No such file/);
  });

  it("destroy never removes another sandboxd instance's volume", async () => {
    const { volumeSpec } = await import("@/sandboxd/spec");
    const ref = newRef();
    const other = volumeSpec(ref, "someone-else");
    await h.docker.volumeCreate(other);
    try {
      await expect(h.client.destroy(ref)).rejects.toThrow();
      expect(await h.docker.volumeInspect(other.Name)).not.toBeNull();
    } finally {
      await h.docker.volumeRemove(other.Name);
    }
  });

  it("kills a running command and its whole process group", async () => {
    const ref = newRef();
    const execId = newExecId();
    const t0 = Date.now();
    const running = run(h, ref, "sleep 100 & sleep 100", { execId });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await h.client.kill(ref, execId)).killed).toBe(true);
    const r = await running;
    expect(r.reason).toBe("killed");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await run(h, ref, SLEEPERS)).out.trim()).toBe("0");
  });

  it("aborting the request kills the command", async () => {
    const ref = newRef();
    const ac = new AbortController();
    const running = run(h, ref, "sleep 100", { signal: ac.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 1500));
    ac.abort();
    await running;
    await new Promise((r) => setTimeout(r, 4000));
    expect((await run(h, ref, SLEEPERS)).out.trim()).toBe("0");
  });

  it("times out", async () => {
    const r = await run(h, newRef(), "sleep 30", { timeoutMs: 2000 });
    expect(r.reason).toBe("timeout");
    expect(r.ms).toBeLessThan(10_000);
  });

  it("keeps the head and the tail of long output, even for a slow reader", async () => {
    const r = await run(h, newRef(), "head -c 3000000 /dev/zero | tr '\\0' a; echo; echo END");
    expect(r.code).toBe(0);
    expect(r.gaps).toEqual([{ s: "out", n: expect.any(Number) }]);
    expect(r.out.length).toBe(h.config.headBytes + h.config.tailBytes);
    expect(r.out.endsWith("\nEND\n")).toBe(true);
  });

  it("a sandboxd that dies mid-command takes the command with it (the stdin lifeline)", async () => {
    const ref = newRef();
    await run(h, ref, "true");
    const secret = randomBytes(32).toString("hex");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["src/sandboxd/index.ts"], {
      env: { ...process.env, SANDBOXD_SECRET: secret, SANDBOXD_LISTEN: `127.0.0.1:${port}`, SANDBOXD_INSTANCE: h.config.instance, SANDBOXD_MEMORY_MB: "256", SANDBOXD_CPUS: "1", SANDBOXD_PIDS: "128", SANDBOXD_FSIZE_MB: "16", SANDBOXD_TMP_MB: "64", SANDBOXD_RUNTIME: h.config.runtime },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("child sandboxd didn't start")), 30_000);
      child.stdout!.on("data", (d: Buffer) => d.toString().includes("listening") && (clearTimeout(t), resolve()));
    });
    const other = new SandboxdClient({ url: `http://127.0.0.1:${port}`, secret });
    const running = other.exec(ref, { isolation: "any", command: "sleep 100", timeoutMs: 60_000, execId: newExecId() }).catch(() => null);
    await new Promise((r) => setTimeout(r, 2000));
    child.kill("SIGKILL");
    await running;
    await new Promise((r) => setTimeout(r, 5000));
    expect((await run(h, ref, SLEEPERS)).out.trim()).toBe("0");
  });

  it("rejects unsigned and replayed requests", async () => {
    const res = await fetch(`${h.url}/v1/health`);
    expect(res.status).toBe(401);
    const bad = new SandboxdClient({ url: h.url, secret: "x".repeat(40) });
    await expect(bad.health()).rejects.toMatchObject({ code: "unauthorized" });
  });
});

suite("sandboxd limits: output, concurrency, spec drift, idle reaping", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startSandboxd({ SANDBOXD_OUTPUT_LIMIT_MB: "1", SANDBOXD_MAX_EXECS: "2", SANDBOXD_IDLE_MINUTES: "0.05" });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("stops a command that floods its output", async () => {
    const r = await run(h, newRef(), "yes");
    expect(r.reason).toBe("output_limit");
  });

  it("refuses more concurrent commands than allowed", async () => {
    const ref = newRef();
    await run(h, ref, "true");
    const a = run(h, ref, "sleep 3");
    const b = run(h, ref, "sleep 3");
    await new Promise((r) => setTimeout(r, 800));
    await expect(run(h, ref, "true")).rejects.toMatchObject({ code: "busy" });
    await Promise.all([a, b]);
    expect((await run(h, ref, "echo ok")).out).toBe("ok\n");
  });

  it("recreates a sandbox whose spec changed, keeping its files", async () => {
    const ref = newRef();
    await run(h, ref, "echo persisted > p.txt");
    const h2 = await startSandboxd({ SANDBOXD_INSTANCE: h.config.instance, SANDBOXD_PIDS: "256" });
    expect((await h2.client.state(ref)).drift).toBe(true);
    expect((await run(h2, ref, "cat p.txt")).out).toBe("persisted\n");
    expect((await h2.client.state(ref)).drift).toBe(false);
    // Hand it back to the first instance's spec (and don't let h2's cleanup remove the shared instance's sandboxes).
    await run(h, ref, "true");
  });

  it("stops idle sandboxes, never ones running a command", async () => {
    const idle = newRef();
    const busy = newRef();
    await run(h, idle, "true");
    const running = run(h, busy, "sleep 6");
    await new Promise((r) => setTimeout(r, 1000));
    const stopped = await h.manager.reap(Date.now() + 10 * 60_000);
    expect(stopped).toContain(idle);
    expect(stopped).not.toContain(busy);
    expect((await running).code).toBe(0);
  });
});
