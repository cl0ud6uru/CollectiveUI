import { describe, expect, it } from "vitest";
import { containerSpec, execSpec, LABEL_RUNTIME, LABEL_SANDBOX, LABEL_SPEC, SANDBOX_ENV, specHash, volumeSpec, type Limits } from "@/sandboxd/spec";
import { fsGrep, fsList, fsRead, fsWrite, killRun, TemplateError, validateEnv, workspaceExec } from "@/sandboxd/templates";
import { redactSecrets } from "@/lib/redact";

const limits: Limits = { memoryMb: 1024, cpus: 1.5, pids: 256, nofile: 4096, fsizeMb: 2048, tmpMb: 512, shmMb: 64 };
const spec = (runtime: "runc" | "runsc" = "runsc") => containerSpec({ ref: "a".repeat(20), imageId: "sha256:abc", runtime, limits });

describe("sandbox container spec", () => {
  it("has every hardening field", () => {
    const s = spec();
    expect(s.User).toBe("1000:1000");
    expect(s.Cmd).toEqual(["sleep", "infinity"]);
    expect(s.HostConfig).toMatchObject({
      Init: true,
      Runtime: "runsc",
      NetworkMode: "none",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,exec,size=512m" },
      ShmSize: 64 * 1024 * 1024,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      PidsLimit: 256,
      OomScoreAdj: 500,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no" },
      AutoRemove: false,
      Privileged: false,
    });
    expect(s.HostConfig.Ulimits).toEqual([
      { Name: "nofile", Soft: 4096, Hard: 4096 },
      { Name: "fsize", Soft: 2048 * 1024 * 1024, Hard: 2048 * 1024 * 1024 },
    ]);
    expect(s.HostConfig.Mounts).toEqual([{ Type: "volume", Source: `portal-home-${"a".repeat(20)}`, Target: "/home/agent", ReadOnly: false }]);
  });

  it("has no way out: no binds, ports, devices, extra capabilities, socket or host namespaces", () => {
    const text = JSON.stringify(spec());
    for (const key of ["Binds", "PortBindings", "ExposedPorts", "Devices", "CapAdd", "PidMode", "IpcMode", "UsernsMode", "VolumesFrom", "ExtraHosts", "Links"])
      expect(text).not.toContain(`"${key}"`);
    expect(text).not.toContain("docker.sock");
    expect(text).not.toMatch(/unconfined|label=disable|seccomp/);
    expect(spec().HostConfig.Mounts.every((m) => m.Type === "volume")).toBe(true);
  });

  it("carries only allowlisted, secret-free environment", () => {
    expect(spec().Env).toEqual(SANDBOX_ENV);
    for (const kv of SANDBOX_ENV) expect(redactSecrets(kv)).toBe(kv);
    expect(SANDBOX_ENV.map((kv) => kv.split("=")[0])).toEqual(["HOME", "PATH", "LANG", "TERM", "PAGER", "GIT_PAGER", "CI"]);
  });

  it("labels the container, and the spec hash changes with image, runtime or limits only", () => {
    const s = spec();
    expect(s.Labels).toMatchObject({ [LABEL_SANDBOX]: "a".repeat(20), [LABEL_RUNTIME]: "runsc", [LABEL_SPEC]: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const base = { imageId: "sha256:abc", runtime: "runsc" as const, limits };
    const h = specHash({ ...base, ref: "a".repeat(20) });
    expect(specHash({ ...base, ref: "b".repeat(20) })).toBe(h);
    expect(specHash({ ...base, ref: "x", imageId: "sha256:def" })).not.toBe(h);
    expect(specHash({ ...base, ref: "x", runtime: "runc" })).not.toBe(h);
    expect(specHash({ ...base, ref: "x", limits: { ...limits, pids: 512 } })).not.toBe(h);
    expect(volumeSpec("a".repeat(20))).toEqual({
      Name: `portal-home-${"a".repeat(20)}`,
      Driver: "local",
      Labels: { [LABEL_SANDBOX]: "a".repeat(20), "ai-portal.kind": "workspace", "ai-portal.instance": "default" },
    });
  });

  it("every exec runs as the agent user, unprivileged, without a TTY", () => {
    for (const cmd of [
      workspaceExec({ execId: "a".repeat(16), command: "ls", timeoutSec: 10 }),
      killRun("a".repeat(16)),
      fsRead({ path: "x", maxBytes: 10 }),
      fsWrite({ path: "x", maxBytes: 10 }),
    ]) {
      const e = execSpec(cmd, { stdin: true });
      expect(e).toEqual({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Privileged: false, User: "1000:1000", WorkingDir: "/home/agent", Cmd: cmd });
      expect(Object.keys(e)).not.toContain("Env");
    }
  });
});

describe("sandbox command templates", () => {
  it("only workspace-exec runs a shell, inside run-agent", () => {
    const argv = workspaceExec({ execId: "a".repeat(16), command: "echo hi && id -u", cwd: "src", env: { FOO: "bar" }, timeoutSec: 30 });
    expect(argv).toEqual(["/opt/portal/run-agent", "--id", "a".repeat(16), "--timeout", "30", "--cwd", "src", "--env", "FOO=bar", "--", "bash", "--noprofile", "--norc", "-c", "echo hi && id -u"]);
    for (const other of [fsRead({ path: "a", maxBytes: 1 }), fsList({ depth: 2, maxEntries: 10 }), fsGrep({ pattern: "-rf", maxMatches: 5 }), killRun("b".repeat(16))])
      expect(other.join(" ")).not.toMatch(/\bbash\b|\bsh\b/);
  });

  it("keeps option-looking arguments after --", () => {
    expect(fsGrep({ pattern: "--pre=evil", path: "-x", glob: "*.ts", ignoreCase: true, maxMatches: 5 })).toEqual([
      "/opt/portal/fsops", "grep", "--max-matches", "5", "--ignore-case", "--glob", "*.ts", "--", "--pre=evil", "-x",
    ]);
    expect(fsRead({ path: "-rf", maxBytes: 5, startLine: 2, endLine: 9 })).toEqual(["/opt/portal/fsops", "read", "--max-bytes", "5", "--start-line", "2", "--end-line", "9", "--", "-rf"]);
  });

  it("validates everything", () => {
    const bad: (() => unknown)[] = [
      () => workspaceExec({ execId: "BAD", command: "ls", timeoutSec: 10 }),
      () => workspaceExec({ execId: "a".repeat(16), command: "", timeoutSec: 10 }),
      () => workspaceExec({ execId: "a".repeat(16), command: "x".repeat(16_385), timeoutSec: 10 }),
      () => workspaceExec({ execId: "a".repeat(16), command: "ls\0", timeoutSec: 10 }),
      () => workspaceExec({ execId: "a".repeat(16), command: "ls", timeoutSec: 0 }),
      () => fsRead({ path: "a\0b", maxBytes: 1 }),
      () => fsList({ depth: 4, maxEntries: 10 }),
      () => fsGrep({ pattern: "x", maxMatches: 201 }),
      () => killRun("../../etc"),
    ];
    for (const f of bad) expect(f).toThrow(TemplateError);
  });

  it("allows only harmless environment variables", () => {
    expect(validateEnv({ NODE_ENV: "test", DEBUG: "1" })).toEqual(["NODE_ENV=test", "DEBUG=1"]);
    for (const k of ["LD_PRELOAD", "BASH_ENV", "ENV", "PATH", "HOME", "SHELLOPTS", "BASH_FUNC_x%%", "PORTAL_X", "lower", "IFS", "PROMPT_COMMAND"])
      expect(() => validateEnv({ [k]: "x" }), k).toThrow(TemplateError);
    expect(() => validateEnv(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "v"])))).toThrow(/At most/);
    expect(() => validateEnv({ K: "x".repeat(4097) })).toThrow(TemplateError);
  });
});
