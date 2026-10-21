/** Server-installed sandbox profiles. Request bodies can select a key, never an image or Docker option. */
import type { Limits } from "./spec.ts";

type WorkspaceCapabilities = {
  shell: boolean;
  officeHeadless: boolean;
  dotnet: boolean;
  agentBrowserView: boolean;
};

export type WorkspaceRuntimeProfile = {
  key: string;
  /** Template image IDs come only from daemon configuration; definitions alone do not install an image. */
  imageRef: string | null;
  /** Required immutable starter bundle copied by the pinned image entrypoint. */
  seedBundleKey: string | null;
  capabilities: WorkspaceCapabilities;
  /** A ceiling. The daemon's configured limits always remain authoritative. */
  maxLimits: Limits;
  /** Fixed by the daemon; profiles cannot choose mounts or workspace roots. */
  workspaceRoot: "/home/agent/workspace";
};

const PROFILE_LIMITS: Limits = {
  memoryMb: 2048,
  cpus: 2,
  pids: 512,
  nofile: 4096,
  fsizeMb: 4096,
  tmpMb: 512,
  shmMb: 64,
};

const DAEMON_CONFIG_MAX: Limits = {
  memoryMb: 65536,
  cpus: 64,
  pids: 32768,
  nofile: 20000,
  fsizeMb: 262144,
  tmpMb: 16384,
  shmMb: 4096,
};

const profile = (key: string, imageRef: string | null, seedBundleKey: string | null, capabilities: WorkspaceCapabilities): WorkspaceRuntimeProfile => ({
  key,
  imageRef,
  seedBundleKey,
  capabilities,
  maxLimits: PROFILE_LIMITS,
  workspaceRoot: "/home/agent/workspace",
});

/**
 * Profile keys are pinned by published recipes. Image refs are installed with the daemon and resolved to Docker image
 * IDs before use. Template images are optional at daemon startup so a missing starter image does not disable legacy.
 */
export const WORKSPACE_PROFILES: Readonly<Record<string, WorkspaceRuntimeProfile>> = Object.freeze({
  "knowledge-work-v1": profile("knowledge-work-v1", null, "knowledge-work-v1", {
    shell: true,
    officeHeadless: true,
    dotnet: false,
    agentBrowserView: false,
  }),
  "dotnet-linux-v1": profile("dotnet-linux-v1", null, "dotnet-linux-v1", {
    shell: true,
    officeHeadless: false,
    dotnet: true,
    agentBrowserView: false,
  }),
});

export const LEGACY_PROFILE_KEY = "legacy";

export function getWorkspaceRuntimeProfile(key: string, legacyImageRef = "ai-portal-sandbox:p5", images: Readonly<Record<string, string>> = {}): WorkspaceRuntimeProfile | null {
  if (key === LEGACY_PROFILE_KEY) {
    return { ...profile(LEGACY_PROFILE_KEY, legacyImageRef, null, {
      shell: true,
      officeHeadless: true,
      dotnet: false,
      agentBrowserView: false,
    }), maxLimits: DAEMON_CONFIG_MAX };
  }
  const definition = Object.hasOwn(WORKSPACE_PROFILES, key) ? WORKSPACE_PROFILES[key] : null;
  return definition ? { ...definition, imageRef: images[key] ?? null } : null;
}

/** Per-profile values only lower the administrator's daemon limits. */
export function effectiveProfileLimits(daemon: Limits, profileLimits: Limits): Limits {
  return {
    memoryMb: Math.min(daemon.memoryMb, profileLimits.memoryMb),
    cpus: Math.min(daemon.cpus, profileLimits.cpus),
    pids: Math.min(daemon.pids, profileLimits.pids),
    nofile: Math.min(daemon.nofile, profileLimits.nofile),
    fsizeMb: Math.min(daemon.fsizeMb, profileLimits.fsizeMb),
    tmpMb: Math.min(daemon.tmpMb, profileLimits.tmpMb),
    shmMb: Math.min(daemon.shmMb, profileLimits.shmMb),
  };
}
