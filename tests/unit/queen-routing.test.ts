import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
import type { Toolset } from "@/lib/agent/toolset";
import type { PortalUIMessage } from "@/lib/chat/store";
const h = vi.hoisted(() => ({ settings: vi.fn(), principal: vi.fn(), app: vi.fn(), provider: vi.fn(), discover: vi.fn(), decide: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/settings", () => ({ getSetting: h.settings }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: h.principal }));
vi.mock("@/lib/authz", () => ({ getAccessibleModel: h.app }));
vi.mock("@/lib/llm/resolve", () => ({ providerContextFor: h.provider }));
vi.mock("@/lib/coordinator/delegation", () => ({ discoverDelegates: h.discover }));
vi.mock("@/lib/llm/providers/decisions", () => ({ requestDecision: h.decide }));
import { queenRouting } from "@/lib/agent/queen-routing";

const specialist = (id: string) => ({ id, name: `Specialist ${id}`, description: `Job ${id}`, updatedAt: "v1" });
const delegates = [specialist("a"), specialist("b")];
const context = () => ({ bot: { id: "queen", appId: "main", executionMode: "caller" }, app: { id: "main", provider: "openai-compatible", supportsTools: true },
  principal: { user: { id: "owner", sessionVersion: 1 } }, conversationId: "conversation", depth: 0, background: false,
  execution: { deadlineAt: Date.now() + 30000, holder: "worker" } } as AgentCtx);
const toolset = () => ({ delegates, entries: [
  { name: "ask_a", key: "delegate:a" }, { name: "ask_b", key: "delegate:b" }, { name: "continue_a", key: "delegate:a" },
], tools: { ask_a: {}, ask_b: {}, continue_a: {}, task_status: {}, workspace_bash: {}, use_skill: {}, ask_external_control: {} } } as unknown as Toolset);
const result = (over: object = {}) => ({ status: "ok", inputTokens: 123, answers: [
  { type: "predicate", name: "single_task", probability: 0.95 },
  { type: "choice", name: "delegate", choice: "a", confidence: 0.95,
    probabilities: [{ value: "queen", probability: 0.025 }, { value: "a", probability: 0.95 }, { value: "b", probability: 0.025 }], ...over },
] });
beforeEach(() => {
  vi.resetAllMocks();
  h.settings.mockImplementation(async key => key === "decisions" ? { queenRouting: true, providerAppId: "api" } : { enabled: true, defaultBotId: "queen" });
  h.principal.mockResolvedValue(context().principal);
  h.app.mockResolvedValue({ id: "api", enabled: true, provider: "openai", credentialMode: "org", baseUrl: null });
  h.provider.mockResolvedValue({ kind: "openai", secret: { type: "api-key", apiKey: "private-key" }, baseUrl: null });
  h.discover.mockResolvedValue(delegates.map(bot => ({ bot, mode: "coordinator" })));
  h.decide.mockResolvedValue(result());
  vi.spyOn(console, "info").mockImplementation(() => {});
});
describe("Queen routing admission, fallback and revocation", () => {
  it("offers only the chosen new assignment, preserving controls, approval tools and follow-ups", async () => {
    expect(await queenRouting(context(), toolset(), [], "Read one report")).toEqual(["ask_a", "continue_a", "task_status", "workspace_bash", "use_skill", "ask_external_control"]);
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.decide.mock.calls[0][2][1].choices.map((c: { value: string }) => c.value)).toEqual(["queen", "a", "b"]);
    expect(console.info).toHaveBeenCalledWith("[decisions]", expect.objectContaining({ outcome: "accepted", calls: 1, inputTokens: 123 }));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-key|Read one report|Specialist/);
  });
  it("off exactly keeps normal tools and sends no request", async () => {
    h.settings.mockResolvedValue({ queenRouting: false, providerAppId: "api" });
    expect(await queenRouting(context(), toolset(), [], "Read one report")).toBeUndefined();
    expect(h.decide).not.toHaveBeenCalled(); expect(h.discover).not.toHaveBeenCalled();
  });
  it.each([
    { app: { ...context().app, provider: "hermes" } }, { app: { ...context().app, id: "explicit-model" } },
    { bot: { ...context().bot, id: "explicit-bot" } }, { depth: 1 }, { background: true }, { inGroup: true }, { taskId: "task" },
    { execution: undefined }, { bot: { ...context().bot, executionMode: "service" } },
  ])("bypasses unsupported/explicit contexts %j", async over => {
    expect(await queenRouting({ ...context(), ...over } as AgentCtx, toolset(), [], "Read one report")).toBeUndefined();
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("bypasses explicit commands, specialists, continuations, resumes and related-task history", async () => {
    for (const input of ["/report Read", "@Specialist a Read", "Ask Specialist a to read"])
      expect(await queenRouting(context(), toolset(), [], input)).toBeUndefined();
    await queenRouting(context(), toolset(), [], "Read", { continuation: true });
    await queenRouting(context(), toolset(), [], "Read", { stepsUsed: 1 });
    await queenRouting(context(), toolset(), [{ id: "old", role: "assistant", parts: [{ type: "tool-ask_a" }] }] as unknown as PortalUIMessage[], "Read");
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("permission-filters choices before sending any descriptions", async () => {
    h.discover.mockResolvedValue([{ bot: delegates[0], mode: "coordinator" }, { bot: specialist("secret"), mode: "coordinator" }]);
    await queenRouting(context(), toolset(), [], "Read one report");
    const sent = JSON.stringify(h.decide.mock.calls[0].slice(1));
    expect(sent).toContain("Job a"); expect(sent).not.toMatch(/Job b|secret/);
  });
  it.each(["unavailable", "timeout", "invalid", "refusal"])("falls back on %s without retrying", async status => {
    h.decide.mockResolvedValue({ status });
    expect(await queenRouting(context(), toolset(), [], "Read one report")).toBeUndefined();
    expect(h.decide).toHaveBeenCalledTimes(1);
  });
  it("falls back for uncertain, multi-intent and Queen answers", async () => {
    for (const r of [result({ confidence: 0.89 }), result({ choice: "queen" }), { ...result(), answers: [
      { type: "predicate", probability: 0.4 }, result().answers[1],
    ] }]) { h.decide.mockResolvedValue(r); expect(await queenRouting(context(), toolset(), [], "Read one report")).toBeUndefined(); }
  });
  it("rejects stale candidate revisions, revoked permission and disabled toggle during a request", async () => {
    for (const revoked of ["candidate", "permission", "toggle", "provider", "session"]) {
      h.discover.mockResolvedValue(delegates.map(bot => ({ bot, mode: "coordinator" })));
      h.settings.mockImplementation(async key => key === "decisions" ? { queenRouting: true, providerAppId: "api" } : { enabled: true, defaultBotId: "queen" });
      h.provider.mockResolvedValue({ kind: "openai", secret: "revision1" }); h.principal.mockResolvedValue(context().principal);
      h.decide.mockImplementation(async () => {
        if (revoked === "candidate") h.discover.mockResolvedValue([{ bot: { ...delegates[0], updatedAt: "v2" }, mode: "coordinator" }]);
        if (revoked === "permission") h.discover.mockResolvedValue([]);
        if (revoked === "toggle") h.settings.mockResolvedValue({ queenRouting: false });
        if (revoked === "provider") h.provider.mockResolvedValue({ kind: "openai", secret: "revision2" });
        if (revoked === "session") h.principal.mockResolvedValue(null);
        return result();
      });
      expect(await queenRouting(context(), toolset(), [], "Read one report")).toBeUndefined();
    }
  });
  it("falls back when provider is inaccessible/unsupported, team is empty or budget is exhausted", async () => {
    h.app.mockRejectedValueOnce(new Error("Access denied"));
    await queenRouting(context(), toolset(), [], "Read");
    h.app.mockResolvedValue({ enabled: true, provider: "chatgpt", credentialMode: "user", baseUrl: null });
    await queenRouting(context(), toolset(), [], "Read");
    h.discover.mockResolvedValue([]); await queenRouting(context(), toolset(), [], "Read");
    expect(h.decide).not.toHaveBeenCalled();
  });
});
