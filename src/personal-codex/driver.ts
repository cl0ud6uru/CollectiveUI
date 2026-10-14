import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ComputerInput } from '../lib/computer/contracts';
export type { ComputerInput } from '../lib/computer/contracts';

/** Strict events accepted by the optional local computer adapter. Coordinates are CSS pixels. */
export type ComputerStatus = {
  available: boolean;
  running: boolean;
  width: 1280;
  height: 800;
};

/** Small broker-facing surface shared by the existing Docker runtime and optional local adapters. */
export interface PersonalCodexRuntimeDriver {
  readonly config: { socketPath: string; owners: string[]; siwcSandboxVerified?: boolean };
  name(owner: string): string;
  inspect(owner: string): Promise<{ State: { Running: boolean } } | null>;
  ensure(owner: string): Promise<void>;
  startRetained(owner: string): Promise<void>;
  bridge(owner: string): Promise<ChildProcessWithoutNullStreams>;
  synchronizeToken(owner: string, accessToken: string, credentialBinding: string): Promise<void>;
  clearToken(owner: string): Promise<void>;
  computerStatus(owner: string): Promise<ComputerStatus>;
  computerFrame(owner: string): Promise<Buffer>;
  computerInput(owner: string, input: ComputerInput): Promise<void>;
  computerPause(owner: string, paused: boolean): Promise<void>;
  stop?(owner: string): Promise<void>;
  cleanup?(owner: string): Promise<void>;
}
