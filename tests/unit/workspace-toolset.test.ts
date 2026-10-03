import { beforeEach, describe, expect, it, vi } from "vitest";
import { botDelegates, botTools, toolGrants, type AiApp, type Bot } from "@/db/schema";
import type { SandboxSettings } from "@/lib/settings";

// A tiny stand-in for drizzle's query builder: select().from(table)[.innerJoin()].where() resolves to rows per table.
const rows = new Map<unknown, unknown[]>();
vi.mock("@/db", () => {
  const chain = (table: unknown) => {
    const q = { innerJoin: () => q, where: async () => rows.get(table) ?? [], then: undefined as never };
    return q;
  };
  return { db: { select: () => ({ from: chain }) } };
});

let sandbox: SandboxSettings;
vi.mock("@/lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings")>()),
  getSetting: async (key: string) => (key === "sandbox" ? sandbox : {}),
}));

let client: object | null = {};
vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  sandboxd: () => client,
}));

const getOrCreateRef = vi.fn(async () => "abcdefghij0123456789");
vi.mock("@/lib/sandbox/store", () => ({ getOrCreateRef: () => getOrCreateRef(), touchSandbox: async () => {} }));

import { buildToolset } from "@/lib/agent/toolset";
import { PortalWorkspace } from "@/lib/sandbox/session";
import type { AgentCtx } from "@/lib/agent/types";

const ENABLED: SandboxSettings = {
  enabled: true,
  access: "everyone",
  allowedGroupIds: [],
  allowedUpns: [],
  allowRunc: false,
  commandTimeoutSec: 90,
  outputKb: 32,
  deleteAfterDays: 30,
};

const newCtx = (over: Partial<AgentCtx> = {}): AgentCtx =>
  ({
    principal: { user: { id: "u1", name: "Alice", upn: "alice@corp.local", email: null }, groupIds: [], isAdmin: false } as never,
    conversationId: "c1",
    bot: { id: "b1", name: "Bot", ownerId: "u1" } as Bot,
    app: { supportsTools: true } as AiApp,
    depth: 0,
    background: false,
    toolSettings: { disabledTools: [], enforcedApproval: [], maxStepsCap: 10 } as never,
    ...over,
  }) as AgentCtx;

const call = (toolName: string, input: unknown = {}) => ({ toolCall: { toolName, input, toolCallId: "t1" } }) as never;

