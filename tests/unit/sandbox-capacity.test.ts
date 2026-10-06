import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/sandboxd/config";
import { type ContainerInfo, type Docker } from "@/sandboxd/docker";
import { Manager } from "@/sandboxd/manager";
import { LABEL_INSTANCE, LABEL_SANDBOX, containerName, containerSpec } from "@/sandboxd/spec";

const ref = (n: number) => n.toString(16).padStart(20, "0");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

function fixture(maxRunning = 1) {
  const config = loadConfig({ SANDBOXD_SECRET: "a".repeat(64), SANDBOXD_RUNTIME: "runc", SANDBOXD_MAX_RUNNING: String(maxRunning) });
  const containers = new Map<string, ContainerInfo>();
  const stops: string[] = [];
  let peak = 0;
  let createGate: ReturnType<typeof deferred> | undefined;
  let startGate: ReturnType<typeof deferred> | undefined;
  let removeGate: ReturnType<typeof deferred> | undefined;
  let commandGate: ReturnType<typeof deferred> | undefined;
  let helperGate: ReturnType<typeof deferred> | undefined;
  let fail: "volume" | "create" | "inspect" | "start" | "start-response" | "stop" | "warning" | undefined;
  const find = (id: string) => containers.get(id) ?? [...containers.values()].find(c => c.Id === id) ?? null;
  const running = () => [...containers.values()].filter(c => c.State.Running);
  const docker = {
    version: async () => ({ Version: "25", ApiVersion: "1.44", MinAPIVersion: "1.24" }),
    info: async () => ({ MemoryLimit: true, PidsLimit: true, CpuCfsQuota: true, SwapLimit: true, CgroupDriver: "systemd", NCPU: 8, Runtimes: {} }),
    imageInspect: async () => ({ Id: "image" }),
    containerList: async (labels: Record<string, string>, all = true) => [...containers.entries()]
      .filter(([, c]) => (all || c.State.Running) && Object.entries(labels).every(([k, v]) => c.Config.Labels[k] === v))
      .map(([name, c]) => ({ Id: c.Id, Names: [name], State: c.State.Running ? "running" : "exited", Labels: c.Config.Labels, Created: 0 })),
    containerInspect: async (id: string) => {
      if (fail === "inspect" && find(id)) { fail = undefined; throw new Error("inspect failed"); }
      return find(id);
    },
    volumeCreate: async () => { if (fail === "volume") { fail = undefined; throw new Error("volume failed"); } },
    containerCreate: async (name: string, spec: ReturnType<typeof containerSpec>) => {
      await createGate?.promise;
      if (fail === "create") { fail = undefined; throw new Error("create failed"); }
      const info: ContainerInfo = { Id: name, Created: "", State: { Running: false, Status: "created", StartedAt: "", OOMKilled: false }, Config: { Labels: spec.Labels }, HostConfig: { Runtime: "runc" } };
      containers.set(name, info);
      const Warnings = fail === "warning" ? ["limits ignored"] : null;
      if (Warnings) fail = undefined;
      return { Id: name, Warnings };
    },
    containerStart: async (id: string) => {
      await startGate?.promise;
      if (fail === "start") { fail = undefined; throw new Error("start failed"); }
      find(id)!.State.Running = true;
      peak = Math.max(peak, running().length);
      if (fail === "start-response") { fail = undefined; throw new Error("start response lost"); }
    },
    containerStop: async (id: string) => {
      if (fail === "stop") { fail = undefined; throw new Error("stop failed"); }
      find(id)!.State.Running = false; stops.push(id);
    },
    containerRemove: async (id: string) => { await removeGate?.promise; containers.delete(id); },
    volumeInspect: async () => null,
    execCreate: async (_id: string, spec: { Cmd: string[] }) => spec.Cmd[0] === "/opt/portal/run-agent" ? "command" : "helper",
    execAttach: async (_id: string, onData: (kind: number, data: Buffer) => void) => {
      if (_id === "command") onData(2, Buffer.from("\x1eportal-run-started\n"));
      else onData(1, Buffer.from('PORTALFS1 {"ok":true}\nfixture'));
      return { socket: new PassThrough(), ended: (_id === "command" ? commandGate : helperGate)?.promise ?? Promise.resolve() };
    },
    execExitCode: async () => 0,
  };
  const manager = new Manager(docker as unknown as Docker, config);
  const seed = (n: number, active = true, instance = config.instance) => {
    const spec = containerSpec({ ref: ref(n), imageId: "image", runtime: "runc", limits: config.limits, instance });
    containers.set(containerName(ref(n)), { Id: containerName(ref(n)), Created: "", State: { Running: active, Status: active ? "running" : "exited", StartedAt: "", OOMKilled: false }, Config: { Labels: spec.Labels }, HostConfig: { Runtime: "runc" } });
  };
  return { manager, containers, seed, stops, running, peak: () => peak,
    fail: (kind: typeof fail) => { fail = kind; },
    gate: (kind: "create" | "start" | "helper" | "remove" | "command") => {
      const gate = deferred();
      if (kind === "create") createGate = gate;
      if (kind === "start") startGate = gate;
      if (kind === "helper") helperGate = gate;
      if (kind === "remove") removeGate = gate;
      if (kind === "command") commandGate = gate;
      return gate;
    },
  };
}

