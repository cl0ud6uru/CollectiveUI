import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type { AgentCtx, ToolEntry } from "@/lib/agent/types";
import type { Toolset } from "@/lib/agent/toolset";
import { mcpToolsetBinding } from "@/lib/agent/toolset-binding";
import { toolHash } from "@/lib/mcp/snapshot";
const h = vi.hoisted(() => ({ settings: vi.fn(), principal: vi.fn(), bot: vi.fn(), app: vi.fn(), provider: vi.fn(), servers: vi.fn(), configured: vi.fn(), skills: vi.fn(), authority: vi.fn(), decide: vi.fn(), execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: h.configured }) }) } }));
vi.mock("@/lib/settings", () => ({ getSetting: h.settings }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: h.principal }));
vi.mock("@/lib/authz", () => ({ getUsableBot: h.bot, getAccessibleModel: h.app, listAccessibleMcpServers: h.servers }));
vi.mock("@/lib/llm/resolve", () => ({ providerContextFor: h.provider }));
vi.mock("@/lib/llm/providers/decisions", () => ({ requestDecision: h.decide }));
vi.mock("@/lib/mcp/authorization", () => ({ mcpAuthorityBinding: h.authority }));
vi.mock("@/lib/agent/tools/skills", () => ({ currentSkillsForTurn: h.skills }));
import { toolShortlisting } from "@/lib/agent/tool-shortlisting";

const defs = ["report_read", "invoice_send", "task_status"].map(name => ({ name, description: `Allowed description ${name}`, inputSchema: { type: "object" as const, properties: { privateSchema: { type: "string", description: "Private argument details" } } } }));
const server = () => ({ id: "s", name: "Finance connector", status: "enabled", toolsSnapshot: defs.map(d => ({ ...d })), toolPolicy: {}, toolsDrift: null });
const context = () => ({ principal: { user: { id: "user", sessionVersion: 1, prefs: {} }, groupIds: [] },
  bot: { id: "bot", appId: "main", executionMode: "caller" }, app: { id: "main", provider: "openai-compatible", supportsTools: true },
  conversationId: "c", depth: 0, background: false, toolSettings: { disabledTools: [], enforcedApproval: [], maxStepsCap: 10 }, execution: { holder: "worker", deadlineAt: Date.now() + 30000 } } as unknown as AgentCtx);
function toolset(catalogDefs = defs) {
  const entries: ToolEntry[] = catalogDefs.map(d => ({ name: `finance__${d.name}`, key: "mcp:s", mcp: { tool: d.name, definitionHash: toolHash(d), readOnly: true, destructive: false, trusted: true, requireApproval: true },
    tool: tool({ description: d.description, inputSchema: z.object({ task: z.string() }), execute: h.execute }) }));
  const controls = Object.fromEntries(["use_skill", "workspace_bash", "ask_a", "ask_b", "continue_a", "openai_web_search", "unknown_control"].map(n => [n, {}]));
  return { entries, tools: { ...controls, ...Object.fromEntries(entries.map(e => [e.name, e.tool])) }, skills: [],
    approvalBinding: mcpToolsetBinding(["auth-v1"], entries), approval: () => ({ type: "denied", reason: "Denied" }) } as unknown as Toolset;
}
const answer = (questions: { name: string }[], probabilities = [0.95, 0.05]) => ({ status: "ok", inputTokens: 78,
  answers: questions.map((q, i) => ({ name: q.name, type: "predicate", probability: probabilities[i] })) });
