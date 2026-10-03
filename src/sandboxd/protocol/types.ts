/** Wire types shared by sandboxd and the portal client. Types only (plus a few constants): no runtime imports. */

/** A sandbox's reference: random, not derived from the user, so it can't be linked back without the database. */
export const REF_RE = /^[a-z0-9]{20}$/;
export const EXEC_ID_RE = /^[a-z0-9]{16}$/;

/** "gvisor": only run under runsc; "any": runc is acceptable (the admin acknowledged it). */
export type Isolation = "gvisor" | "any";
export type Runtime = "runc" | "runsc";

export type ErrorCode =
  | "unauthorized"
  | "bad_request"
  | "outside_workspace"
  | "not_found"
  | "too_large"
  | "isolation_unavailable"
  | "busy"
  | "capacity"
  | "image_missing"
  | "docker_unavailable"
  | "internal";

export type ErrorBody = { error: ErrorCode; message: string };

export type ExecRequest = {
  isolation: Isolation;
  command: string;
  /** Relative to the workspace (default: the workspace itself). */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** A caller-chosen id (EXEC_ID_RE), so the portal can kill this command later. */
  execId: string;
};

export type ReadRequest = { isolation: Isolation; path: string; maxBytes: number; startLine?: number; endLine?: number };
export type WriteRequest = { isolation: Isolation; path: string; contentB64: string };
export type WriteResult = { bytes: number; created: boolean };

export type ListRequest = { isolation: Isolation; path?: string; depth: number; maxEntries: number };
export type ListEntry = { path: string; type: "file" | "dir" | "link" | "other"; size: number };
export type ListResult = { entries: ListEntry[]; truncated: boolean };

export type GrepRequest = { isolation: Isolation; pattern: string; path?: string; glob?: string; ignoreCase?: boolean; maxMatches: number };
export type GrepMatch = { path: string; line: number; text: string };
export type GrepResult = { matches: GrepMatch[]; truncated: boolean };

export type UsageResult = { bytes: number };

export type SandboxState = {
  ref: string;
  state: "running" | "stopped" | "missing";
  runtime: Runtime | null;
  /** The container was created from an older spec (image, runtime or limits changed); it is recreated on next use. */
  drift: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  activeExecs: number;
};

export type Health = {
  ok: boolean;
  docker: { version: string; apiVersion: string } | null;
  gvisor: { available: boolean; reason?: string };
  /** Isolation sandboxd will provide for "any" requests. */
  defaultRuntime: Runtime | null;
  image: { ref: string; present: boolean };
  limits: { memoryMb: number; cpus: number; pids: number; idleMinutes: number; maxRunning: number; maxExecs: number; maxExecSeconds: number };
  running: number;
  warnings: string[];
};
