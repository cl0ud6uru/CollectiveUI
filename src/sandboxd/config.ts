/**
 * sandboxd configuration, from its own SANDBOXD_* environment only (it never sees the portal's database URL or
 * keys). Capacity limits live here, not in portal settings, so a compromised portal can't raise them.
 */
import { assertSecret } from "./protocol/auth.ts";
import type { Limits } from "./spec.ts";

export type RuntimePolicy = "auto" | "runsc" | "runc";

export type Config = {
  secret: string;
  host: string;
  port: number;
  socketPath: string;
  image: string;
  runtime: RuntimePolicy;
  instance: string;
  limits: Limits;
  idleMinutes: number;
  maxRunning: number;
  maxExecs: number;
  maxExecSeconds: number;
  /** A command producing more than this (stdout + stderr) is stopped. */
  outputLimitBytes: number;
  /** Per stream: the first headBytes are streamed live, then only the last tailBytes are kept. */
  headBytes: number;
  tailBytes: number;
};

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}`);
  return n;
}

function count(env: Env, key: string, def: number, min: number, max: number): number {
  const n = num(env, key, def, min, max);
  if (!Number.isInteger(n)) throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const secret = env.SANDBOXD_SECRET;
  assertSecret(secret);
  const listen = env.SANDBOXD_LISTEN ?? "127.0.0.1:4200";
  const m = /^(.+):(\d{1,5})$/.exec(listen);
  if (!m) throw new Error("SANDBOXD_LISTEN must look like host:port");
  const runtime = (env.SANDBOXD_RUNTIME ?? "auto") as RuntimePolicy;
  if (!["auto", "runsc", "runc"].includes(runtime)) throw new Error("SANDBOXD_RUNTIME must be auto, runsc or runc");
  const instance = env.SANDBOXD_INSTANCE ?? "default";
  if (!/^[a-z0-9-]{1,32}$/.test(instance)) throw new Error("SANDBOXD_INSTANCE must be 1-32 lowercase letters, digits or dashes");
  const socket = env.SANDBOXD_DOCKER_SOCKET ?? env.DOCKER_HOST?.replace(/^unix:\/\//, "") ?? "/var/run/docker.sock";
  if (!socket.startsWith("/")) throw new Error("sandboxd talks to Docker over a unix socket (SANDBOXD_DOCKER_SOCKET)");
  return {
    secret,
    host: m[1],
    port: Number(m[2]),
    socketPath: socket,
    image: env.SANDBOXD_IMAGE ?? "ai-portal-sandbox:p5",
    runtime,
    instance,
    limits: {
      memoryMb: num(env, "SANDBOXD_MEMORY_MB", 2048, 256, 65536),
      cpus: num(env, "SANDBOXD_CPUS", 2, 0.25, 64),
      pids: num(env, "SANDBOXD_PIDS", 512, 64, 32768),
      nofile: num(env, "SANDBOXD_NOFILE", 4096, 256, 20000),
      fsizeMb: num(env, "SANDBOXD_FSIZE_MB", 4096, 16, 262144),
      tmpMb: num(env, "SANDBOXD_TMP_MB", 512, 16, 16384),
      shmMb: num(env, "SANDBOXD_SHM_MB", 64, 16, 4096),
    },
    idleMinutes: num(env, "SANDBOXD_IDLE_MINUTES", 20, 0.01, 1440),
    maxRunning: count(env, "SANDBOXD_MAX_RUNNING", 10, 1, 1000),
    maxExecs: num(env, "SANDBOXD_MAX_EXECS", 4, 1, 64),
    maxExecSeconds: num(env, "SANDBOXD_MAX_EXEC_SECONDS", 600, 5, 3600),
    outputLimitBytes: num(env, "SANDBOXD_OUTPUT_LIMIT_MB", 16, 1, 1024) * 1024 * 1024,
    headBytes: num(env, "SANDBOXD_STREAM_HEAD_KB", 256, 4, 65536) * 1024,
    tailBytes: num(env, "SANDBOXD_STREAM_TAIL_KB", 256, 4, 65536) * 1024,
  };
}
