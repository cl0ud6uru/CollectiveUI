import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
import type { Toolset } from "@/lib/agent/toolset";
import type { Skill } from "@/db/schema";
const h = vi.hoisted(() => ({ settings: vi.fn(), principal: vi.fn(), app: vi.fn(), bot: vi.fn(), provider: vi.fn(), catalog: vi.fn(), decide: vi.fn(), record: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/settings", () => ({ getSetting: h.settings }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: h.principal }));
vi.mock("@/lib/authz", () => ({ getAccessibleModel: h.app, getUsableBot: h.bot }));
vi.mock("@/lib/llm/resolve", () => ({ providerContextFor: h.provider }));
vi.mock("@/lib/agent/learning/store", () => ({ learnedSkillsForBot: vi.fn(), learningIsEnabled: vi.fn(), recordLearnedSkillUse: h.record }));
vi.mock("@/lib/agent/tools/skills", async original => ({ ...await original<typeof import("@/lib/agent/tools/skills")>(), currentSkillsForTurn: h.catalog }));
vi.mock("@/lib/llm/providers/decisions", () => ({ requestDecision: h.decide }));
import { skillPicking } from "@/lib/agent/skill-picking";
import { skillTool } from "@/lib/agent/tools/skills";

const skill = (id: string, over = {}) => ({ id, slug: `slug-${id}`, name: `Skill ${id}`, description: `Description ${id}`,
  instructions: `Private steps ${id}`, version: 1, ownerId: "owner", botId: "bot", updatedAt: new Date(0), ...over } as Skill);
const skills = [skill("a"), skill("b"), skill("pinned", { pinned: true }), skill("policy", { mandatory: true })];
const context = () => ({ bot: { id: "bot", ownerId: "owner", appId: "main", executionMode: "caller", instructions: "Follow current task" },
  app: { id: "main", provider: "openai-compatible", supportsTools: true }, principal: { user: { id: "user", sessionVersion: 1, prefs: {} } },
  conversationId: "c", depth: 0, background: false, execution: { deadlineAt: Date.now() + 30000, holder: "worker" } } as AgentCtx);
function toolset(available = skills) {
  const entry = skillTool(context(), available);
  return { skills: available, entries: entry ? [entry] : [], tools: { ...(entry ? { use_skill: entry.tool } : {}), workspace_bash: {} }, approval: () => ({ type: "denied" }) } as unknown as Toolset;
}
const result = (questions: { name: string }[], probabilities = [0.95, 0.05]) => ({ status: "ok", inputTokens: 56,
  answers: questions.map((q, i) => ({ type: "predicate", name: q.name, probability: probabilities[i] })) });
beforeEach(() => {
  vi.resetAllMocks();
  h.settings.mockResolvedValue({ queenRouting: false, skillPicking: true, providerAppId: "api" });
  h.principal.mockResolvedValue(context().principal); h.bot.mockResolvedValue(context().bot);
  h.app.mockImplementation(async (_p, id) => id === "main" ? context().app : { id: "api", enabled: true, provider: "openai", credentialMode: "org", baseUrl: null });
  h.provider.mockResolvedValue({ kind: "openai", secret: { type: "api-key", apiKey: "private-key" }, baseUrl: null });
  h.catalog.mockResolvedValue(skills);
  h.decide.mockImplementation(async (_p, _input, questions) => result(questions));
  vi.spyOn(console, "info").mockImplementation(() => {});
});
describe("native optional skill picking", () => {
  it("narrows optional skills, retains pinned and mandatory guidance, and preserves the existing execute wrapper", async () => {
    const set = toolset(); const original = set.tools.use_skill.execute!;
    const execute = vi.fn(original); set.tools.use_skill.execute = execute;
    const picked = (await skillPicking(context(), set, "Read the report"))!;
    expect(picked.skills.map(s => s.id)).toEqual(["a", "pinned", "policy"]);
    expect(picked.tools.workspace_bash).toBe(set.tools.workspace_bash);
    expect(picked.tools.use_skill.description).toContain("slug-a"); expect(picked.tools.use_skill.description).not.toContain("slug-b");
    const schema = picked.tools.use_skill.inputSchema as import("zod").ZodType;
    expect(schema.safeParse({ slug: "slug-a" }).success).toBe(true); expect(schema.safeParse({ slug: "slug-b" }).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    const loaded = await picked.tools.use_skill.execute!({ slug: "slug-a" }, {} as never);
    expect(loaded).toMatchObject({ skillId: "a", version: 1 }); expect(execute).toHaveBeenCalledTimes(1);
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private-key|Read the report|Description|Private steps|slug-/);
  });
  it("off reproduces the original catalog and performs no access, credential or API calls", async () => {
    h.settings.mockResolvedValue({ skillPicking: false, queenRouting: true, providerAppId: "api" });
    const set = toolset(); const snapshot = { ...set };
    expect(await skillPicking(context(), set, "Read")).toBeUndefined(); expect(set).toEqual(snapshot);
    expect(h.catalog).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
  });
  it.each([{ app: { ...context().app, provider: "hermes" } }, { bot: { ...context().bot, hermesTeam: true } },
    { app: { ...context().app, id: "explicit-model" } }, { bot: { ...context().bot, executionMode: "service" } },
    { depth: 1 }, { background: true }, { inGroup: true }, { taskId: "task" }, { execution: undefined }])("skips unsupported contexts %j", async over => {
    expect(await skillPicking({ ...context(), ...over } as AgentCtx, toolset(), "Read")).toBeUndefined(); expect(h.decide).not.toHaveBeenCalled();
  });
  it("preserves slash commands, named skills, continuation and resumed turns", async () => {
    for (const input of ["/slug-a Read", "/unknown Read", "Use Skill b", "Use slug-b"])
      expect(await skillPicking(context(), toolset(), input)).toBeUndefined();
    await skillPicking(context(), toolset(), "Read", { continuation: true }); await skillPicking(context(), toolset(), "Read", { stepsUsed: 1 });
    await skillPicking({ ...context(), execution: { ...context().execution!, segment: 1 } }, toolset(), "Read");
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("retains skills named in bot/system/personal instructions without sending them to the picker", async () => {
    const ctx = context(); ctx.bot!.instructions = "Always use slug-b"; h.bot.mockResolvedValue(ctx.bot);
    h.decide.mockImplementation(async (_p, _input, q) => result(q, [0.95]));
    const picked = await skillPicking(ctx, toolset(), "Read");
    expect(picked?.skills.map(s => s.id)).toEqual(["a", "b", "pinned", "policy"]);
    expect(h.decide.mock.calls[0][2]).toHaveLength(1);
  });
  it("filters current company/bot/user grants and revisions before sending descriptions; never sends private instructions", async () => {
    h.catalog.mockResolvedValue([skills[0], skill("secret"), skill("b", { version: 2 })]);
    h.decide.mockImplementation(async (_p, _input, q) => result(q, [0.95]));
    const picked = await skillPicking(context(), toolset(skills.slice(0, 2)), "Read");
    expect(picked?.skills.map(s => s.id)).toEqual(["a"]);
    const sent = JSON.stringify(h.decide.mock.calls[0].slice(1));
    expect(sent).toContain("Description a"); expect(sent).not.toMatch(/secret|Description b|Private steps|pinned|policy/);
  });
  it.each(["mandatory", "pinned", "reference"].flatMap(protection => ["revised", "revoked", "new"].map(change => ({ protection, change }))))("does not narrow around protected snapshot changes %j", async ({ protection, change }) => {
    const ctx = context();
    if (protection === "reference") { ctx.bot!.instructions = "Always use slug-protected"; h.bot.mockResolvedValue(ctx.bot); }
    const protectedItem = skill("protected", { mandatory: protection === "mandatory", pinned: protection === "pinned" });
    const original = [...skills.slice(0, 2), ...(change === "new" ? [] : [protectedItem])];
    const catalog = [...skills.slice(0, 2), ...(change === "revoked" ? [] : [{ ...protectedItem, version: change === "revised" ? 2 : 1 }])];
    h.catalog.mockResolvedValue(catalog);
    const set = toolset(original);
    expect(await skillPicking(ctx, set, "Read")).toBeUndefined(); expect(set.skills).toBe(original);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it.each(["mandatory", "pinned"])("keeps the full catalog if an optional skill becomes %s before selection", async protection => {
    h.catalog.mockResolvedValue(skills.map(s => s.id === "a" ? { ...s, [protection]: true } : s));
    expect(await skillPicking(context(), toolset(), "Read")).toBeUndefined(); expect(h.decide).not.toHaveBeenCalled();
  });
  it.each(["timeout", "unavailable", "refusal", "invalid"])("falls back on %s once", async status => {
    h.decide.mockResolvedValue({ status }); expect(await skillPicking(context(), toolset(), "Read")).toBeUndefined();
    expect(h.decide).toHaveBeenCalledTimes(1);
  });
  it.each([{ probabilities: [0.05, 0.05] }, { probabilities: [0.95, 0.5] }])("keeps the original catalog for none or uncertain results %j", async ({ probabilities }) => {
    h.decide.mockImplementation(async (_p, _input, q) => result(q, probabilities));
    expect(await skillPicking(context(), toolset(), "Read")).toBeUndefined();
  });
  it("rejects invalid/version-mismatched answer ids", async () => {
    h.decide.mockResolvedValue({ status: "ok", answers: [{ type: "predicate", name: "invented", probability: 0.99 }] });
    expect(await skillPicking(context(), toolset(), "Read")).toBeUndefined();
  });
  it.each(["catalog", "pinned", "permission", "session", "bot", "provider", "toggle"])("rejects %s revocation or changes during selection", async change => {
    h.decide.mockImplementation(async (_p, _input, q) => {
      if (change === "catalog") h.catalog.mockResolvedValue([skill("a", { version: 2 }), ...skills.slice(1)]);
      if (change === "pinned") h.catalog.mockResolvedValue([skill("a", { pinned: true }), ...skills.slice(1)]);
      if (change === "permission") h.catalog.mockResolvedValue([]);
      if (change === "session") h.principal.mockResolvedValue(null);
      if (change === "bot") h.bot.mockRejectedValue(new Error("Revoked bot"));
      if (change === "provider") h.provider.mockResolvedValue({ kind: "openai", secret: "changed" });
      if (change === "toggle") h.settings.mockResolvedValue({ skillPicking: false });
      return result(q);
    });
    expect(await skillPicking(context(), toolset(), "Read")).toBeUndefined(); expect(h.decide).toHaveBeenCalledTimes(1);
  });
  it("blocks stale/revoked selected skill use and does not execute hidden skills or re-pick", async () => {
    const set = toolset(); const execute = vi.fn(set.tools.use_skill.execute!); set.tools.use_skill.execute = execute;
    const picked = (await skillPicking(context(), set, "Read"))!;
    h.catalog.mockResolvedValue([]);
    expect(await picked.tools.use_skill.execute!({ slug: "slug-a" }, {} as never)).toHaveProperty("error");
    h.catalog.mockResolvedValue(skills);
    expect(await picked.tools.use_skill.execute!({ slug: "slug-b" }, {} as never)).toHaveProperty("error");
    expect(execute).not.toHaveBeenCalled(); expect(h.decide).toHaveBeenCalledTimes(1);
  });
  it.each(["canonical", "alias"])("keeps the full catalog when narrowing changes %s slug resolution", async collision => {
    const catalog = [skill("a", { slug: "learned-shared-report" }), skills[1], skill("policy", {
      mandatory: true, slug: collision === "canonical" ? "learned-shared-report" : "learned-policy",
      aliases: ["learned-shared-report"],
    })];
    h.catalog.mockResolvedValue(catalog);
    h.decide.mockImplementation(async (_p, _input, q) => result(q, [0.05, 0.95]));
    const set = toolset(catalog); const original = set.tools.use_skill;
    expect(await skillPicking(context(), set, "Read")).toBeUndefined();
    expect(set.tools.use_skill).toBe(original); expect(set.skills).toBe(catalog);
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith("[decisions]", expect.objectContaining({ outcome: "ambiguous" }));
  });
  it("makes no request for inaccessible/unsupported provider, no catalog or exhausted deadline", async () => {
    h.app.mockRejectedValueOnce(new Error("No access")); await skillPicking(context(), toolset(), "Read");
    h.app.mockImplementation(async (_p, id) => id === "main" ? context().app : { provider: "chatgpt", enabled: true, credentialMode: "user" });
    await skillPicking(context(), toolset(), "Read");
    await skillPicking(context(), toolset([]), "Read");
    await skillPicking({ ...context(), execution: { holder: "w", deadlineAt: Date.now() } }, toolset(), "Read");
    expect(h.decide).not.toHaveBeenCalled();
  });
});
