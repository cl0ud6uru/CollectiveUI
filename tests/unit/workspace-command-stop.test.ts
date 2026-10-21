import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ principal: vi.fn(), refs: vi.fn(), kill: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({ db: {}, schema: {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/sandbox/view", () => ({ workspaceView: vi.fn() }));
vi.mock("@/lib/authz", () => ({ HttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } } }));
vi.mock("@/lib/sandbox/store", () => ({ ownWorkspaceRefs: f.refs, findSandbox: vi.fn(), findWorkspaceInstance: vi.fn() }));
vi.mock("@/lib/sandbox/client", async original => ({ ...(await original<typeof import("@/lib/sandbox/client")>()), sandboxd: () => ({ kill: f.kill }) }));

import { stopWorkspaceCommand } from "@/app/(chat)/settings/workspace-actions";
import { execIdForToolCall } from "@/lib/agent/tools/workspace";
import { HttpError } from "@/lib/authz";
import { SandboxError } from "@/lib/sandbox/client";

beforeEach(() => {
  vi.resetAllMocks();
  f.principal.mockResolvedValue({ user: { id: "alice" } });
  f.refs.mockResolvedValue(["legacy-owned-ref", "template-owned-ref"]);
  f.kill.mockImplementation(async ref => ({ killed: ref === "template-owned-ref" }));
});

describe("workspace command Stop action", () => {
  it("finds a command in an owned template and uses the same visible group ID as execution", async () => {
    const id = "speaker-invocation:provider-call";
    expect(await stopWorkspaceCommand(id)).toEqual({ ok: true, value: true });
    expect(f.refs).toHaveBeenCalledExactlyOnceWith("alice");
    expect(f.kill.mock.calls).toEqual([
      ["legacy-owned-ref", execIdForToolCall(id)], ["template-owned-ref", execIdForToolCall(id)],
    ]);
  });

  it("still stops an owned command when another retained ref is unavailable", async () => {
    f.kill.mockRejectedValueOnce(new SandboxError("not_found", "Old workspace unavailable"));
    expect(await stopWorkspaceCommand("speaker:call")).toEqual({ ok: true, value: true });
  });

  it("reports a miss through the existing UI error result instead of silently returning false", async () => {
    f.kill.mockResolvedValue({ killed: false });
    expect(await stopWorkspaceCommand("call")).toEqual({ ok: false, error: "This command has already ended or could not be found in your workspaces." });
  });

  it("rejects expired principals and malformed IDs before looking up or killing a workspace", async () => {
    await expect(stopWorkspaceCommand("")).resolves.toMatchObject({ ok: false });
    await expect(stopWorkspaceCommand("x".repeat(513))).resolves.toMatchObject({ ok: false });
    expect(f.principal).not.toHaveBeenCalled();
    f.principal.mockRejectedValue(new HttpError(401, "expired"));
    expect(await stopWorkspaceCommand("call")).toEqual({ ok: false, error: "Your portal session has expired. Sign in again." });
    expect(f.refs).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
  });
});