describe("buildToolset workspace wiring", () => {
  beforeEach(() => {
    rows.clear();
    rows.set(botTools, [{ toolKey: "workspace", approval: "auto" }]);
    rows.set(botDelegates, []);
    rows.set(toolGrants, []);
    sandbox = { ...ENABLED };
    client = {};
    getOrCreateRef.mockClear();
  });

  it("adds the six tools, a per-tool timeout, and a lazily resolved workspace", async () => {
    const ctx = newCtx();
    const ts = await buildToolset(ctx);
    expect(Object.keys(ts.tools)).toEqual(["workspace_bash", "workspace_write", "workspace_edit", "workspace_read", "workspace_list", "workspace_grep"]);
    expect(ts.timeout).toEqual({ tools: { workspace_bashMs: 120_000 } });
    expect(ts.workspace).toBeInstanceOf(PortalWorkspace);
    expect(ctx.workspace).toBe(ts.workspace);
    // No sandbox is created just because a bot has the tools.
    expect(getOrCreateRef).not.toHaveBeenCalled();
    expect(ts.warnings).toEqual([]);
  });

  it("warns and leaves the tools out when workspaces are off, not allowed or not set up", async () => {
    sandbox = { ...ENABLED, enabled: false };
    let ts = await buildToolset(newCtx());
    expect(ts.tools).toEqual({});
    expect(ts.workspace).toBeNull();
    expect(ts.warnings[0]).toMatch(/aren't enabled for you/);

    sandbox = { ...ENABLED, access: "selected" };
    ts = await buildToolset(newCtx());
    expect(ts.tools).toEqual({});

    sandbox = { ...ENABLED, access: "selected", allowedUpns: ["ALICE@corp.local"] };
    ts = await buildToolset(newCtx());
    expect(Object.keys(ts.tools)).toHaveLength(6);

    sandbox = { ...ENABLED };
    client = null;
    ts = await buildToolset(newCtx());
    expect(ts.tools).toEqual({});
    expect(ts.warnings).toEqual(["Workspaces aren't set up on this server."]);
  });

  it("an admin-disabled workspace tool group is removed", async () => {
    const ts = await buildToolset(newCtx({ toolSettings: { disabledTools: ["workspace"], enforcedApproval: [], maxStepsCap: 10 } as never }));
    expect(ts.tools).toEqual({});
  });

  it("delegates share the caller's handle, and only the creator closes it", async () => {
    const close = vi.spyOn(PortalWorkspace.prototype, "close").mockResolvedValue();
    const ctx = newCtx();
    const parent = await buildToolset(ctx);
    const child = await buildToolset({ ...ctx, bot: { id: "b2", name: "Helper", ownerId: "u1" } as Bot, depth: 1 });
    expect(child.workspace).toBe(parent.workspace);
    await child.close();
    expect(close).not.toHaveBeenCalled();
    await parent.close();
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it("a delegate-only workspace belongs to (and is closed by) the delegate's toolset", async () => {
    const close = vi.spyOn(PortalWorkspace.prototype, "close").mockResolvedValue();
    const ctx = newCtx();
    const child = await buildToolset({ ...ctx, depth: 1 });
    expect(child.workspace).toBeInstanceOf(PortalWorkspace);
    await child.close();
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it("commands always ask, even with an 'always allow' grant; writes honour grants; reads never ask", async () => {
    rows.set(toolGrants, [{ toolName: "workspace_bash" }, { toolName: "workspace_write" }]);
    const ts = await buildToolset(newCtx());
    expect(ts.approval(call("workspace_bash", { command: "ls" }))).toBe("user-approval");
    expect(ts.approval(call("workspace_write", { path: "a", content: "" }))).toBeUndefined();
    expect(ts.approval(call("workspace_edit", { path: "a", old_string: "x", new_string: "y" }))).toBe("user-approval");
    expect(ts.approval(call("workspace_read", { path: "a" }))).toBeUndefined();
    expect(ts.approval(call("workspace_list"))).toBeUndefined();
    expect(ts.approval(call("workspace_grep", { pattern: "x" }))).toBeUndefined();
  });

  it("an admin can force approval for the read tools too", async () => {
    const ts = await buildToolset(newCtx({ toolSettings: { disabledTools: [], enforcedApproval: ["workspace_read"], maxStepsCap: 10 } as never }));
    expect(ts.approval(call("workspace_read", { path: "a" }))).toEqual({ type: "user-approval", reason: "Organization policy requires approval for every call." });
  });

  it("obvious foot-guns are refused outright, with a reason and no Run card", async () => {
    const ts = await buildToolset(newCtx());
    expect(ts.approval(call("workspace_bash", { command: "rm -rf ~" }))).toEqual({ type: "denied", reason: expect.stringContaining("isn't run") });
    expect(ts.approval(call("workspace_bash", { command: "rm -rf build" }))).toBe("user-approval");
  });

  it("delegates and group chats can't ask, so commands are denied there; granted writes still run", async () => {
    rows.set(toolGrants, [{ toolName: "workspace_write" }]);
    for (const over of [{ depth: 1 }, { inGroup: true }] as Partial<AgentCtx>[]) {
      const ts = await buildToolset(newCtx(over));
      expect(ts.approval(call("workspace_bash", { command: "ls" }))).toMatchObject({ type: "denied", reason: expect.stringContaining("needs the user's approval") });
      expect(ts.approval(call("workspace_edit", { path: "a", old_string: "x", new_string: "y" }))).toMatchObject({ type: "denied" });
      expect(ts.approval(call("workspace_write", { path: "a", content: "" }))).toBeUndefined();
      expect(ts.approval(call("workspace_read", { path: "a" }))).toBeUndefined();
    }
  });
});
