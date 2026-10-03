/**
 * A minimal Docker Engine API client over the unix socket (no dockerode: this process holds docker.sock, so it
 * carries no npm dependencies). Pinned to API v1.44, which current engines (25+) serve.
 */
import http from "node:http";
import type { Duplex } from "node:stream";
import { DockerDemuxer, type StreamType } from "./demux.ts";

export const API_VERSION = "1.44";

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown>;

export type ContainerSummary = { Id: string; Names: string[]; State: string; Labels: Record<string, string>; Created: number };
export type ContainerInfo = {
  Id: string;
  Created: string;
  State: { Running: boolean; Status: string; StartedAt: string; OOMKilled: boolean };
  Config: { Labels: Record<string, string> };
  HostConfig: { Runtime: string };
};
export type ExecInfo = { Running: boolean; ExitCode: number | null; Pid: number };
export type EngineInfo = {
  KernelVersion: string;
  NCPU: number;
  MemoryLimit: boolean;
  SwapLimit: boolean;
  PidsLimit: boolean;
  CpuCfsQuota: boolean;
  CgroupDriver: string;
  Runtimes: Record<string, { path?: string; runtimeArgs?: string[] }>;
};

export class Docker {
  readonly socketPath: string;
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** One JSON request. 404 resolves to null when `allow404` is set. */
  async request<T>(method: string, path: string, body?: unknown, opts: { allow404?: boolean; timeoutMs?: number; unversioned?: boolean } = {}): Promise<T | null> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T | null>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: opts.unversioned ? path : `/v${API_VERSION}${path}`,
          headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), Host: "docker" },
          timeout: opts.timeoutMs ?? 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status === 404 && opts.allow404) return resolve(null);
            if (status >= 400) {
              let message = text;
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? text;
              } catch {
                /* plain text */
              }
              return reject(new DockerError(status, message.trim() || `Docker returned ${status}`));
            }
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              resolve(text as unknown as T);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new DockerError(504, `Docker didn't answer ${method} ${path} in time`)));
      req.on("error", (err) => reject(err instanceof DockerError ? err : new DockerError(503, `Docker is unavailable: ${err.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  version() {
    return this.request<{ Version: string; ApiVersion: string; MinAPIVersion: string }>("GET", "/version", undefined, { unversioned: true });
  }
  info() {
    return this.request<EngineInfo>("GET", "/info");
  }
  imageInspect(ref: string) {
    return this.request<{ Id: string }>("GET", `/images/${encodeURIComponent(ref)}/json`, undefined, { allow404: true });
  }
  containerInspect(name: string) {
    return this.request<ContainerInfo>("GET", `/containers/${encodeURIComponent(name)}/json`, undefined, { allow404: true });
  }
  containerList(labels: Record<string, string>, all = true) {
    const filters = JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) });
    return this.request<ContainerSummary[]>("GET", `/containers/json?all=${all ? 1 : 0}&filters=${encodeURIComponent(filters)}`).then((r) => r ?? []);
  }
  async containerCreate(name: string, spec: Json) {
    return (await this.request<{ Id: string; Warnings: string[] | null }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec))!;
  }
  containerStart(id: string) {
    return this.request("POST", `/containers/${encodeURIComponent(id)}/start`).catch((err) => {
      if (err instanceof DockerError && err.status === 304) return null; // already running
      throw err;
    });
  }
  containerStop(id: string, seconds = 5) {
    return this.request("POST", `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`, undefined, { timeoutMs: (seconds + 30) * 1000 }).catch((err) => {
      if (err instanceof DockerError && err.status === 304) return null; // already stopped
      throw err;
    });
  }
  containerKill(id: string) {
    return this.request("POST", `/containers/${encodeURIComponent(id)}/kill`).catch((err) => {
      if (err instanceof DockerError && (err.status === 409 || err.status === 404)) return null; // not running / gone
      throw err;
    });
  }
  containerRemove(id: string) {
    return this.request("DELETE", `/containers/${encodeURIComponent(id)}?force=1&v=0`, undefined, { allow404: true });
  }
  volumeCreate(spec: Json) {
    return this.request<{ Name: string; Labels: Record<string, string> | null }>("POST", "/volumes/create", spec);
  }
  volumeInspect(name: string) {
    return this.request<{ Name: string; Labels: Record<string, string> | null }>("GET", `/volumes/${encodeURIComponent(name)}`, undefined, { allow404: true });
  }
  volumeRemove(name: string) {
    return this.request("DELETE", `/volumes/${encodeURIComponent(name)}`, undefined, { allow404: true });
  }
  volumeList(labels: Record<string, string>) {
    const filters = JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) });
    return this.request<{ Volumes: { Name: string; Labels: Record<string, string>; CreatedAt: string }[] | null }>(
      "GET",
      `/volumes?filters=${encodeURIComponent(filters)}`,
    ).then((r) => r?.Volumes ?? []);
  }
  async execCreate(containerId: string, spec: Json) {
    return (await this.request<{ Id: string }>("POST", `/containers/${encodeURIComponent(containerId)}/exec`, spec))!.Id;
  }
  async execInspect(id: string) {
    return (await this.request<ExecInfo>("GET", `/exec/${encodeURIComponent(id)}/json`))!;
  }

  /**
   * Starts an exec and hijacks the connection: output arrives through `onData` (demultiplexed), stdin can be written
   * to the returned socket. Resolves once the stream is attached. A non-101 reply is an error (e.g. the container
   * isn't running).
   */
  execAttach(id: string, onData: (type: StreamType, data: Buffer) => void): Promise<{ socket: Duplex; ended: Promise<void> }> {
    const body = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.socketPath,
        method: "POST",
        path: `/v${API_VERSION}/exec/${encodeURIComponent(id)}/start`,
        headers: { Host: "docker", "Content-Type": "application/json", "Content-Length": body.length, Connection: "Upgrade", Upgrade: "tcp" },
      });
      req.on("upgrade", (_res, socket, head) => {
        const demux = new DockerDemuxer(onData);
        let resolveEnded!: () => void;
        const ended = new Promise<void>((r) => (resolveEnded = r));
        socket.on("data", (c: Buffer) => {
          try {
            demux.push(c);
          } catch (err) {
            socket.destroy(err as Error);
          }
        });
        socket.on("end", resolveEnded);
        socket.on("close", resolveEnded);
        socket.on("error", () => resolveEnded());
        if (head.length) demux.push(head);
        resolve({ socket, ended });
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let message = text;
          try {
            message = (JSON.parse(text) as { message?: string }).message ?? text;
          } catch {
            /* plain text */
          }
          reject(new DockerError(res.statusCode ?? 500, message.trim() || "exec start failed"));
        });
      });
      req.on("error", (err) => reject(new DockerError(503, `Docker is unavailable: ${err.message}`)));
      req.end(body);
    });
  }

  /** The exit code once Docker has recorded it (it can lag the end of the stream by a few milliseconds). */
  async execExitCode(id: string, waitMs = 3000): Promise<number | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const info = await this.execInspect(id);
      if (!info.Running) return info.ExitCode;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
