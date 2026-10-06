/**
 * Sandbox lifecycle and command execution. One sandboxd per Docker daemon: its in-memory locks and exec registry are
 * authoritative. Every operation starts the sandbox if needed (the portal never has to "ensure" first).
 */
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { StreamCapture } from "./capture.ts";
import type { Config } from "./config.ts";
import { DockerError, type ContainerInfo, type Docker, type EngineInfo } from "./docker.ts";
import type { ExitReason } from "./protocol/frames.ts";
import type { ErrorCode, ExecRequest, Health, Isolation, Runtime, SandboxState } from "./protocol/types.ts";
import { EXEC_ID_RE, REF_RE } from "./protocol/types.ts";
import { containerName, containerSpec, execSpec, LABEL_INSTANCE, LABEL_KIND, LABEL_SANDBOX, LABEL_SPEC, specHash, volumeName, volumeSpec } from "./spec.ts";
import { TemplateError, killRun, workspaceExec } from "./templates.ts";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  bad_request: 400,
  outside_workspace: 400,
  not_found: 404,
  too_large: 413,
  isolation_unavailable: 412,
  busy: 429,
  capacity: 503,
  image_missing: 503,
  docker_unavailable: 503,
  internal: 500,
};

export class SandboxdError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

/** run-agent writes this to stderr once its arguments check out (see docker/sandbox/run-agent). */
const START_MARKER = Buffer.from("\x1eportal-run-started\n");
const FS_MAGIC = Buffer.from("PORTALFS1 ");
const KILL_GRACE_MS = 8_000;
const PROBE_TTL_MS = 10 * 60_000;

type RunningExec = { id: string; kill: (reason: ExitReason) => void };
type Entry = { chain: Promise<unknown>; lastUsed: number; execs: Map<string, RunningExec>; helpers: number };

export type ExecCallbacks = {
  onStart: () => void;
  onOut: (chunk: Buffer) => void;
  onErr: (chunk: Buffer) => void;
  onGap: (stream: "out" | "err", bytes: number) => void;
};

export type ExecResult = { code: number; reason: ExitReason; ms: number; dropped: { out: number; err: number } };

type Log = (msg: string, extra?: object) => void;

export class Manager {
  readonly docker: Docker;
  readonly config: Config;
  private readonly log: Log;
  private readonly entries = new Map<string, Entry>();
  // One admission queue across all workspace refs. Hold it through Docker start, not just the count check.
  private admission: Promise<unknown> = Promise.resolve();
  private imageId: string | null = null;
  private engine: EngineInfo | null = null;
  private gvisor: { available: boolean; reason?: string; at: number } = { available: false, reason: "not checked yet", at: 0 };
  readonly warnings: string[] = [];

  constructor(docker: Docker, config: Config, log: Log = () => {}) {
    this.docker = docker;
    this.config = config;
    this.log = log;
  }

  /** Start-up checks. Throws (sandboxd refuses to run) when limits can't be enforced or the runtime policy can't be met. */
  async init(): Promise<void> {
    const version = await this.docker.version();
    if (!version) throw new Error("Docker didn't report its version");
    const [maj, min] = version.ApiVersion.split(".").map(Number);
    const [mmaj, mmin] = (version.MinAPIVersion ?? "1.0").split(".").map(Number);
    if (maj < 1 || (maj === 1 && min < 44)) throw new Error(`Docker API ${version.ApiVersion} is too old (need 1.44+)`);
    if (mmaj > 1 || (mmaj === 1 && mmin > 44)) throw new Error(`Docker no longer serves API 1.44 (minimum ${version.MinAPIVersion})`);
    this.engine = await this.docker.info();
    const e = this.engine!;
    if (!e.MemoryLimit || !e.PidsLimit || !e.CpuCfsQuota) throw new Error("This Docker host can't enforce memory, pids or CPU limits");
    if (e.CgroupDriver === "none") throw new Error("Docker reports no cgroup driver: limits would be ignored (rootless without systemd?)");
    if (!e.SwapLimit) this.warnings.push("Docker can't limit swap on this host; sandboxes could swap beyond their memory limit.");
    if (e.NCPU && this.config.limits.cpus > e.NCPU) {
      this.warnings.push(`SANDBOXD_CPUS (${this.config.limits.cpus}) is more than this host has (${e.NCPU}); using ${e.NCPU}.`);
      this.config.limits.cpus = e.NCPU;
    }
    await this.resolveImage();
    await this.probeGvisor();
    if (this.config.runtime === "runsc" && !this.gvisor.available) throw new Error(`SANDBOXD_RUNTIME=runsc but gVisor isn't usable: ${this.gvisor.reason}`);
    if (!this.gvisor.available && this.config.runtime !== "runsc") this.warnings.push(`gVisor isn't available (${this.gvisor.reason}); sandboxes can only run on runc.`);
    // Running sandboxes left from before a restart: treat them as just used, the reaper stops them later.
    for (const c of await this.docker.containerList(this.labels(), false)) {
      const ref = c.Labels[LABEL_SANDBOX];
      if (ref && REF_RE.test(ref)) this.entry(ref).lastUsed = Date.now();
    }
  }

