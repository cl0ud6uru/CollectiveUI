import { beforeEach, describe, expect, it, vi } from "vitest";
import { botDelegates, botTools, toolGrants, type AiApp, type Bot, type McpServer } from "@/db/schema";

// A tiny stand-in for drizzle's query builder: select().from(table)[.innerJoin()].where() resolves to rows per table.
const rows = new Map<unknown, unknown[]>();
vi.mock("@/db", () => {
  const chain = (table: unknown) => {
    const q = { innerJoin: () => q, where: async () => rows.get(table) ?? [], then: undefined as never };
    return q;
  };
  return { db: { select: () => ({ from: chain }) } };
});

const listAccessibleMcpServers = vi.fn();
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  listAccessibleMcpServers: (...a: unknown[]) => listAccessibleMcpServers(...a),
}));

const mcpTools = vi.fn();
const connectedMcpTools = vi.fn();
vi.mock("@/lib/agent/tools/mcp", async (original) => ({
  ...(await original<typeof import("@/lib/agent/tools/mcp")>()),
  mcpTools: (...a: unknown[]) => mcpTools(...a),
  connectedMcpTools: (...a: unknown[]) => connectedMcpTools(...a),
}));

const connectMcp = vi.fn();
vi.mock("@/lib/mcp/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/client")>()),
  connectMcp: (...a: unknown[]) => connectMcp(...a),
}));

import { buildToolset } from "@/lib/agent/toolset";
import { PortalWorkspace, WorkspaceClosedError } from "@/lib/sandbox/session";

const server = (id: string, name: string, over: Partial<McpServer> = {}) => ({ id, name, toolsSnapshot: null, identityHeader: null, ...over }) as McpServer;
const ctx = {
  principal: { user: { id: "u1", name: "Alice", upn: "alice@corp.local", email: null }, groupIds: [] } as never,
  conversationId: "c1",
  bot: { id: "b1", name: "Bot", ownerId: "u1" } as Bot,
  app: { supportsTools: true } as AiApp,
  depth: 0,
  background: false,
  toolSettings: { disabledTools: [], enforcedApproval: [], maxStepsCap: 10 } as never,
};

