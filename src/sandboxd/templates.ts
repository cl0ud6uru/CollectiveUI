/**
 * The only commands sandboxd runs inside a sandbox, as argv (no shell) for fixed helpers in /opt/portal. Only
 * workspace-exec runs a shell, and only inside run-agent. Every argument is validated here; the helpers validate
 * again inside the container (paths are confined there, where symlinks can be resolved).
 */
import { EXEC_ID_RE } from "./protocol/types.ts";

export const RUN_AGENT = "/opt/portal/run-agent";
export const KILL_RUN = "/opt/portal/kill-run";
export const FSOPS = "/opt/portal/fsops";

export const MAX_COMMAND = 16_384;
export const MAX_PATH = 4096;
export const MAX_ENV_KEYS = 32;
export const MAX_ENV_VALUE = 4096;

export class TemplateError extends Error {}

const noNul = (s: string, what: string, max: number) => {
  if (typeof s !== "string" || s.length === 0) throw new TemplateError(`${what} is required`);
  if (s.length > max) throw new TemplateError(`${what} is too long`);
  if (s.includes("\0")) throw new TemplateError(`${what} contains a NUL byte`);
  return s;
};

const int = (n: unknown, what: string, min: number, max: number) => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new TemplateError(`${what} must be an integer from ${min} to ${max}`);
  return String(n);
};

/** Variables a command may set for itself. Never ones that change how the shell or loader start. */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_DENY = /^(LD_|BASH_FUNC_|PORTAL_)|^(BASH_ENV|ENV|PATH|HOME|SHELL|SHELLOPTS|BASHOPTS|IFS|PS4|PROMPT_COMMAND)$/;

export function validateEnv(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const keys = Object.keys(env);
  if (keys.length > MAX_ENV_KEYS) throw new TemplateError(`At most ${MAX_ENV_KEYS} environment variables`);
  return keys.map((k) => {
    if (!ENV_KEY_RE.test(k) || ENV_DENY.test(k)) throw new TemplateError(`Environment variable ${k} is not allowed`);
    const v = env[k];
    if (typeof v !== "string" || v.length > MAX_ENV_VALUE || v.includes("\0")) throw new TemplateError(`Environment variable ${k} has an invalid value`);
    return `${k}=${v}`;
  });
}

export function workspaceExec(i: { execId: string; command: string; cwd?: string; env?: Record<string, string>; timeoutSec: number }): string[] {
  if (!EXEC_ID_RE.test(i.execId)) throw new TemplateError("Invalid exec id");
  const env = validateEnv(i.env).flatMap((kv) => ["--env", kv]);
  return [
    RUN_AGENT,
    "--id",
    i.execId,
    "--timeout",
    int(i.timeoutSec, "timeout", 1, 3600),
    "--cwd",
    i.cwd ? noNul(i.cwd, "cwd", MAX_PATH) : ".",
    ...env,
    "--",
    "bash",
    "--noprofile",
    "--norc",
    "-c",
    noNul(i.command, "command", MAX_COMMAND),
  ];
}

export function killRun(execId: string): string[] {
  if (!EXEC_ID_RE.test(execId)) throw new TemplateError("Invalid exec id");
  return [KILL_RUN, execId];
}

export function fsRead(i: { path: string; maxBytes: number; startLine?: number; endLine?: number }): string[] {
  const range = [
    ...(i.startLine !== undefined ? ["--start-line", int(i.startLine, "startLine", 1, 10_000_000)] : []),
    ...(i.endLine !== undefined ? ["--end-line", int(i.endLine, "endLine", 1, 10_000_000)] : []),
  ];
  return [FSOPS, "read", "--max-bytes", int(i.maxBytes, "maxBytes", 1, 16 * 1024 * 1024), ...range, "--", noNul(i.path, "path", MAX_PATH)];
}

export function fsWrite(i: { path: string; maxBytes: number }): string[] {
  return [FSOPS, "write", "--max-bytes", int(i.maxBytes, "maxBytes", 0, 16 * 1024 * 1024), "--", noNul(i.path, "path", MAX_PATH)];
}

export function fsList(i: { path?: string; depth: number; maxEntries: number }): string[] {
  return [
    FSOPS,
    "list",
    "--depth",
    int(i.depth, "depth", 1, 3),
    "--max-entries",
    int(i.maxEntries, "maxEntries", 1, 500),
    "--",
    i.path ? noNul(i.path, "path", MAX_PATH) : ".",
  ];
}

export function fsGrep(i: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; maxMatches: number }): string[] {
  return [
    FSOPS,
    "grep",
    "--max-matches",
    int(i.maxMatches, "maxMatches", 1, 200),
    ...(i.ignoreCase ? ["--ignore-case"] : []),
    ...(i.glob ? ["--glob", noNul(i.glob, "glob", 256)] : []),
    "--",
    noNul(i.pattern, "pattern", 1024),
    i.path ? noNul(i.path, "path", MAX_PATH) : ".",
  ];
}

export const fsUsage = (): string[] => [FSOPS, "du"];
