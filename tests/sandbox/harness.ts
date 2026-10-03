import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SandboxdClient } from "@/lib/sandbox/client";
import { loadConfig, type Config } from "@/sandboxd/config";
import { Docker } from "@/sandboxd/docker";
import { Manager } from "@/sandboxd/manager";
import { createServer } from "@/sandboxd/server";
import { LABEL_INSTANCE } from "@/sandboxd/spec";

/** Against a real dockerd with the sandbox image built (npm run sandbox:image). Opt in with SANDBOX_DOCKER=1. */
export const enabled = process.env.SANDBOX_DOCKER === "1";

export const newRef = () => randomBytes(10).toString("hex");
export const newExecId = () => randomBytes(8).toString("hex");

export type Harness = { client: SandboxdClient; manager: Manager; config: Config; docker: Docker; url: string; close: () => Promise<void> };

/** Starts an in-process sandboxd on a random port with its own instance label, and cleans up everything it made. */
export async function startSandboxd(env: Record<string, string> = {}): Promise<Harness> {
  const secret = randomBytes(32).toString("hex");
  const instance = `test-${randomBytes(4).toString("hex")}`;
  const config = loadConfig({
    SANDBOXD_SECRET: secret,
    SANDBOXD_LISTEN: "127.0.0.1:0",
    SANDBOXD_INSTANCE: instance,
    SANDBOXD_MEMORY_MB: "256",
    SANDBOXD_CPUS: "1",
    SANDBOXD_PIDS: "128",
    SANDBOXD_FSIZE_MB: "16",
    SANDBOXD_TMP_MB: "64",
    SANDBOXD_RUNTIME: process.env.SANDBOX_TEST_RUNTIME ?? "auto",
    ...env,
  });
  const docker = new Docker(config.socketPath);
  const manager = new Manager(docker, config);
  await manager.init();
  const server = createServer(manager, config, () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: new SandboxdClient({ url, secret }),
    manager,
    config,
    docker,
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const c of await docker.containerList({ [LABEL_INSTANCE]: instance })) await docker.containerRemove(c.Id);
      for (const v of await docker.volumeList({ [LABEL_INSTANCE]: instance })) await docker.volumeRemove(v.Name);
    },
  };
}

/** Runs a command to completion, collecting its output. */
export async function run(h: Harness, ref: string, command: string, opts: { timeoutMs?: number; isolation?: "gvisor" | "any"; signal?: AbortSignal; execId?: string } = {}) {
  let out = "";
  let err = "";
  const gaps: { s: string; n: number }[] = [];
  let started = false;
  const exit = await h.client.exec(
    ref,
    { isolation: opts.isolation ?? "any", command, timeoutMs: opts.timeoutMs ?? 30_000, execId: opts.execId ?? newExecId() },
    {
      signal: opts.signal,
      onFrame: (f) => {
        if (f.t === "start") started = true;
        else if (f.t === "out") out += Buffer.from(f.d, "base64").toString();
        else if (f.t === "err") err += Buffer.from(f.d, "base64").toString();
        else if (f.t === "gap") gaps.push({ s: f.s, n: f.n });
      },
    },
  );
  return { ...exit, out, err, gaps, started };
}
