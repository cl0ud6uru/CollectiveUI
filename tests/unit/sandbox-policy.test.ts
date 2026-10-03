import { describe, expect, it } from "vitest";
import { resolveApproval } from "@/lib/agent/approvals";
import { isGrantable, NON_GRANTABLE_TOOLS } from "@/lib/agent/tool-names";
import { capHeadTail, cleanText, isHardDenied, looksBinary, requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import type { SandboxSettings } from "@/lib/settings";

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({
  enabled: true,
  access: "selected",
  allowedGroupIds: [],
  allowedUpns: [],
  allowRunc: false,
  commandTimeoutSec: 120,
  outputKb: 32,
  deleteAfterDays: 30,
  ...over,
});
const person = (over: { upn?: string; groupIds?: string[]; isAdmin?: boolean } = {}) => ({
  user: { upn: over.upn ?? "jane@corp.local" },
  groupIds: over.groupIds ?? [],
  isAdmin: over.isAdmin ?? false,
});

describe("who gets a workspace", () => {
  it("follows the admin settings", () => {
    expect(userMayUseWorkspace(person({ isAdmin: true }), settings({ enabled: false }))).toBe(false);
    expect(userMayUseWorkspace(person(), settings())).toBe(false);
    expect(userMayUseWorkspace(person({ isAdmin: true }), settings())).toBe(true);
    expect(userMayUseWorkspace(person(), settings({ access: "everyone" }))).toBe(true);
    expect(userMayUseWorkspace(person({ groupIds: ["g1"] }), settings({ allowedGroupIds: ["g1"] }))).toBe(true);
    expect(userMayUseWorkspace(person({ upn: "Jane@Corp.Local" }), settings({ allowedUpns: ["jane@corp.local"] }))).toBe(true);
  });

  it("asks for gVisor unless runc was acknowledged", () => {
    expect(requiredIsolation(settings())).toBe("gvisor");
    expect(requiredIsolation(settings({ allowRunc: true }))).toBe("any");
  });
});

describe("workspace approvals", () => {
  const base = { toolKey: "workspace", mode: "auto" as const, enforced: [], grants: new Set<string>() };
  it("commands always ask, even with an 'always allow' grant", () => {
    expect(NON_GRANTABLE_TOOLS.has("workspace_bash")).toBe(true);
    expect(isGrantable("workspace_bash")).toBe(false);
    const i = { ...base, toolName: "workspace_bash", sensitive: true, grantable: false, grants: new Set(["workspace_bash"]) };
    expect(resolveApproval(i)).toBe("user-approval");
  });
  it("writes ask unless the person always-allowed them for this bot; reads don't ask", () => {
    expect(resolveApproval({ ...base, toolName: "workspace_write", sensitive: true })).toBe("user-approval");
    expect(resolveApproval({ ...base, toolName: "workspace_write", sensitive: true, grants: new Set(["workspace_write"]) })).toBeUndefined();
    expect(resolveApproval({ ...base, toolName: "workspace_read", sensitive: false })).toBeUndefined();
  });
});

describe("workspace output", () => {
  it("strips hidden characters, masks secrets and decodes invalid UTF-8", () => {
    expect(cleanText("ok\u{E0041} token sk-proj-abcdefghijklmnopqrstuvwxyz")).toBe("ok token [redacted]");
    expect(cleanText(new Uint8Array([0x68, 0x69, 0xff]))).toBe("hi�");
  });
  it("keeps the head and the tail", () => {
    const r = capHeadTail("a".repeat(10) + "b".repeat(100) + "c".repeat(10), 10, 10);
    expect(r.omitted).toBe(100);
    expect(r.text).toBe(`${"a".repeat(10)}\n… [100 characters omitted] …\n${"c".repeat(10)}`);
    expect(capHeadTail("short", 10, 10)).toEqual({ text: "short", omitted: 0 });
  });
  it("detects binary content", () => {
    expect(looksBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false);
  });
});

describe("hard-denied commands (a foot-gun guard, not a security control)", () => {
  it("catches the obvious ones", () => {
    for (const c of [":(){ :|:& };:", "rm -rf /", "rm -rf ~", "rm -fr /home/agent/*", "rm -rf $HOME", "sudo rm -rf --no-preserve-root /", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda"])
      expect(isHardDenied(c), c).toMatch(/isn't run/);
  });
  it("leaves normal commands alone", () => {
    for (const c of ["rm -rf build/", "rm -rf ./node_modules", "ls -la /", "dd if=a of=b", "echo 'rm -rf' > notes.txt"]) expect(isHardDenied(c), c).toBeNull();
  });
});
