import { describe, expect, it } from "vitest";
import { workspaceConfigState, workspaceSetupReport } from "@/lib/sandbox/setup";
import { checkWorkspaceHost } from "../../scripts/check-workspace-host.mjs";

const health = { ok: true, docker: { version: "fixture", apiVersion: "fixture" }, image: { present: true, ref: "PRIVATE_IMAGE" },
  gvisor: { available: true, reason: "PRIVATE_REASON" }, defaultRuntime: "runsc", warnings: ["CANARY_SECRET"] };
const report = (over: Partial<Parameters<typeof workspaceSetupReport>[0]> = {}) => workspaceSetupReport({ config: "configured", health, allowRunc: false, ...over });

describe("workspace readiness", () => {
  it("reports missing/invalid config without returning values", () => {
    expect(workspaceConfigState({})).toBe("missing_url");
    expect(workspaceConfigState({ SANDBOXD_URL: "http://sandboxd:4200" })).toBe("missing_secret");
    const secret = "CANARY_SECRET".repeat(4);
    for (const url of ["bad", "https://sandboxd:4200", "http://user:pass@sandboxd:4200", "http://sandboxd:4200/path", "http://sandboxd:4200/?secret=CANARY_SECRET", "http://sandboxd:4200/#CANARY_SECRET"]) {
      expect(workspaceConfigState({ SANDBOXD_URL: url, SANDBOXD_SECRET: secret })).toBe("invalid");
    }
    expect(workspaceConfigState({ SANDBOXD_URL: "http://sandboxd:4200", SANDBOXD_SECRET: "short" })).toBe("invalid");
    expect(workspaceConfigState({ SANDBOXD_URL: "http://sandboxd:4200", SANDBOXD_SECRET: secret })).toBe("configured");
    expect(report({ config: "missing_url" })).toMatchObject({ ready: false, hasWarnings: false });
  });
  it("only passes with every prerequisite and never reflects raw daemon text", () => {
    expect(report()).toMatchObject({ ready: true, hasWarnings: true });
    expect(JSON.stringify(report())).not.toMatch(/CANARY_SECRET|PRIVATE_IMAGE|PRIVATE_REASON|fixture/);
    for (const bad of [null, {}, { ...health, ok: false }, { ...health, docker: null }, { ...health, image: { present: false } }, { ...health, ok: "true" }, { ...health, gvisor: { available: "yes" } }]) {
      expect(report({ health: bad }).ready).toBe(false);
    }
    for (const errorCode of ["unreachable", "timeout", "unauthorized", "protocol", "internal"]) {
      expect(report({ errorCode }).ready).toBe(false);
    }
    expect(report({ errorCode: "unauthorized" }).checks[1].detail).toContain("Match the shared secret");
    expect(report({ errorCode: "timeout" }).checks[1].detail).toContain("timed out");
  });
  it("requires the saved isolation policy and usable runtime", () => {
    const standard = { ...health, gvisor: { available: false }, defaultRuntime: "runc" };
    expect(report({ health: standard }).ready).toBe(false);
    expect(report({ health: standard, allowRunc: true }).ready).toBe(true);
    expect(report({ health: { ...standard, defaultRuntime: null }, allowRunc: true }).ready).toBe(false);
    expect(report({ health: { ...health, defaultRuntime: null } }).ready).toBe(false);
    expect(report({ health: { ...health, defaultRuntime: "runc" } }).ready).toBe(false);
  });
});

describe("read-only Linux host preflight", () => {
  const secret = "CANARY_SECRET_012345678901234567890123456789";
  const env = { SANDBOXD_SECRET: secret, DOCKER_GID: "999", SANDBOXD_IMAGE: "custom:p5", DOCKER_HOST: "unix:///var/run/docker.sock" };
  const stat = () => ({ isSocket: () => true, gid: 999 });
  const info = { OSType: "linux", Runtimes: { runsc: {} } };
  it("uses only info, image inspect and quiet Compose validation; preserves shell precedence", () => {
    const calls: string[][] = [];
    const result = checkWorkspaceHost({ platform: "linux", env, stat, read: () => "SANDBOXD_RUNTIME=runsc\nSANDBOXD_IMAGE=other:p5", run: args => { calls.push(args); return args[0] === "info" ? JSON.stringify(info) : ""; } });
    expect(result.ready).toBe(true);
    expect(calls).toEqual([["info", "--format", "{{json .}}"], ["image", "inspect", "custom:p5", "--format", "{{.Id}}"],
      ["compose", "--env-file", ".env", "-f", "docker-compose.yml", "-f", "docker-compose.sandbox.yml", "config", "--quiet"]]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("handles failures with exact next steps and no reflected command output", () => {
    const result = checkWorkspaceHost({ platform: "linux", env: {}, read: () => { throw new Error(secret); }, run: () => { throw new Error(secret); } });
    expect(result.ready).toBe(false);
    expect(result.checks.filter(c => !c.ok).map(c => c.label)).toEqual(["Operator env file", "Shared secret", "Docker socket group", "Docker connection", "Compose configuration"]);
    expect(JSON.stringify(result)).not.toContain(secret);
    const missing = checkWorkspaceHost({ platform: "linux", env: { ...env, SANDBOXD_RUNTIME: "auto" }, stat, read: () => "", run: args => {
      if (args[0] === "info") return JSON.stringify({ OSType: "windows", Runtimes: {} });
      if (args[0] === "image") throw new Error(secret);
      return "";
    } });
    expect(missing.ready).toBe(false);
    expect(missing.checks.filter(c => !c.ok).map(c => c.label)).toEqual(["gVisor required", "Linux Docker engine", "runsc registered", "Workspace image"]);
  });
  it("rejects the wrong socket group and remote context even if Docker answers", () => {
    const run = (args: string[]) => args[0] === "info" ? JSON.stringify(info) : JSON.stringify("unix:///var/run/docker.sock");
    for (const over of [{ DOCKER_GID: "123" }, { DOCKER_HOST: "tcp://remote.invalid:2376" }]) {
      const result = checkWorkspaceHost({ platform: "linux", env: { ...env, ...over }, stat, read: () => "", run });
      expect(result.ready).toBe(false); expect(result.checks.find(c => c.label === "Docker socket group")?.ok).toBe(false);
    }
    expect(checkWorkspaceHost({ platform: "linux", env: { ...env, DOCKER_HOST: "" }, stat, read: () => "", run }).ready).toBe(true);
    const remoteContext = checkWorkspaceHost({ platform: "linux", env: { ...env, DOCKER_CONTEXT: "remote" }, stat, read: () => "", run: args => {
      if (args[0] === "context") { expect(args.at(-1)).toBe("remote"); return JSON.stringify("ssh://remote.invalid"); }
      return run(args);
    } });
    expect(remoteContext.ready).toBe(false); expect(remoteContext.checks.find(c => c.label === "Docker socket group")?.ok).toBe(false);
  });
  it("does not access Docker or files on unsupported operator platforms", () => {
    const fail = () => { throw new Error("must not be called"); };
    expect(checkWorkspaceHost({ platform: "darwin", read: fail, run: fail }).checks).toHaveLength(1);
    expect(checkWorkspaceHost({ platform: "win32", read: fail, run: fail }).ready).toBe(false);
  });
});
