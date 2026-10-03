/**
 * A person's workspace as the agent sees it: an AI SDK sandbox session backed by sandboxd, plus the argv-only
 * list/grep the read-only tools use (they must never reach a shell). One handle per turn, bound to the acting
 * person; the sandbox itself persists across turns.
 */
import { randomBytes } from "node:crypto";
import type { Experimental_SandboxProcess, Experimental_SandboxSession } from "ai";
import type { Frame } from "@/sandboxd/protocol/frames";
import type { GrepRequest, Isolation, ListRequest } from "@/sandboxd/protocol/types";
import type { ExitFrame, SandboxdClient } from "./client";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

type SpawnOptions = Parameters<Experimental_SandboxSession["spawn"]>[0];
type ReadOptions = Parameters<Experimental_SandboxSession["readFile"]>[0];
type ReadTextOptions = Parameters<Experimental_SandboxSession["readTextFile"]>[0];
type WriteOptions = Parameters<Experimental_SandboxSession["writeFile"]>[0];
type WriteBinaryOptions = Parameters<Experimental_SandboxSession["writeBinaryFile"]>[0];
type WriteTextOptions = Parameters<Experimental_SandboxSession["writeTextFile"]>[0];

export type WorkspaceExec = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onFrame?: (f: Frame) => void;
  /** Lets the caller kill it later (e.g. a Stop button keyed by tool call id). */
  execId?: string;
};

export const newExecId = () => randomBytes(8).toString("hex");

/** A command asked for after the turn closed its workspace handle (a stream still running after the turn ended). */
export class WorkspaceClosedError extends Error {
  constructor() {
    super("The workspace can't run commands any more: this reply has already ended.");
    this.name = "WorkspaceClosedError";
  }
}

export class PortalWorkspace implements Experimental_SandboxSession {
  readonly description =
    "Your private Linux workspace (Debian with bash, git, python3, node and a C toolchain) at /home/agent/workspace. " +
    "It has no network access. Files persist between chats until you reset the workspace.";
  private readonly client: SandboxdClient;
  private readonly resolveRef: () => Promise<string>;
  private readonly isolation: Isolation;
  private readonly onUse: () => void;
  private refPromise: Promise<string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly running = new Set<string>();
  private closed = false;

  constructor(opts: { client: SandboxdClient; ref: () => Promise<string>; isolation: Isolation; onUse?: () => void }) {
    this.client = opts.client;
    this.resolveRef = opts.ref;
    this.isolation = opts.isolation;
    this.onUse = opts.onUse ?? (() => {});
  }

  private ref(): Promise<string> {
    this.refPromise ??= this.resolveRef().catch((err) => {
      this.refPromise = null;
      throw err;
    });
    return this.refPromise;
  }

  /** Changes (writes, edits, commands) run one at a time per handle, so parallel tool calls can't interleave edits. */
  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- reads (not serialized) ---------------------------------------------------------------------------------------

  async readBinaryFile(o: ReadOptions): Promise<Uint8Array | null> {
    const r = await this.readRaw(o.path, MAX_FILE_BYTES);
    return r ? new Uint8Array(r.bytes) : null;
  }