// Resolve enough queued Docker calls to expose the old check-before-start race, without wall-clock sleeps.
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

describe("sandbox admission capacity (fixture Docker only)", () => {
  it("rejects fractional capacity so admission always has an integer ceiling", () => {
    expect(() => fixture(1.5)).toThrow("SANDBOXD_MAX_RUNNING must be a whole number");
  });

  it("recounts a started container after a lost Docker start response", async () => {
    const f = fixture(); await f.manager.init(); f.fail("start-response");
    await expect(f.manager.ensure(ref(1), "any")).rejects.toThrow("start response lost");
    await f.manager.ensure(ref(2), "any");
    expect(f.peak()).toBe(1); expect(f.running()).toHaveLength(1);
  });

  for (const kind of ["create", "start"] as const) it(`serializes different owners through slow ${kind}`, async () => {
    const f = fixture(); await f.manager.init();
    const gate = f.gate(kind);
    const a = f.manager.ensure(ref(1), "any");
    const b = f.manager.ensure(ref(2), "any");
    await flush(); gate.resolve();
    await Promise.all([a, b]);
    expect(f.peak()).toBe(1);
    expect(f.running()).toHaveLength(1);
  });

  it("counts concurrently restarted stopped workspaces", async () => {
    const f = fixture(); f.seed(1, false); f.seed(2, false); await f.manager.init();
    const gate = f.gate("start");
    const calls = [f.manager.ensure(ref(1), "any"), f.manager.ensure(ref(2), "any")];
    await flush(); gate.resolve(); await Promise.all(calls);
    expect(f.peak()).toBe(1); expect(f.running()).toHaveLength(1);
  });

  it("keeps same-workspace admission idempotent", async () => {
    const f = fixture(); await f.manager.init();
    await Promise.all(Array.from({ length: 10 }, () => f.manager.ensure(ref(1), "any")));
    expect(f.containers.size).toBe(1); expect(f.peak()).toBe(1); expect(f.stops).toEqual([]);
  });

  for (const kind of ["volume", "create", "inspect", "start", "warning"] as const) it(`releases admission after ${kind} failure`, async () => {
    const f = fixture(); await f.manager.init(); f.fail(kind);
    await expect(f.manager.ensure(ref(1), "any")).rejects.toThrow();
    await f.manager.ensure(ref(2), "any");
    await f.manager.ensure(ref(1), "any");
    expect(f.peak()).toBe(1); expect(f.running()).toHaveLength(1);
  });

  it("recovers capacity from Docker state after daemon restart and a lower limit", async () => {
    const f = fixture(); f.seed(1); f.seed(2); f.seed(3); await f.manager.init();
    await f.manager.ensure(ref(4), "any");
    expect(f.stops).toHaveLength(3); expect(f.running()).toHaveLength(1);
  });

  it("does not count or evict another instance's containers", async () => {
    const f = fixture(); f.seed(1, true, "other"); await f.manager.init();
    await f.manager.ensure(ref(2), "any"); await f.manager.ensure(ref(3), "any");
    expect(f.containers.get(containerName(ref(1)))?.State.Running).toBe(true);
    expect(f.running().filter(c => c.Config.Labels[LABEL_INSTANCE] === "default")).toHaveLength(1);
    expect(f.stops).not.toContain(containerName(ref(1)));
  });

  it("does not evict a workspace during a file helper, and frees it after completion", async () => {
    const f = fixture(); await f.manager.init(); const gate = f.gate("helper");
    const read = f.manager.fsCall(ref(1), "any", ["fixture"]);
    await flush();
    await expect(f.manager.ensure(ref(2), "any")).rejects.toMatchObject({ code: "capacity" });
    expect(f.stops).toEqual([]); gate.resolve(); await read;
    await f.manager.ensure(ref(2), "any"); expect(f.peak()).toBe(1);
  });

  it("does not evict file helpers through the idle reaper", async () => {
    const f = fixture(); await f.manager.init(); const gate = f.gate("helper");
    const read = f.manager.fsCall(ref(1), "any", ["fixture"]); await flush();
    expect(await f.manager.reap(Date.now() + 3_600_000)).toEqual([]);
    gate.resolve(); await read;
    expect(await f.manager.reap(Date.now() + 3_600_000)).toEqual([ref(1)]);
  });

  it("retains capacity and recovers the queue when idle eviction fails", async () => {
    const f = fixture(); f.seed(1); await f.manager.init(); f.fail("stop");
    await expect(f.manager.ensure(ref(2), "any")).rejects.toThrow("stop failed");
    expect(f.running()).toHaveLength(1);
    await f.manager.ensure(ref(2), "any"); expect(f.peak()).toBe(1);
  });

  it("rejects saturation while a command is active and clears failed exec reservations", async () => {
    const f = fixture(); await f.manager.init(); const gate = f.gate("command");
    const cb = { onStart: vi.fn(), onOut: vi.fn(), onErr: vi.fn(), onGap: vi.fn() };
    const request = { execId: "a".repeat(16), isolation: "any" as const, command: "fixture", timeoutMs: 60_000 };
    const first = f.manager.exec(ref(1), request, cb, new AbortController().signal); await flush();
    expect(cb.onStart).toHaveBeenCalledOnce();
    await expect(f.manager.exec(ref(2), request, cb, new AbortController().signal)).rejects.toMatchObject({ code: "capacity" });
    expect((await f.manager.state(ref(2))).activeExecs).toBe(0);
    expect(await f.manager.reap(Date.now() + 3_600_000)).toEqual([]);
    gate.resolve(); await first;
    expect((await f.manager.state(ref(1))).activeExecs).toBe(0);
    await f.manager.ensure(ref(2), "any"); expect(f.peak()).toBe(1);
  });

  it("clears helper reservations after failed admission", async () => {
    const f = fixture(); await f.manager.init(); f.fail("volume");
    await expect(f.manager.fsCall(ref(1), "any", ["fixture"])).rejects.toThrow("volume failed");
    await f.manager.ensure(ref(1), "any"); await f.manager.ensure(ref(2), "any");
    expect(f.peak()).toBe(1);
  });

  it("evicts the least recently used idle workspace", async () => {
    const f = fixture(2); await f.manager.init(); let now = 100;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await f.manager.ensure(ref(1), "any"); now = 200; await f.manager.ensure(ref(2), "any");
      now = 300; await f.manager.ensure(ref(1), "any"); now = 400; await f.manager.ensure(ref(3), "any");
      expect(f.stops).toEqual([containerName(ref(2))]); expect(f.peak()).toBe(2);
    } finally { clock.mockRestore(); }
  });

  it("preserves queued helper reservations across concurrent destroy", async () => {
    const f = fixture(); await f.manager.init(); await f.manager.ensure(ref(1), "any");
    const removed = f.gate("remove"); const helper = f.gate("helper");
    const destroyed = f.manager.destroy(ref(1)); await flush();
    const read = f.manager.fsCall(ref(1), "any", ["fixture"]);
    removed.resolve(); await destroyed; await flush();
    await expect(f.manager.ensure(ref(2), "any")).rejects.toMatchObject({ code: "capacity" });
    helper.resolve(); await read; await f.manager.ensure(ref(2), "any");
    expect(f.peak()).toBe(1);
  });

  it("stop/destroy release Docker capacity without stale reservations", async () => {
    const f = fixture(); await f.manager.init(); await f.manager.ensure(ref(1), "any");
    await f.manager.stop(ref(1)); await f.manager.ensure(ref(2), "any");
    await f.manager.destroy(ref(2)); await f.manager.ensure(ref(3), "any");
    expect(f.running().map(c => c.Config.Labels[LABEL_SANDBOX])).toEqual([ref(3)]); expect(f.peak()).toBe(1);
  });
});
