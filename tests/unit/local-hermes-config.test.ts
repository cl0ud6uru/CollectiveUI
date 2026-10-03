import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { childEnvironment, ControllerConfig, HERMES_COMMIT, installationId, validateInstallation } from "@/local-hermes/config";

const native = vi.hoisted(() => ({ head: "", dirty: "", security: '{"scanner":false,"lazy":false,"unsafe":false}', calls: [] as { file: string; args: string[]; options: Record<string, unknown> }[] }));
vi.mock("node:child_process", () => ({ execFile: (file: string, args: string[], options: Record<string, unknown>, callback: (e: null, result: unknown) => void) => {
  native.calls.push({ file, args, options });
  const stdout = args[0] === "rev-parse" ? native.head : args[0] === "status" ? native.dirty : native.security;
  callback(null, { stdout, stderr: "" });
} }));
let root: string, config: ControllerConfig;
beforeEach(async () => {
  root = await mkdtemp("/tmp/local-hermes-config-"); native.head = HERMES_COMMIT; native.dirty = ""; native.security = '{"scanner":false,"lazy":false,"unsafe":false}'; native.calls = [];
  for (const dir of ["source/tui_gateway", "profile", "work", "account", "state", "ipc"]) await mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "source/tui_gateway/entry.py"), "# fixture only"); await writeFile(path.join(root, "profile/config.yaml"), "{}");
  config = ControllerConfig.parse({ trust: "single-user-exclusive-profile", python: "/usr/bin/python3", source: path.join(root, "source"), profileHome: path.join(root, "profile"), workDir: path.join(root, "work"), accountHome: path.join(root, "account"), stateDir: path.join(root, "state"), socketPath: path.join(root, "ipc/c.sock"), label: "Fixture" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("Local Hermes operator configuration", () => {
  it("canonicalizes profile selection before hashing and uses fixed argv without an inherited environment", async () => {
    await symlink(config.profileHome, path.join(root, "alias"));
    const selected = await validateInstallation({ ...config, profileHome: path.join(root, "alias") });
    expect(selected.profileHome).toBe(config.profileHome); expect(installationId(selected)).toBe(installationId(config));
    expect(native.calls[0]).toMatchObject({ file: "/usr/bin/git", args: ["rev-parse", "HEAD"] });
    expect(native.calls.at(-1)?.options.env).not.toHaveProperty("DATABASE_URL");
    expect(childEnvironment(selected).TIRITH_BIN).toBe(path.join(config.profileHome, "bin/tirith"));
  });
  it("refuses an unsupported or modified source checkout", async () => {
    native.head = "moving-main"; await expect(validateInstallation(config)).rejects.toThrow("unmodified Hermes");
    native.head = HERMES_COMMIT; native.dirty = " M tui_gateway/entry.py"; await expect(validateInstallation(config)).rejects.toThrow("unmodified Hermes");
  });
  it("rejects world-accessible state/IPC and aliased socket paths", async () => {
    await chmod(config.stateDir, 0o755); await expect(validateInstallation(config)).rejects.toThrow("accessible to other users");
    await chmod(config.stateDir, 0o700); await symlink(path.dirname(config.socketPath), path.join(root, "ipc-alias"));
    await expect(validateInstallation({ ...config, socketPath: path.join(root, "ipc-alias/c.sock") })).rejects.toThrow("canonical socket");
  });
  it("requires an existing native security scanner when enabled, with no installer call", async () => {
    native.security = '{"scanner":true,"lazy":false,"unsafe":false}'; await expect(validateInstallation(config)).rejects.toThrow("Automatic downloads are disabled");
    const scanner = path.join(root, "scanner"); await writeFile(scanner, "#!/bin/false\n", { mode: 0o700 });
    await expect(validateInstallation({ ...config, tirithPath: scanner })).resolves.toMatchObject({ tirithPath: scanner });
    expect(native.calls.every(c => c.file === "/usr/bin/git" || c.file === config.python)).toBe(true);
  });
  it("refuses native lazy installation and conflicting environment policy", async () => {
    for (const policy of [{ scanner: false, lazy: true, unsafe: false }, { scanner: false, lazy: false, unsafe: true }]) {
      native.security = JSON.stringify(policy);
      await expect(validateInstallation(config)).rejects.toThrow("Native profile policy is incompatible");
    }
    expect(childEnvironment(config).HERMES_LAZY_INSTALL_TARGET).toBe("");
  });
  it("rejects metadata inside native state and unknown process parameters", async () => {
    await expect(validateInstallation({ ...config, stateDir: config.profileHome })).rejects.toThrow("outside the Hermes profile");
    expect(() => ControllerConfig.parse({ ...config, shell: "arbitrary" })).toThrow();
  });
});