describe("buildToolset MCP loading", () => {
  beforeEach(() => {
    rows.clear();
    rows.set(botDelegates, []);
    rows.set(toolGrants, []);
    listAccessibleMcpServers.mockReset();
    mcpTools.mockReset();
    connectedMcpTools.mockReset();
  });

  it("checks access once, connects in parallel, and keeps working when one server fails or is not accessible", async () => {
    rows.set(botTools, [
      { toolKey: "mcp:a", approval: "auto" },
      { toolKey: "mcp:b", approval: "auto" },
      { toolKey: "mcp:hidden", approval: "auto" },
    ]);
    listAccessibleMcpServers.mockResolvedValue([server("a", "Alpha"), server("b", "Beta")]);
    const close = vi.fn(async () => {});
    connectedMcpTools.mockImplementation(async (s: McpServer) => {
      if (s.id === "b") throw new Error("connection refused");
      return { entries: [{ name: "alpha__echo", key: "mcp:a", tool: {} }], close };
    });

    const ts = await buildToolset(ctx);

    expect(listAccessibleMcpServers).toHaveBeenCalledTimes(1);
    expect(connectedMcpTools).toHaveBeenCalledTimes(2);
    expect(mcpTools).not.toHaveBeenCalled();
    expect(Object.keys(ts.tools)).toEqual(["alpha__echo"]);
    expect(ts.warnings).toEqual([
      "One of this bot's MCP servers isn't available to you, so its tools are missing.",
      '"Beta" is unavailable right now.',
    ]);
    await ts.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("servers with a tool snapshot load lazily, with the bot's per-tool choices, and share one name space", async () => {
    rows.set(botTools, [
      { toolKey: "mcp:a", approval: "smart", config: { tools: ["echo"] } },
      { toolKey: "mcp:b", approval: "auto", config: null },
    ]);
    listAccessibleMcpServers.mockResolvedValue([server("a", "a", { toolsSnapshot: [] }), server("b", "b", { toolsSnapshot: [] })]);
    mcpTools.mockImplementation((s: McpServer, opts: { config: unknown; taken: Set<string>; caller: { subject: { kind: string; upn?: string }; botId: string } }) => {
      expect(opts.caller).toMatchObject({ subject: { kind: "user", upn: "alice@corp.local" }, botId: "b1", conversationId: "c1" });
      return { entries: [{ name: `${s.id}__echo`, key: `mcp:${s.id}`, tool: {}, mcp: { tool: "echo", readOnly: true, destructive: false, trusted: s.id === "a", requireApproval: false } }], close: async () => {} };
    });

    const ts = await buildToolset(ctx);

    expect(connectedMcpTools).not.toHaveBeenCalled();
    expect(mcpTools.mock.calls.map((c) => c[1].config)).toEqual([{ tools: ["echo"] }, null]);
    expect(mcpTools.mock.calls[0][1].taken).not.toBe(mcpTools.mock.calls[1][1].taken);
    // Smart + trusted + read-only runs; the untrusted server's tool under "auto" also runs.
    expect(ts.approval({ toolCall: { toolName: "a__echo" } })).toBeUndefined();
    expect(ts.approval({ toolCall: { toolName: "b__echo" } })).toBeUndefined();
  });

  it("assigns colliding tool names in server order despite reversed discovery completion", async () => {
    rows.set(botTools, [{ toolKey: "mcp:a", approval: "auto" }, { toolKey: "mcp:b", approval: "auto" }]);
    listAccessibleMcpServers.mockResolvedValue([server("b", "Tickets"), server("a", "Tickets")]);
    let reverse = false;
    connectedMcpTools.mockImplementation(async (s: McpServer) => {
      await new Promise(resolve => setTimeout(resolve, (s.id === "a") === reverse ? 0 : 15));
      return { entries: [{ name: "temporary", key: `mcp:${s.id}`, tool: {}, mcp: { tool: "create", definitionHash: s.id } }], close: async () => {} };
    });
    const first = await buildToolset(ctx); reverse = true;
    const second = await buildToolset(ctx);
    expect(first.entries.map(e => [e.name, e.key])).toEqual([["tickets__create", "mcp:a"], ["tickets__create_2", "mcp:b"]]);
    expect(second.entries.map(e => [e.name, e.key])).toEqual(first.entries.map(e => [e.name, e.key]));
    expect(second.approvalBinding).toBe(first.approvalBinding);
  });

  it("a Hermes bot gets no portal tools: Hermes brings its own", async () => {
    rows.set(botTools, [
      { toolKey: "web_search", approval: "auto" },
      { toolKey: "mcp:a", approval: "auto" },
    ]);
    const ts = await buildToolset({ ...ctx, app: { supportsTools: true, provider: "hermes" } as AiApp });
    expect(ts.tools).toEqual({});
    expect(ts.warnings).toEqual([]);
    expect(listAccessibleMcpServers).not.toHaveBeenCalled();
  });
});

describe("closed handles don't come back to life (a stream still running after its turn ended)", () => {
  // The real MCP toolsets (the module is mocked above for buildToolset).
  const real = () => vi.importActual<typeof import("@/lib/agent/tools/mcp")>("@/lib/agent/tools/mcp");
  const mcpServer = server("a", "Alpha", {
    toolsSnapshot: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] as never,
    toolsDrift: null,
    toolPolicy: {},
    resultBudgetKb: 64,
    timeoutMs: 5_000,
    trust: "trusted",
  });
  const opts = () => ({ caller: { subject: { kind: "user" as const, upn: "alice@corp.local" } } as never, config: null, taken: new Set<string>() });
  const fakeClient = () => ({
    toolsFromDefinitions: vi.fn(),
    listTools: vi.fn(async () => ({ tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "hi" }] })),
    close: vi.fn(async () => {}),
  });
  const call = (entry: { tool: unknown }) =>
    (entry.tool as { execute: (input: unknown, o: unknown) => Promise<unknown> }).execute({}, { toolCallId: "t1", messages: [], abortSignal: undefined });

  beforeEach(() => connectMcp.mockReset());

  it("a lazy MCP toolset doesn't reconnect after close()", async () => {
    const { mcpTools, McpToolsetClosedError } = await real();
    const client = fakeClient();
    connectMcp.mockResolvedValue(client);
    const ts = mcpTools(mcpServer, opts());
    await call(ts.entries[0]);
    expect(connectMcp).toHaveBeenCalledTimes(1);
    await ts.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    await expect(call(ts.entries[0])).rejects.toBeInstanceOf(McpToolsetClosedError);
    await expect(call(ts.entries[0])).rejects.toThrow(/this reply has already ended/);
    expect(connectMcp).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("a connection that finishes opening after close() is closed, and its call fails", async () => {
    const { mcpTools, McpToolsetClosedError } = await real();
    const client = fakeClient();
    let connected!: (c: unknown) => void;
    connectMcp.mockReturnValue(new Promise((r) => (connected = r)));
    const ts = mcpTools(mcpServer, opts());
    const pending = call(ts.entries[0]);
    const closing = ts.close();
    connected(client);
    await closing;
    await expect(pending).rejects.toBeInstanceOf(McpToolsetClosedError);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.callTool).not.toHaveBeenCalled();
    await expect(call(ts.entries[0])).rejects.toBeInstanceOf(McpToolsetClosedError);
    expect(connectMcp).toHaveBeenCalledTimes(1);
  });

  it("an eagerly connected MCP toolset refuses calls after close()", async () => {
    const { connectedMcpTools, McpToolsetClosedError } = await real();
    const client = fakeClient();
    connectMcp.mockResolvedValue(client);
    const ts = await connectedMcpTools({ ...mcpServer, toolsSnapshot: null }, opts());
    await ts.close();
    await expect(call(ts.entries[0])).rejects.toBeInstanceOf(McpToolsetClosedError);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  const workspace = () => {
    const client = {
      exec: vi.fn(async () => ({ t: "exit", code: 0 })),
      kill: vi.fn(async () => ({ killed: true })),
      writeFile: vi.fn(async () => ({ created: true })),
    };
    const ws = new PortalWorkspace({ client: client as never, ref: async () => "abcdefghij0123456789", isolation: "gvisor" });
    return { ws, client };
  };

  it("a workspace handle runs no commands after close()", async () => {
    const { ws, client } = workspace();
    await ws.exec({ command: "true", timeoutMs: 1000 });
    expect(client.exec).toHaveBeenCalledTimes(1);
    await ws.close();
    await expect(ws.exec({ command: "rm -rf build", timeoutMs: 1000 })).rejects.toBeInstanceOf(WorkspaceClosedError);
    await expect(ws.run({ command: "ls" } as never)).rejects.toBeInstanceOf(WorkspaceClosedError);
    await expect(ws.spawn({ command: "ls" } as never)).rejects.toBeInstanceOf(WorkspaceClosedError);
    expect(client.exec).toHaveBeenCalledTimes(1);
  });

  it("a command queued behind another change when the turn ends never starts; running ones are killed", async () => {
    const { ws, client } = workspace();
    let finishWrite!: () => void;
    client.writeFile.mockReturnValueOnce(new Promise((r) => (finishWrite = () => r({ created: true }))) as never);
    let finishExec!: () => void;
    const write = ws.writeRaw("a.txt", new Uint8Array([1]));
    const queued = ws.exec({ command: "make", timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 0));
    await ws.close();
    finishWrite();
    await write;
    await expect(queued).rejects.toBeInstanceOf(WorkspaceClosedError);
    expect(client.exec).not.toHaveBeenCalled();

    // A command already running when the handle closes is killed.
    const other = workspace();
    other.client.exec.mockReturnValueOnce(new Promise((r) => (finishExec = () => r({ t: "exit", code: 137 }))) as never);
    const running = other.ws.exec({ command: "sleep 100", timeoutMs: 1000, execId: "e1" });
    await vi.waitFor(() => expect(other.client.exec).toHaveBeenCalledTimes(1));
    await other.ws.close();
    expect(other.client.kill).toHaveBeenCalledWith("abcdefghij0123456789", "e1");
    finishExec();
    await running;
  });
});
