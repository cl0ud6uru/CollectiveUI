/**
 * The container, volume and exec specs, as pure functions (unit-tested field by field). These are the security
 * boundary sandboxd enforces with docker.sock: nothing else in sandboxd builds a Docker request body.
 */
import { createHash } from "node:crypto";
import type { Runtime } from "./protocol/types.ts";

export const LABEL_SANDBOX = "ai-portal.sandbox";
export const LABEL_SPEC = "ai-portal.spec";
export const LABEL_RUNTIME = "ai-portal.runtime";
export const LABEL_KIND = "ai-portal.kind";
/** Which sandboxd owns it (tests run their own instance next to a dev one). */
export const LABEL_INSTANCE = "ai-portal.instance";

export const HOME = "/home/agent";
export const WORKSPACE = "/home/agent/workspace";
export const AGENT_USER = "1000:1000";

/** The only environment a sandbox has. No secrets, ever; commands add their own through run-agent. */
export const SANDBOX_ENV = [
  `HOME=${HOME}`,
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "LANG=C.UTF-8",
  "TERM=dumb",
  "PAGER=cat",
  "GIT_PAGER=cat",
  "CI=1",
];

export type Limits = {
  memoryMb: number;
  cpus: number;
  pids: number;
  nofile: number;
  fsizeMb: number;
  tmpMb: number;
  shmMb: number;
};

const MB = 1024 * 1024;

export const containerName = (ref: string) => `portal-sbx-${ref}`;
export const volumeName = (ref: string) => `portal-home-${ref}`;

export function volumeSpec(ref: string, instance = "default", kind: "workspace" | "probe" = "workspace") {
  return { Name: volumeName(ref), Driver: "local", Labels: { [LABEL_SANDBOX]: ref, [LABEL_KIND]: kind, [LABEL_INSTANCE]: instance } };
}

type SpecInput = { ref: string; imageId: string; runtime: Runtime; limits: Limits; kind?: "workspace" | "probe"; instance?: string };

function baseSpec(i: SpecInput) {
  return {
    Image: i.imageId,
    Cmd: ["sleep", "infinity"],
    User: AGENT_USER,
    Hostname: "workspace",
    WorkingDir: HOME,
    Env: SANDBOX_ENV,
    HostConfig: {
      Init: true,
      Runtime: i.runtime,
      NetworkMode: "none",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      // /home/agent is executable anyway (a volume), so /tmp gets exec too: builds and test runners use it.
      Tmpfs: { "/tmp": `rw,nosuid,nodev,exec,size=${i.limits.tmpMb}m` },
      ShmSize: i.limits.shmMb * MB,
      Memory: i.limits.memoryMb * MB,
      MemorySwap: i.limits.memoryMb * MB, // no swap
      NanoCpus: Math.round(i.limits.cpus * 1e9),
      PidsLimit: i.limits.pids,
      Ulimits: [
        { Name: "nofile", Soft: i.limits.nofile, Hard: i.limits.nofile },
        { Name: "fsize", Soft: i.limits.fsizeMb * MB, Hard: i.limits.fsizeMb * MB },
      ],
      OomScoreAdj: 500, // the host kills sandboxes before the portal or Postgres
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no" },
      AutoRemove: false,
      Privileged: false,
      Mounts: [{ Type: "volume", Source: volumeName(i.ref), Target: HOME, ReadOnly: false }],
    },
  };
}

/** Hash of everything that shapes the container (not its labels): a change means "recreate on next use". */
export function specHash(i: Omit<SpecInput, "kind" | "instance">): string {
  return createHash("sha256").update(JSON.stringify(baseSpec({ ...i, ref: "x" }))).digest("hex").slice(0, 16);
}

export function containerSpec(i: SpecInput) {
  const spec = baseSpec(i);
  return {
    ...spec,
    Labels: {
      [LABEL_SANDBOX]: i.ref,
      [LABEL_KIND]: i.kind ?? "workspace",
      [LABEL_SPEC]: specHash(i),
      [LABEL_RUNTIME]: i.runtime,
      [LABEL_INSTANCE]: i.instance ?? "default",
    },
  };
}

/**
 * Every exec body. Always the unprivileged agent user, never a TTY, never Privileged; the environment is the
 * container's (callers' variables go through run-agent to the child only).
 */
export function execSpec(cmd: string[], opts: { stdin: boolean }) {
  return {
    AttachStdin: opts.stdin,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Privileged: false,
    User: AGENT_USER,
    WorkingDir: HOME,
    Cmd: cmd,
  };
}