beforeEach(() => {
  vi.resetAllMocks();
  h.settings.mockImplementation(async key => key === "decisions" ? { queenRouting: false, skillPicking: false, toolShortlisting: true, providerAppId: "api" } : { disabledTools: [] });
  h.principal.mockResolvedValue(context().principal); h.bot.mockResolvedValue(context().bot);
  h.app.mockImplementation(async (_p, id) => id === "main" ? context().app : { id: "api", enabled: true, provider: "openai", credentialMode: "org", baseUrl: null });
  h.provider.mockResolvedValue({ kind: "openai", secret: { type: "api-key", apiKey: "private-key" }, baseUrl: null });
  h.servers.mockResolvedValue([server()]); h.configured.mockResolvedValue([{ toolKey: "mcp:s", config: null }]); h.skills.mockResolvedValue([]);
  h.authority.mockResolvedValue("auth-v1"); h.decide.mockImplementation(async (_p, _input, q) => answer(q));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
describe("native MCP tool shortlisting", () => {
  it("only narrows optional first-step names, keeping controls, built-ins, delegates and original execution/approval objects", async () => {
    const set = toolset(); const snapshot = { ...set };
    const names = await toolShortlisting(context(), set, "Read one report");
    expect(names).toEqual(Object.keys(set.tools).filter(n => n !== "finance__invoice_send"));
    expect(names).toContain("finance__task_status"); expect(set).toEqual(snapshot);
    expect(set.approval({ toolCall: { toolName: "finance__report_read" } })).toMatchObject({ type: "denied" });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.decide).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-key|Read one report|finance|Allowed description/);
  });
  it("off performs no access, provider, catalog or decision requests and leaves objects intact", async () => {
    h.settings.mockResolvedValue({ toolShortlisting: false, queenRouting: true, skillPicking: true }); const set = toolset();
    expect(await toolShortlisting(context(), set, "Read")).toBeUndefined();
    expect(h.principal).not.toHaveBeenCalled(); expect(h.configured).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
  });
  it.each([{ app: { ...context().app, provider: "hermes" } }, { bot: { ...context().bot, hermesTeam: true } },
    { bot: { ...context().bot, executionMode: "service" } }, { app: { ...context().app, id: "explicit-model" } },
    { depth: 1 }, { background: true }, { inGroup: true }, { taskId: "task" }, { execution: undefined }])("skips unsupported contexts %j", async over => {
    expect(await toolShortlisting({ ...context(), ...over } as AgentCtx, toolset(), "Read")).toBeUndefined(); expect(h.decide).not.toHaveBeenCalled();
  });
  it("skips slash commands, continuations and resumed segments without calls", async () => {
    await toolShortlisting(context(), toolset(), "/skill Read");
    await toolShortlisting(context(), toolset(), "Read", { continuation: true }); await toolShortlisting(context(), toolset(), "Read", { stepsUsed: 1 });
    await toolShortlisting({ ...context(), execution: { ...context().execution!, segment: 1 } }, toolset(), "Read");
    expect(h.decide).not.toHaveBeenCalled();
  });
  it.each(["user", "bot", "app", "personal", "skill", "server", "serverBot", "serverSkill"])("retains explicit %s tool prerequisites independently of classifier output", async source => {
    const ctx = context(); let input = "Read";
    if (source === "user") input = "Read with finance__invoice_send";
    if (source === "bot") { ctx.bot!.instructions = "Require invoice_send"; h.bot.mockResolvedValue(ctx.bot); }
    if (source === "app") h.app.mockImplementation(async (_p, id) => id === "main" ? { ...ctx.app, systemPrompt: "Require finance__invoice_send" } : { id: "api", enabled: true, provider: "openai", credentialMode: "org" });
    if (source === "personal") h.principal.mockResolvedValue({ ...ctx.principal, user: { ...ctx.principal.user, prefs: { customInstructions: "Require invoice_send" } } });
    if (source === "skill") h.skills.mockResolvedValue([{ id: "s", instructions: "Require finance__invoice_send" }]);
    if (source === "server") input = "Read using Finance connector";
    if (source === "serverBot") { ctx.bot!.instructions = "Always use Finance connector"; h.bot.mockResolvedValue(ctx.bot); }
    if (source === "serverSkill") h.skills.mockResolvedValue([{ id: "s", instructions: "Always use Finance connector" }]);
    h.decide.mockImplementation(async (_p, _input, q) => answer(q, [0.95]));
    const names = await toolShortlisting(ctx, toolset(), input);
    if (source.startsWith("server")) { expect(names).toBeUndefined(); expect(h.decide).not.toHaveBeenCalled(); }
    else { expect(names).toContain("finance__invoice_send"); expect(h.decide.mock.calls[0][2]).toHaveLength(1); }
  });
  it.each(["cancelTask", "getTaskStatus", "resumeRun"])("retains camelCase MCP control %s", async name => {
    const catalogDefs = [...defs, { ...defs[0], name, description: "Control" }];
    h.servers.mockResolvedValue([{ ...server(), toolsSnapshot: catalogDefs }]);
    const set = toolset(catalogDefs);
    expect(await toolShortlisting(context(), set, "Read")).toContain(`finance__${name}`);
    expect(h.decide.mock.calls[0][2]).toHaveLength(2);
  });
  it("retains a tool explicitly named by its accepted title", async () => {
    const catalogDefs = defs.map(d => d.name === "invoice_send" ? { ...d, title: "Send an invoice" } : d);
    h.servers.mockResolvedValue([{ ...server(), toolsSnapshot: catalogDefs }]);
    h.decide.mockImplementation(async (_p, _input, q) => answer(q, [0.95]));
    expect(await toolShortlisting(context(), toolset(catalogDefs), "Use Send an invoice")).toContain("finance__invoice_send");
    expect(h.decide.mock.calls[0][2]).toHaveLength(1);
  });
  it("does not truncate an oversized eligible catalog or call unsupported providers", async () => {
    const catalogDefs = Array.from({ length: 33 }, (_, i) => ({ ...defs[0], name: `operation_${i}` }));
    h.servers.mockResolvedValue([{ ...server(), toolsSnapshot: catalogDefs }]);
    expect(await toolShortlisting(context(), toolset(catalogDefs), "Read")).toBeUndefined();
    h.servers.mockResolvedValue([server()]);
    h.app.mockImplementation(async (_p, id) => id === "main" ? context().app : { id: "api", enabled: true, provider: "chatgpt", credentialMode: "user" });
    expect(await toolShortlisting(context(), toolset(), "Read")).toBeUndefined(); expect(h.decide).not.toHaveBeenCalled();
  });
  it("sends only accepted allowed tool descriptions, with no schemas, arguments or provider credentials in the input", async () => {
    const s = server(); s.toolsSnapshot.push({ name: "private_unoffered", description: "Private connector description", inputSchema: defs[0].inputSchema });
    h.servers.mockResolvedValue([s]);
    await toolShortlisting(context(), toolset(), "Read");
    const sent = JSON.stringify(h.decide.mock.calls[0].slice(1));
    expect(sent).toContain("Allowed description report_read"); expect(sent).not.toMatch(/Private connector|privateSchema|Private argument|private-key/);
  });
  it.each(["company", "server", "bot", "definition", "drift", "binding", "session"])("rejects %s revocation/staleness before descriptions are sent", async change => {
    if (change === "company") h.settings.mockImplementation(async key => key === "decisions" ? { toolShortlisting: true, providerAppId: "api" } : { disabledTools: ["mcp"] });
    if (change === "server") h.servers.mockResolvedValue([]);
    if (change === "bot") h.configured.mockResolvedValue([]);
    if (change === "definition") h.servers.mockResolvedValue([{ ...server(), toolsSnapshot: defs.map(d => ({ ...d, description: "Changed" })) }]);
    if (change === "drift") h.servers.mockResolvedValue([{ ...server(), toolsDrift: { changed: ["report_read"], removed: [] } }]);
    if (change === "binding") h.authority.mockResolvedValue("revoked-user-grant");
    if (change === "session") h.principal.mockResolvedValue(null);
    expect(await toolShortlisting(context(), toolset(), "Read")).toBeUndefined(); expect(h.decide).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "timeout", "invalid", "refusal"])("falls back on %s without retry", async status => {
    h.decide.mockResolvedValue({ status }); expect(await toolShortlisting(context(), toolset(), "Read")).toBeUndefined(); expect(h.decide).toHaveBeenCalledTimes(1);
  });
  it.each([{ probabilities: [0.05, 0.05] }, { probabilities: [0.95, 0.5] }])("falls back for none or uncertain answers %j", async ({ probabilities }) => {
    h.decide.mockImplementation(async (_p, _input, q) => answer(q, probabilities)); expect(await toolShortlisting(context(), toolset(), "Read")).toBeUndefined();
  });
  it.each(["tool", "grant", "toggle", "provider", "skill", "session"])("rejects %s changes while the request runs", async change => {
    h.decide.mockImplementation(async (_p, _input, q) => {
      if (change === "tool") h.servers.mockResolvedValue([{ ...server(), toolPolicy: { report_read: { enabled: false } } }]);
      if (change === "grant") h.authority.mockResolvedValue("auth-revoked");
      if (change === "toggle") h.settings.mockResolvedValue({ toolShortlisting: false, disabledTools: [] });
      if (change === "provider") h.provider.mockResolvedValue({ secret: "changed" });
      if (change === "skill") h.skills.mockResolvedValue([{ id: "s", version: 2, instructions: "Require invoice_send" }]);
      if (change === "session") h.principal.mockResolvedValue(null);
      return answer(q);
    });
    expect(await toolShortlisting(context(), toolset(), "Read")).toBeUndefined(); expect(h.decide).toHaveBeenCalledTimes(1);
  });
  it("keeps legacy catalogs and unsupported providers, malformed answers and expired/aborted budgets on the old path", async () => {
    h.servers.mockResolvedValue([{ ...server(), toolsSnapshot: null }]); await toolShortlisting(context(), toolset(), "Read");
    h.servers.mockResolvedValue([server()]); h.app.mockRejectedValueOnce(new Error("Denied")); await toolShortlisting(context(), toolset(), "Read");
    await toolShortlisting({ ...context(), execution: { holder: "w", deadlineAt: Date.now() } }, toolset(), "Read");
    await toolShortlisting(context(), toolset(), "Read", { signal: AbortSignal.abort() }); expect(h.decide).not.toHaveBeenCalled();
    h.decide.mockResolvedValue({ status: "ok", answers: [{ type: "predicate", name: "invented", probability: 1 }] });
    expect(await toolShortlisting(context(), toolset(), "Read")).toBeUndefined();
  });
  it("keeps a shortlist valid across another bot's send and sidebar moves", async () => {
    const ctx = context();
    ctx.principal.user.prefs = { customInstructions: "Follow the current request", memoryEnabled: true, learningEnabled: true };
    h.principal.mockResolvedValue(ctx.principal);
    h.decide.mockImplementation(async (_p, _input, q) => {
      h.principal.mockResolvedValue({ ...ctx.principal, user: { ...ctx.principal.user,
        prefs: { ...ctx.principal.user.prefs, botOrder: ["other", "bot"], botLastSentAt: { other: "2026-10-07T12:00:00Z" } } } });
      return answer(q);
    });
    const set = toolset();
    expect(await toolShortlisting(ctx, set, "Read")).toEqual(Object.keys(set.tools).filter(n => n !== "finance__invoice_send"));
    expect(h.decide).toHaveBeenCalledTimes(1); expect(h.execute).not.toHaveBeenCalled();
  });
  it.each(["customInstructions", "memoryEnabled", "learningEnabled"] as const)("still rejects %s changes during shortlisting", async preference => {
    const ctx = context();
    h.decide.mockImplementation(async (_p, _input, q) => {
      h.principal.mockResolvedValue({ ...ctx.principal, user: { ...ctx.principal.user,
        prefs: { [preference]: preference === "customInstructions" ? "Changed guidance" : false } } });
      return answer(q);
    });
    expect(await toolShortlisting(ctx, toolset(), "Read")).toBeUndefined();
    expect(h.decide).toHaveBeenCalledTimes(1);
  });
});