  async readFile(o: ReadOptions): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(o);
    if (!bytes) return null;
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }

  async readTextFile(o: ReadTextOptions): Promise<string | null> {
    const r = await this.readRaw(o.path, MAX_FILE_BYTES, o.startLine, o.endLine);
    return r ? new TextDecoder(o.encoding ?? "utf-8", { fatal: false }).decode(r.bytes) : null;
  }

  /** Bytes plus whether they were cut at maxBytes; null when the file doesn't exist. */
  async readRaw(path: string, maxBytes: number, startLine?: number, endLine?: number) {
    this.onUse();
    return this.client.readFile(await this.ref(), { isolation: this.isolation, path, maxBytes, startLine, endLine });
  }

  async list(req: Omit<ListRequest, "isolation">) {
    this.onUse();
    return this.client.listFiles(await this.ref(), { ...req, isolation: this.isolation });
  }

  async grep(req: Omit<GrepRequest, "isolation">) {
    this.onUse();
    return this.client.grep(await this.ref(), { ...req, isolation: this.isolation });
  }

  // --- writes -------------------------------------------------------------------------------------------------------

  async writeBinaryFile(o: WriteBinaryOptions): Promise<void> {
    await this.writeRaw(o.path, o.content);
  }

  /** Writes a file (parents created, replaced atomically); returns whether it was created. Serialized. */
  writeRaw(path: string, content: Uint8Array) {
    return this.serialize(() => this.writeNow(path, content));
  }

  /** writeRaw without taking the lock: only for callers already inside serialize() (read-modify-write). */
  async writeNow(path: string, content: Uint8Array) {
    if (content.byteLength > MAX_FILE_BYTES) throw new Error(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    this.onUse();
    return this.client.writeFile(await this.ref(), { isolation: this.isolation, path, contentB64: Buffer.from(content).toString("base64") });
  }

  async writeTextFile(o: WriteTextOptions): Promise<void> {
    if (o.encoding && !/^utf-?8$/i.test(o.encoding)) throw new Error("Only UTF-8 text can be written");
    await this.writeRaw(o.path, new TextEncoder().encode(o.content));
  }

  async writeFile(o: WriteOptions): Promise<void> {
    const reader = o.content.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) throw new Error(`Files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      chunks.push(value);
    }
    await this.writeRaw(o.path, Buffer.concat(chunks));
  }

  // --- commands -----------------------------------------------------------------------------------------------------

  /** Runs a command to its exit frame, streaming frames as they arrive. Serialized with other changes. Refused once closed. */
  exec(req: WorkspaceExec): Promise<ExitFrame & { execId: string }> {
    if (this.closed) return Promise.reject(new WorkspaceClosedError());
    const execId = req.execId ?? newExecId();
    return this.serialize(async () => {
      // Queued behind another change (or waiting for the sandbox) while the turn ended.
      if (this.closed) throw new WorkspaceClosedError();
      this.onUse();
      const ref = await this.ref();
      if (this.closed) throw new WorkspaceClosedError();
      this.running.add(execId);
      try {
        const exit = await this.client.exec(
          ref,
          { isolation: this.isolation, command: req.command, cwd: req.cwd, env: req.env, timeoutMs: req.timeoutMs, execId },
          { onFrame: req.onFrame, signal: req.signal },
        );
        return { ...exit, execId };
      } finally {
        this.running.delete(execId);
      }
    });
  }

  async kill(execId: string): Promise<boolean> {
    if (!this.refPromise) return false;
    return (await this.client.kill(await this.refPromise, execId)).killed;
  }

  async spawn(o: SpawnOptions): Promise<Experimental_SandboxProcess> {
    if (this.closed) throw new WorkspaceClosedError();
    const out = new TransformStream<Uint8Array, Uint8Array>();
    const err = new TransformStream<Uint8Array, Uint8Array>();
    const ow = out.writable.getWriter();
    const ew = err.writable.getWriter();
    const execId = newExecId();
    const exited = this.exec({
      command: o.command,
      cwd: o.workingDirectory,
      env: o.env,
      timeoutMs: 10 * 60_000,
      signal: o.abortSignal,
      execId,
      onFrame: (f) => {
        if (f.t === "out") void ow.write(Buffer.from(f.d, "base64"));
        else if (f.t === "err") void ew.write(Buffer.from(f.d, "base64"));
      },
    }).finally(() => {
      void ow.close().catch(() => {});
      void ew.close().catch(() => {});
    });
    return {
      stdout: out.readable,
      stderr: err.readable,
      wait: async () => ({ exitCode: (await exited).code }),
      kill: async () => {
        await this.kill(execId).catch(() => false);
      },
    };
  }

  async run(o: SpawnOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (this.closed) throw new WorkspaceClosedError();
    let stdout = "";
    let stderr = "";
    const decoder = { out: new TextDecoder(), err: new TextDecoder() };
    const exit = await this.exec({
      command: o.command,
      cwd: o.workingDirectory,
      env: o.env,
      timeoutMs: 10 * 60_000,
      signal: o.abortSignal,
      onFrame: (f) => {
        if (f.t === "out") stdout += decoder.out.decode(Buffer.from(f.d, "base64"), { stream: true });
        else if (f.t === "err") stderr += decoder.err.decode(Buffer.from(f.d, "base64"), { stream: true });
      },
    });
    return { exitCode: exit.code, stdout: stdout + decoder.out.decode(), stderr: stderr + decoder.err.decode() };
  }

  /** End of turn: commands still running for this handle are stopped, and no new ones start. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.running].map((id) => this.kill(id)));
  }
}
