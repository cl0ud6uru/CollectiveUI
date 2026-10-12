import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
import type { BrowserScope } from "@/lib/agent-browser/provider-contract";
import { assertBrowserAdmission } from "@/lib/agent-browser/admission";
import { agentBrowserTools } from "@/lib/agent/tools/agent-browser";
import type { AgentBrowserProvider } from "@/lib/agent-browser/provider-contract";

const mock = vi.hoisted(() => ({ rows: [] as unknown[][], loadPrincipal: vi.fn(), getSetting: vi.fn(), getUsableBot: vi.fn(), getOwnedConversation: vi.fn() }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: async () => mock.rows.shift() ?? [] }) }) } }));
vi.mock("@/db/schema", () => ({ agentRuns: {}, botTools: {} }));
vi.mock("drizzle-orm", () => ({ and: () => null, eq: () => null }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: mock.loadPrincipal }));
vi.mock("@/lib/settings", () => ({ getSetting: mock.getSetting }));
vi.mock("@/lib/authz", async () => ({ getUsableBot: mock.getUsableBot, getOwnedConversation: mock.getOwnedConversation,
  HttpError: (await import("@/lib/http-error")).HttpError }));

const scope: BrowserScope = { ownerUserId: "owner", botId: "bot", runId: "run", conversationId: "conv", workspaceInstanceId: null };
const principal = { user: { id: "owner", sessionVersion: 1, upn: "owner@example.com" }, groupIds: [], isAdmin: false };
const ctx = { principal, bot: { id: "bot", executionMode: "caller" }, depth: 0, app: { provider: "openai", supportsTools: true, providerConfig: {} },
  usage: { runId: "run" }, conversationId: "conv", execution: { holder: "worker" } } as unknown as AgentCtx;
