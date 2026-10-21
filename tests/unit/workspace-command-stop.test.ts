import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ principal: vi.fn(), instance: vi.fn(), legacy: vi.fn(), kill: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({ db: {}, schema: {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/sandbox/view", () => ({ workspaceView: vi.fn() }));
vi.mock("@/lib/authz", () => ({ HttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } } }));
vi.mock("@/lib/sandbox/store", () => ({ findSandbox: f.legacy, findWorkspaceInstance: f.instance }));
vi.mock("@/lib/sandbox/client", async original => ({ ...(await original<typeof import("@/lib/sandbox/client")>()), sandboxd: () => ({ kill: f.kill }) }));

import { stopWorkspaceCommand } from "@/app/(chat)/settings/workspace-actions";
import { execIdForToolCall } from "@/lib/agent/tools/workspace";
import { HttpError } from "@/lib/authz";

beforeEach(() => {
  vi.resetAllMocks();
  f.principal.mockResolvedValue({ user: { id: "alice" } });
  f.instance.mockImplementation(async (owner, id) => owner === "alice" && ["instance-a", "instance-b"].includes(id) ? { sandboxRef: `ref-${id}` } : null);
  f.legacy.mockResolvedValue({ ref: "legacy-owned-ref" });
  f.kill.mockResolvedValue({ killed: true });
});

describe("workspace command Stop action", () => {
  it("targets only the selected owned instance when two direct chats reuse a provider ID", async () => {
    const execution = "b".repeat(16);
    expect(await stopWorkspaceCommand("same-provider-id", "instance-b", execution)).toEqual({ ok: true, value: true });
    expect(f.instance).toHaveBeenCalledExactlyOnceWith("alice", "instance-b");
    expect(f.kill.mock.calls).toEqual([["ref-instance-b", execution]]);
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("does not stop a newer execution when an older Stop arrives with the same provider ID", async () => {
    const oldExecution = "a".repeat(16), newExecution = "b".repeat(16);
    f.kill.mockImplementation(async (_ref, id) => ({ killed: id === newExecution }));
    expect(await stopWorkspaceCommand("same-provider-id", "instance-b", oldExecution)).toMatchObject({ ok: false });
    expect(f.kill.mock.calls).toEqual([["ref-instance-b", oldExecution]]);
    expect(await stopWorkspaceCommand("speaker-prefix:same-provider-id", "instance-b", newExecution)).toEqual({ ok: true, value: true });
  });

  it("rejects a foreign or missing instance without falling back to the legacy workspace", async () => {
    expect(await stopWorkspaceCommand("call", "foreign-instance", "b".repeat(16))).toEqual({ ok: false, error: "Workspace not found" });
    expect(f.kill).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
  });

  it("keeps legacy compatibility scoped only to the caller's legacy ref", async () => {
    expect(await stopWorkspaceCommand("legacy-call")).toEqual({ ok: true, value: true });
    expect(f.legacy).toHaveBeenCalledExactlyOnceWith("alice");
    expect(f.kill).toHaveBeenCalledExactlyOnceWith("legacy-owned-ref", execIdForToolCall("legacy-call"));
    expect(f.instance).not.toHaveBeenCalled();
  });

  it("reports a miss through the existing UI error result instead of silently returning false", async () => {
    f.kill.mockResolvedValue({ killed: false });
    expect(await stopWorkspaceCommand("call")).toEqual({ ok: false, error: "This command has already ended or could not be found in your workspaces." });
  });

  it("rejects expired principals and malformed IDs before looking up or killing a workspace", async () => {
    await expect(stopWorkspaceCommand("")).resolves.toMatchObject({ ok: false });
    await expect(stopWorkspaceCommand("x".repeat(513))).resolves.toMatchObject({ ok: false });
    await expect(stopWorkspaceCommand("call", "", "b".repeat(16))).resolves.toMatchObject({ ok: false });
    await expect(stopWorkspaceCommand("call", "instance-b", "invalid-execution")).resolves.toMatchObject({ ok: false });
    expect(f.principal).not.toHaveBeenCalled();
    f.principal.mockRejectedValue(new HttpError(401, "expired"));
    expect(await stopWorkspaceCommand("call")).toEqual({ ok: false, error: "Your portal session has expired. Sign in again." });
    expect(f.instance).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
  });
});