  private labels(extra: Record<string, string> = {}) {
    return { [LABEL_INSTANCE]: this.config.instance, [LABEL_KIND]: "workspace", ...extra };
  }

  private entry(ref: string): Entry {
    let e = this.entries.get(ref);
    if (!e) {
      e = { chain: Promise.resolve(), lastUsed: 0, execs: new Map(), helpers: 0 };
      this.entries.set(ref, e);
    }
    return e;
  }

  /** Lifecycle operations on one sandbox run one at a time. */
  private locked<T>(ref: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entry(ref);
    const run = e.chain.then(fn, fn);
    e.chain = run.catch(() => {});
    return run;
  }

  private admitted<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.admission.then(fn, fn);
    // A failed Docker operation must release admission for the next workspace. Counts always come from Docker.
    this.admission = run.catch(() => {});
    return run;
  }

  private busy(e: Entry | undefined): boolean {
    return !!e && (e.execs.size > 0 || e.helpers > 0);
  }

  private checkRef(ref: string) {
    if (!REF_RE.test(ref)) throw new SandboxdError("bad_request", "Invalid sandbox reference");
  }

  private async resolveImage(): Promise<string> {
    const img = await this.docker.imageInspect(this.config.image);
    if (!img) throw new SandboxdError("image_missing", `The sandbox image ${this.config.image} isn't on this host (build it with npm run sandbox:image)`);
    this.imageId = img.Id;
    return img.Id;
  }

  /** gVisor counts only if runsc is registered, configured sanely, and a real sandbox actually runs under it. */
  async probeGvisor(force = false): Promise<void> {
    if (!force && this.gvisor.at && Date.now() - this.gvisor.at < PROBE_TTL_MS) return;
    const at = Date.now();
    if (this.config.runtime === "runc") {
      this.gvisor = { available: false, reason: "SANDBOXD_RUNTIME=runc", at };
      return;
    }
    const info = (this.engine = (await this.docker.info()) ?? this.engine);
    const runsc = info?.Runtimes?.runsc;
    if (!runsc) {
      this.gvisor = { available: false, reason: "runsc isn't registered with Docker", at };
      return;
    }
    const args = runsc.runtimeArgs ?? [];
    if (args.some((a) => /^--overlay2=all:/.test(a))) {
      this.gvisor = { available: false, reason: "runsc uses --overlay2=all:…, so workspace files wouldn't persist", at };
      return;
    }
    for (const a of args)
      if (/^--(network=host|strace|debug-log|log-packets|platform=ptrace)/.test(a)) this.warnings.push(`runsc is configured with ${a}; check it's intended.`);
    const ref = randomBytes(10).toString("hex");
    const name = containerName(ref);
    try {
      await this.docker.volumeCreate(volumeSpec(ref, this.config.instance, "probe"));
      await this.docker.containerCreate(name, containerSpec({ ref, imageId: this.imageId!, runtime: "runsc", limits: this.config.limits, kind: "probe", instance: this.config.instance }));
      await this.docker.containerStart(name);
      const out = await this.collect(name, ["uname", "-r"], { timeoutMs: 20_000 });
      const kernel = out.stdout.toString().trim();
      this.gvisor =
        kernel && kernel !== info?.KernelVersion
          ? { available: true, at }
          : { available: false, reason: "a runsc container reported the host kernel (runsc isn't isolating)", at };
    } catch (err) {
      this.gvisor = { available: false, reason: `a runsc test container failed: ${(err as Error).message}`, at };
    } finally {
      await this.docker.containerRemove(name).catch(() => {});
      await this.docker.volumeRemove(volumeName(ref)).catch(() => {});
    }
  }

  private runtimeFor(isolation: Isolation): Runtime {
    if (this.gvisor.available) return "runsc";
    if (isolation === "gvisor") throw new SandboxdError("isolation_unavailable", `This host can't run gVisor sandboxes: ${this.gvisor.reason}`);
    if (this.config.runtime === "runsc") throw new SandboxdError("isolation_unavailable", "sandboxd requires gVisor");
    return "runc";
  }

  /** Makes sure the sandbox exists, matches the current spec and runs. Returns its container id. */
  ensure(ref: string, isolation: Isolation, callerExec?: string, callerHelper = false): Promise<string> {
    this.checkRef(ref);
    return this.locked(ref, () => this.admitted(async () => {
      const runtime = this.runtimeFor(isolation);
      const imageId = this.imageId ?? (await this.resolveImage());
      const want = specHash({ ref, imageId, runtime, limits: this.config.limits });
      const name = containerName(ref);
      let info = await this.docker.containerInspect(name);
      if (info && info.Config.Labels[LABEL_INSTANCE] !== this.config.instance) throw new SandboxdError("internal", "Container name clash with another sandboxd");
      if (info && info.Config.Labels[LABEL_SPEC] !== want) {
        // Other commands still running in the old container (not the one asking) keep it alive for now.
        const e = this.entry(ref);
        const active = [...e.execs.keys()].some((id) => id !== callerExec) || e.helpers > (callerHelper ? 1 : 0);
        const weaker = isolation === "gvisor" && info.HostConfig.Runtime !== "runsc";
        if (active && weaker) throw new SandboxdError("busy", "The workspace is being upgraded; try again in a moment");
        if (!active) {
          this.log("recreating sandbox (spec changed)", { ref });
          await this.docker.containerRemove(info.Id);
          info = null;
        }
      }
      if (!info) {
        await this.makeRoom(ref);
        await this.docker.volumeCreate(volumeSpec(ref, this.config.instance));
        const created = await this.docker.containerCreate(name, containerSpec({ ref, imageId, runtime, limits: this.config.limits, instance: this.config.instance }));
        if (created.Warnings?.length) {
          await this.docker.containerRemove(created.Id).catch(() => {});
          throw new SandboxdError("internal", `Docker couldn't apply the sandbox settings: ${created.Warnings.join("; ")}`);
        }
        info = await this.docker.containerInspect(name);
      } else if (!info.State.Running) {
        await this.makeRoom(ref);
      }
      if (!info!.State.Running) await this.docker.containerStart(info!.Id);
      this.entry(ref).lastUsed = Date.now();
      return info!.Id;
    }));
  }

  /** Enforces maxRunning by stopping the least recently used idle sandbox. */
  private async makeRoom(ref: string) {
    const running = (await this.docker.containerList(this.labels(), false)).filter((c) => c.Labels[LABEL_SANDBOX] !== ref);
    if (running.length < this.config.maxRunning) return;
    const idle = running
      .map((c) => ({ c, e: this.entries.get(c.Labels[LABEL_SANDBOX]) }))
      .filter((x) => !this.busy(x.e))
      .sort((a, b) => (a.e?.lastUsed ?? 0) - (b.e?.lastUsed ?? 0));
    // Restarted daemons (or a lowered limit) may inherit more than maxRunning containers. Make enough room.
    const needed = running.length - this.config.maxRunning + 1;
    if (idle.length < needed) throw new SandboxdError("capacity", "All workspaces on this host are busy; try again shortly");
    for (const { c } of idle.slice(0, needed)) {
      // Exec/file reservations can arrive while a previous eviction awaits Docker. Never stop their container.
      if (this.busy(this.entries.get(c.Labels[LABEL_SANDBOX]))) throw new SandboxdError("capacity", "All workspaces on this host are busy; try again shortly");
      this.log("stopping least recently used sandbox to make room", { ref: c.Labels[LABEL_SANDBOX] });
      await this.docker.containerStop(c.Id, 3);
    }
  }

  /** Runs an internal helper (not counted against the exec limit) and collects its output. */
  private async collect(container: string, cmd: string[], opts: { stdin?: Buffer; timeoutMs: number; maxBytes?: number }) {
    const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    const execId = await this.docker.execCreate(container, execSpec(cmd, { stdin: !!opts.stdin }));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const io: { socket?: Duplex } = {};
    const attached = await this.docker.execAttach(execId, (type, data) => {
      if (type === 1) {
        size += data.length;
        if (size > maxBytes) {
          overflow = true;
          io.socket?.destroy();
        } else stdout.push(Buffer.from(data));
      } else if (stderr.reduce((n, b) => n + b.length, 0) < 64 * 1024) stderr.push(Buffer.from(data));
    });
    io.socket = attached.socket;
    if (opts.stdin) attached.socket.end(opts.stdin);
    const timer = setTimeout(() => attached.socket.destroy(), opts.timeoutMs);
    await attached.ended;
    clearTimeout(timer);
    if (overflow) throw new SandboxdError("too_large", "The result is too large");
    const code = await this.docker.execExitCode(execId).catch(() => null);
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }

  /** A file helper call: parses fsops' header and maps its errors. */
  async fsCall(ref: string, isolation: Isolation, argv: string[], opts: { stdin?: Buffer; maxBytes?: number; timeoutMs?: number } = {}) {
    this.checkRef(ref);
    const e = this.entry(ref);
    e.helpers++;
    try {
      const id = await this.ensure(ref, isolation, undefined, true);
      const r = await this.collect(id, argv, { stdin: opts.stdin, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs ?? 60_000 });
      this.entry(ref).lastUsed = Date.now();
      const nl = r.stdout.indexOf(0x0a);
      if (!r.stdout.subarray(0, FS_MAGIC.length).equals(FS_MAGIC) || nl < 0) {
        throw new SandboxdError("internal", `The file helper failed${r.stderr.length ? `: ${r.stderr.toString().trim().slice(0, 300)}` : ""}`);
      }
      const header = JSON.parse(r.stdout.subarray(FS_MAGIC.length, nl).toString()) as { ok: boolean; code?: ErrorCode; message?: string; [k: string]: unknown };
      if (!header.ok) {
        const code: ErrorCode = header.code && header.code in STATUS ? header.code : "internal";
        throw new SandboxdError(code, header.message ?? "File operation failed");
      }
      if (r.code !== 0) throw new SandboxdError("internal", "The file helper exited early");
      return { header, payload: r.stdout.subarray(nl + 1) };
    } finally {
      e.helpers--;
      e.lastUsed = Date.now();
    }
  }

  /** Runs a workspace command, streaming its output. Rejects (nothing ran) until onStart has been called. */
  async exec(ref: string, req: ExecRequest, cb: ExecCallbacks, signal: AbortSignal): Promise<ExecResult> {
    this.checkRef(ref);
    if (!EXEC_ID_RE.test(req.execId)) throw new SandboxdError("bad_request", "Invalid exec id");
    const e = this.entry(ref);
    if (e.execs.has(req.execId)) throw new SandboxdError("bad_request", "Duplicate exec id");
    if (e.execs.size >= this.config.maxExecs) throw new SandboxdError("busy", "The workspace is busy with other commands; try again when they finish");
    const timeoutMs = Math.min(Math.max(1000, req.timeoutMs), this.config.maxExecSeconds * 1000);
    let argv: string[];
    try {
      // run-agent's own timer fires a little later than ours, as a backstop.
      argv = workspaceExec({ execId: req.execId, command: req.command, cwd: req.cwd, env: req.env, timeoutSec: Math.ceil(timeoutMs / 1000) + 5 });
    } catch (err) {
      if (err instanceof TemplateError) throw new SandboxdError("bad_request", err.message);
      throw err;
    }
    // Reserve the slot before the (possibly slow) ensure, so concurrent requests can't exceed the limit.
    let killReason: ExitReason | null = null;
    let killRequested: ((reason: ExitReason) => void) | null = null;
    e.execs.set(req.execId, { id: req.execId, kill: (reason) => (killRequested ? killRequested(reason) : (killReason ??= reason)) });
    const t0 = Date.now();
    try {
      const containerId = await this.ensure(ref, req.isolation, req.execId);
      if (killReason) throw new SandboxdError("internal", "Stopped before it started");
      const execId = await this.docker.execCreate(containerId, execSpec(argv, { stdin: true }));

      let started = false;
      let pre = Buffer.alloc(0);
      let total = 0;
      const out = new StreamCapture(this.config.headBytes, this.config.tailBytes, cb.onOut);
      const err = new StreamCapture(this.config.headBytes, this.config.tailBytes, cb.onErr);
      const io: { socket?: Duplex; ended?: Promise<void> } = {};
      let killing = false;
      // The first reason wins; the kill itself runs once, as soon as the stream is attached.
      const kill = (reason: ExitReason) => {
        killReason ??= reason;
        if (killing || !io.socket) return;
        killing = true;
        // The lifeline: EOF on run-agent's stdin stops the command's whole process group.
        io.socket.end();
        this.collect(containerId, killRun(req.execId), { timeoutMs: 5000 }).catch(() => {});
        // Last resort (e.g. the sandbox is out of processes): stop the container; the next call restarts it.
        const fallback = setTimeout(() => {
          this.docker.containerKill(containerId).catch(() => {});
        }, KILL_GRACE_MS);
        fallback.unref();
        void io.ended?.then(() => clearTimeout(fallback));
      };
      killRequested = kill;

      const onData = (type: 0 | 1 | 2 | 3, data: Buffer) => {
        if (!started) {
          // Before run-agent's marker nothing is the command's output: it's why it couldn't start.
          pre = Buffer.concat([pre, data]);
          if (type === 2 && pre.subarray(0, START_MARKER.length).equals(START_MARKER)) {
            started = true;
            cb.onStart();
            const rest = pre.subarray(START_MARKER.length);
            pre = Buffer.alloc(0);
            if (rest.length) onData(2, rest);
          }
          return;
        }
        total += data.length;
        if (total > this.config.outputLimitBytes) {
          kill("output_limit");
          return;
        }
        if (type === 1) out.push(data);
        else err.push(data);
      };

      const attached = await this.docker.execAttach(execId, onData);
      io.socket = attached.socket;
      io.ended = attached.ended;
      if (killReason) kill(killReason);
      const deadline = setTimeout(() => kill("timeout"), timeoutMs);
      const onAbort = () => kill("killed");
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
      try {
        await attached.ended;
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
      }

      if (!started) {
        const why = pre.toString("utf8").replace(START_MARKER.toString(), "").trim();
        if (/must be inside the workspace/.test(why)) throw new SandboxdError("outside_workspace", "The working directory must be inside the workspace");
        if (/no such directory/.test(why)) throw new SandboxdError("bad_request", why.replace(/^run-agent: /, ""));
        throw new SandboxdError("internal", `The command couldn't start${why ? `: ${why.slice(0, 300)}` : ""}`);
      }
      const o = out.finish();
      const r = err.finish();
      if (o.dropped) cb.onGap("out", o.dropped);
      if (o.tail.length) cb.onOut(o.tail);
      if (r.dropped) cb.onGap("err", r.dropped);
      if (r.tail.length) cb.onErr(r.tail);

      const code = (await this.docker.execExitCode(execId).catch(() => null)) ?? -1;
      let reason: ExitReason = killReason ?? "exited";
      if (!killReason) {
        const state = await this.docker.containerInspect(containerId).catch(() => null);
        if (!state?.State.Running) reason = "died";
        else if (code === 124 && Date.now() - t0 >= timeoutMs) reason = "timeout";
      }
      return { code, reason, ms: Date.now() - t0, dropped: { out: o.dropped, err: r.dropped } };
    } finally {
      e.execs.delete(req.execId);
      e.lastUsed = Date.now();
    }
  }

  killExec(ref: string, execId: string): boolean {
    this.checkRef(ref);
    const x = this.entries.get(ref)?.execs.get(execId);
    if (!x) return false;
    x.kill("killed");
    return true;
  }

  private killAll(ref: string, reason: ExitReason) {
    for (const x of this.entries.get(ref)?.execs.values() ?? []) x.kill(reason);
  }

  async stop(ref: string): Promise<SandboxState> {
    this.checkRef(ref);
    this.killAll(ref, "stopped");
    await this.locked(ref, async () => {
      const info = await this.docker.containerInspect(containerName(ref));
      if (info?.State.Running) await this.docker.containerStop(info.Id, 3);
    });
    return this.state(ref);
  }

  /** Removes the container and the volume: the workspace's files are gone. */
  async destroy(ref: string): Promise<void> {
    this.checkRef(ref);
    this.killAll(ref, "stopped");
    await this.locked(ref, async () => {
      const info = await this.docker.containerInspect(containerName(ref));
      if (info) {
        if (info.Config.Labels[LABEL_INSTANCE] !== this.config.instance) throw new SandboxdError("internal", "Not this sandboxd's sandbox");
        await this.docker.containerRemove(info.Id);
      }
      // Only this instance's volume: another portal on the same Docker host may use the same naming.
      const volume = await this.docker.volumeInspect(volumeName(ref));
      if (volume) {
        if (volume.Labels?.[LABEL_INSTANCE] !== this.config.instance) throw new SandboxdError("internal", "Not this sandboxd's volume");
        await this.docker.volumeRemove(volume.Name);
      }
    });
    // Keep the entry: queued ensure/exec/file calls may already hold its chain and reservations.
    // Deleting it would hide their activity from admission and the reaper.
  }

  private toState(ref: string, info: ContainerInfo | null): SandboxState {
    const e = this.entries.get(ref);
    const want = this.imageId ? specHash({ ref, imageId: this.imageId, runtime: this.gvisor.available ? "runsc" : "runc", limits: this.config.limits }) : null;
    return {
      ref,
      state: !info ? "missing" : info.State.Running ? "running" : "stopped",
      runtime: (info?.HostConfig.Runtime as Runtime | undefined) ?? null,
      drift: !!info && !!want && info.Config.Labels[LABEL_SPEC] !== want,
      createdAt: info?.Created ?? null,
      lastUsedAt: e?.lastUsed ? new Date(e.lastUsed).toISOString() : null,
      activeExecs: e?.execs.size ?? 0,
    };
  }

  async state(ref: string): Promise<SandboxState> {
    this.checkRef(ref);
    return this.toState(ref, await this.docker.containerInspect(containerName(ref)));
  }

  /** Every sandbox this instance knows about (containers, plus volumes whose container is gone). */
  async list(): Promise<SandboxState[]> {
    const containers = await this.docker.containerList(this.labels());
    const refs = new Set<string>();
    const out: SandboxState[] = [];
    for (const c of containers) {
      const ref = c.Labels[LABEL_SANDBOX];
      if (!ref || !REF_RE.test(ref)) continue;
      refs.add(ref);
      out.push(this.toState(ref, await this.docker.containerInspect(c.Id)));
    }
    for (const v of await this.docker.volumeList({ [LABEL_INSTANCE]: this.config.instance, [LABEL_KIND]: "workspace" })) {
      const ref = v.Labels?.[LABEL_SANDBOX];
      if (ref && REF_RE.test(ref) && !refs.has(ref)) out.push(this.toState(ref, null));
    }
    return out;
  }

  /** Stops sandboxes idle for longer than idleMinutes (never one with a running command). */
  async reap(now = Date.now()): Promise<string[]> {
    const stopped: string[] = [];
    for (const c of await this.docker.containerList(this.labels(), false)) {
      const ref = c.Labels[LABEL_SANDBOX];
      if (!ref || !REF_RE.test(ref)) continue;
      const e = this.entry(ref);
      if (this.busy(e)) continue;
      if (!e.lastUsed) e.lastUsed = now;
      if (now - e.lastUsed < this.config.idleMinutes * 60_000) continue;
      await this.locked(ref, async () => {
        if (this.busy(e) || now - e.lastUsed < this.config.idleMinutes * 60_000) return;
        await this.docker.containerStop(c.Id, 3);
        stopped.push(ref);
      });
    }
    return stopped;
  }

  async health(): Promise<Health> {
    const warnings = [...this.warnings];
    let docker: Health["docker"] = null;
    let running = 0;
    let present = false;
    try {
      const v = await this.docker.version();
      docker = v ? { version: v.Version, apiVersion: v.ApiVersion } : null;
      await this.probeGvisor();
      running = (await this.docker.containerList(this.labels(), false)).length;
      present = !!(await this.docker.imageInspect(this.config.image));
    } catch (err) {
      warnings.push(err instanceof DockerError ? err.message : String(err));
    }
    const c = this.config;
    return {
      ok: !!docker && present,
      docker,
      gvisor: { available: this.gvisor.available, ...(this.gvisor.reason ? { reason: this.gvisor.reason } : {}) },
      defaultRuntime: this.gvisor.available ? "runsc" : c.runtime === "runsc" ? null : "runc",
      image: { ref: c.image, present },
      limits: {
        memoryMb: c.limits.memoryMb,
        cpus: c.limits.cpus,
        pids: c.limits.pids,
        idleMinutes: c.idleMinutes,
        maxRunning: c.maxRunning,
        maxExecs: c.maxExecs,
        maxExecSeconds: c.maxExecSeconds,
      },
      running,
      warnings,
    };
  }
}