const run = { botId: "bot", conversationId: "conv", status: "running", holder: "worker", cancelRequestedAt: null };
beforeEach(() => {
  vi.clearAllMocks();
  mock.loadPrincipal.mockResolvedValue(principal);
  mock.getSetting.mockImplementation(async name => name === "sandbox" ? { enabled: true, access: "everyone" } : { disabledTools: [] });
  mock.getUsableBot.mockResolvedValue({ executionMode: "caller" }); mock.getOwnedConversation.mockResolvedValue({ botId: "bot" });
  mock.rows = [[run], [{ toolKey: "agent_browser" }]];
});
describe("native browser current admission", () => {
  it("admits only the current authenticated direct caller's owned run", async () => { await expect(assertBrowserAdmission(ctx, scope)).resolves.toBeUndefined(); });
  it.each(["ownerUserId", "botId", "runId", "conversationId"])("rejects spoofed %s", async field => {
    await expect(assertBrowserAdmission(ctx, { ...scope, [field]: "spoof" })).rejects.toThrow();
    expect(mock.loadPrincipal).not.toHaveBeenCalled();
  });
  it("rejects disabled/expired/revoked principals and refreshed workspace audience", async () => {
    mock.loadPrincipal.mockResolvedValue(null); await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
    mock.loadPrincipal.mockResolvedValue({ ...principal, user: { ...principal.user, sessionVersion: 2 } }); await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
    mock.loadPrincipal.mockResolvedValue(principal); mock.getSetting.mockResolvedValue({ enabled: false });
    await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
  });
  it("rejects tool removal, global tool revocation and bot/conversation access revocation", async () => {
    mock.rows = [[run], []]; await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
    mock.getSetting.mockImplementation(async name => name === "sandbox" ? { enabled: true, access: "everyone" } : { disabledTools: ["agent_browser"] });
    await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
    mock.getSetting.mockImplementation(async name => name === "sandbox" ? { enabled: true, access: "everyone" } : { disabledTools: [] });
    mock.getUsableBot.mockRejectedValue(new Error("revoked bot")); await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
    mock.getUsableBot.mockResolvedValue({ executionMode: "caller" }); mock.getOwnedConversation.mockResolvedValue({ botId: "other-bot" });
    await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
  });
  it.each([{ status: "succeeded" }, { cancelRequestedAt: new Date() }, { holder: "other-worker" }, { conversationId: "other-conv" }, { botId: "other-bot" }])("rejects stale/cancelled/completed/wrong-holder run %j", async changed => {
    mock.rows = [[{ ...run, ...changed }], [{ toolKey: "agent_browser" }]];
    await expect(assertBrowserAdmission(ctx, scope)).rejects.toThrow();
  });
  it("rejects delegates, groups, service bots, external Hermes and Codex harness", async () => {
    for (const changed of [{ depth: 1 }, { inGroup: true }, { bot: { ...ctx.bot, executionMode: "service" } },
      { app: { ...ctx.app, provider: "hermes" } }, { app: { ...ctx.app, providerConfig: { codexHarness: true } } }])
      await expect(assertBrowserAdmission({ ...ctx, ...changed } as AgentCtx, scope)).rejects.toThrow();
  });
  it("requires current same-owner workspace revalidation before any browser allocation", async () => {
    const provider = { open: vi.fn() } as unknown as AgentBrowserProvider;
    await expect(agentBrowserTools(ctx, { provider, workspace: { ownerUserId: "other", instanceId: "instance" } })).rejects.toThrow();
    mock.rows = [[run], [{ toolKey: "agent_browser" }]];
    await expect(agentBrowserTools(ctx, { provider, workspace: { ownerUserId: "owner", instanceId: "instance" }, assertWorkspace: async () => { throw new Error("binding revoked"); } })).rejects.toThrow();
    expect(provider.open).not.toHaveBeenCalled();
  });
  it("closes created browser after a failed source registration and despite unregister errors", async () => {
    const provider = { open: vi.fn(async () => ({ sessionId: "a".repeat(32) })), close: vi.fn(async () => {}), navigate: vi.fn(async () => ({ title: "page" })) } as unknown as AgentBrowserProvider;
    const tools = await agentBrowserTools(ctx, { provider, workspace: null, registerSource: async () => { throw new Error("source registry down"); } });
    mock.rows = [[run], [{ toolKey: "agent_browser" }]];
    const execute = tools.entries[0].tool.execute as (v: unknown, o: object) => Promise<unknown>;
    await expect(execute({ url: "https://example.com" }, {})).rejects.toThrow(); expect(provider.close).toHaveBeenCalledTimes(1);
    mock.rows = [[run], [{ toolKey: "agent_browser" }]];
    const second = await agentBrowserTools(ctx, { provider, workspace: null, unregisterSource: async () => { throw new Error("registry down"); } });
    mock.rows = [[run], [{ toolKey: "agent_browser" }]];
    await (second.entries[0].tool.execute as typeof execute)({ url: "https://example.com" }, {});
    await expect(second.close()).rejects.toThrow(); expect(provider.close).toHaveBeenCalledTimes(2);
  });
  it("propagates native cancellation and never opens for an already cancelled tool", async () => {
    const provider = { open: vi.fn(async () => ({ sessionId: "a".repeat(32) })), navigate: vi.fn(async () => ({ title: "page" })) } as unknown as AgentBrowserProvider;
    const tools = await agentBrowserTools(ctx, { provider, workspace: null });
    const abort = new AbortController(); abort.abort();
    const execute = tools.entries[0].tool.execute as (v: unknown, o: object) => Promise<unknown>;
    await expect(execute({ url: "https://example.com" }, { abortSignal: abort.signal })).rejects.toThrow(); expect(provider.open).not.toHaveBeenCalled();
    const live = new AbortController(); mock.rows = [[run], [{ toolKey: "agent_browser" }]];
    await execute({ url: "https://example.com" }, { abortSignal: live.signal });
    expect(provider.open).toHaveBeenCalledWith(scope, live.signal); expect(provider.navigate).toHaveBeenCalledWith("a".repeat(32), "https://example.com", live.signal);
  });
});
