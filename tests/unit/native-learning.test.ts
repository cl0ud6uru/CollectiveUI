import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { ReviewedLesson } from "@/lib/agent/learning/types";
import type { Tx } from "@/db";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, query: null as Tx | null, generate: vi.fn(), decide: vi.fn(), embed: vi.fn(async () => null as number[][] | null), enqueue: vi.fn(async () => "job") }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: fixture.generate }));
vi.mock("@/lib/jobs", () => ({ QUEUES: { learningReview: "learning.review" }, enqueue: fixture.enqueue }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), resolveModel: async () => ({ model: {} }), embedTexts: fixture.embed }));
vi.mock("@/lib/llm/providers/decisions", () => ({ requestDecision: fixture.decide }));
vi.mock("@/lib/hermes-team/learning", async original => {
  const learning = await original<typeof import("@/lib/hermes-team/learning")>();
  return { ...learning, withNonTeamLearning: <T>(id: string, skip: T, work: (q: Tx) => Promise<T>, onSkip?: (q: Tx) => Promise<void>) =>
    learning.withNonTeamLearning(id, skip, async q => { fixture.query = q; try { return await work(q); } finally { fixture.query = null; } }, onSkip) };
});

import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { afterLearningMutationLock, changeLearning, learnedSkillsForBot, learnedPreferences, recordLearnedSkillUse, learningHistory, learningViews } from "@/lib/agent/learning/store";
import { reviewNativeRun, scheduleLearningReview, recoverLearningReviews } from "@/lib/agent/learning/review";
import { successfulToolEvidence, lessonDisposition } from "@/lib/agent/learning/policy";
import { curateLearnedSkills } from "@/lib/agent/learning/curator";
import { selectMemories } from "@/lib/agent/memory";
import { currentSkillsForTurn, renderSkill, skillTool } from "@/lib/agent/tools/skills";
import type { AgentCtx } from "@/lib/agent/types";
import { findSkill, slashInvokedSkill } from "@/lib/agent/skill-lookup";
import { buildToolset } from "@/lib/agent/toolset";
import { memoryTools } from "@/lib/agent/tools/memory";
import { toolShortlisting } from "@/lib/agent/tool-shortlisting";
import { getSetting } from "@/lib/settings";
import { AAD, encrypt } from "@/lib/crypto";

let owner: Principal; let member: Principal; let boss: Principal;
const content = {
  name: "Check missing critical workstation updates",
  description: "Check whether a requested workstation group needs critical updates.",
  instructions: "1. Resolve the requested group using mcp_action1_groups. Ask if ambiguous.\n2. Query missing updates using mcp_action1_updates and filter critical severity.\n3. Verify pagination and report results. Checking does not authorize installation.",
  expectedOutput: "Summary and affected workstation count.", boundaries: "Read only. Never install without a new explicit request and required approval.",
};
const lesson = (over: Partial<ReviewedLesson> = {}): ReviewedLesson => ({
  ...content, topic: "critical-update-check", scope: "bot", kind: "procedure", baseVersion: 0,
  evidenceCallIds: ["update-call"], verification: "The missing-update query returned critical updates and its pagination status.", ...over,
});
const toolPart = (over: object = {}) => ({
  type: "dynamic-tool", toolName: "mcp_action1_updates", toolCallId: "update-call", state: "output-available",
  input: { group: "KY", severity: "critical" }, output: { missing: [{ endpointId: "private-endpoint-123", hostname: "KY-FINANCE-001" }], hasMore: false }, ...over,
});

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/(CREATE TABLE "memories" \([\s\S]*?"embedding" )vector,/, "$1text,").replace(/\bvector\b/g, "real[]"));
  }
}, 45000);
beforeEach(async () => {
  vi.clearAllMocks();
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values([
    { id: "owner", name: "Owner Person", upn: "owner@fixture.invalid", authSource: "ldap" },
    { id: "member", name: "Helpdesk Person", upn: "member@fixture.invalid", authSource: "ldap" },
    { id: "boss", name: "Boss Person", upn: "boss@fixture.invalid", authSource: "ldap" },
  ]);
  owner = (await loadPrincipal("owner"))!; member = (await loadPrincipal("member"))!; boss = (await loadPrincipal("boss"))!;
  await db.insert(schema.aiApps).values({ id: "model", name: "Fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", supportsTools: true });
  await db.insert(schema.bots).values({ id: "bot", name: "Action1", ownerId: "owner", appId: "model", visibility: "org", boundaries: "Check only unless the user explicitly requests changes." });
  await db.insert(schema.conversations).values({ id: "chat", userId: "member", botId: "bot", appId: "model" });
  await db.insert(schema.messages).values([
    { id: "prompt", conversationId: "chat", role: "user", parts: [{ type: "text", text: "Check if KY workstations need critical updates installed." }] },
    { id: "reply", parentId: "prompt", conversationId: "chat", role: "assistant", parts: [toolPart(), { type: "text", text: "Critical updates are missing. Nothing was installed." }] },
  ]);
  await db.insert(schema.agentRuns).values({ id: "run", userId: "member", conversationId: "chat", messageId: "reply", parentMessageId: "prompt", appId: "model", botId: "bot", status: "succeeded" });
  await db.insert(schema.botLearningReviews).values({ runId: "run" });
  fixture.generate.mockResolvedValue({ output: { lessons: [lesson()] } });
});
afterAll(async () => { await fixture.client?.close(); });

describe("native learning with real PostgreSQL migrations", () => {
  it("shortlists through real MCP authorization and still rejects a revoked grant at dispatch", async () => {
    await db.insert(schema.aiApps).values({ id: "api", name: "Company API", provider: "openai", model: "gpt-6-luna", credentialMode: "org", apiKeyEnc: encrypt("fixture-key", AAD.appApiKey) });
    await db.insert(schema.settings).values({ key: "decisions", value: { toolShortlisting: true, providerAppId: "api" } });
    const defs = ["read_report", "send_invoice"].map(name => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } }));
    await db.insert(schema.mcpServers).values({ id: "finance", name: "Finance", url: "https://fixture.invalid/mcp", status: "enabled", toolsSnapshot: defs });
    await db.insert(schema.botTools).values({ botId: "bot", toolKey: "mcp:finance", approval: "ask" });
    await db.insert(schema.toolGrants).values({ userId: "member", botId: "bot", toolName: "finance__read_report" });
    const [bot] = await db.select().from(schema.bots); const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, "model"));
    const ctx = { principal: member, bot, app, conversationId: "chat", depth: 0, background: false, execution: { holder: "fixture", deadlineAt: Date.now() + 30000 }, toolSettings: await getSetting("tools") } as AgentCtx;
    const set = await buildToolset(ctx);
    fixture.decide.mockImplementation(async (_p, _input, q) => ({ status: "ok", inputTokens: 12,
      answers: q.map((question: { name: string }, i: number) => ({ type: "predicate", name: question.name, probability: i === 0 ? 0.95 : 0.05 })) }));
    try {
      expect(await toolShortlisting(ctx, set, "Read a report")).toEqual(["finance__read_report"]);
      expect(set.approval({ toolCall: { toolName: "finance__send_invoice", input: {} } })).toBe("user-approval");
      await db.delete(schema.toolGrants);
      await expect(set.tools.finance__read_report.execute!({}, { toolCallId: "revoked", messages: [], context: undefined })).rejects.toThrow("Tool permissions or configuration changed");
      expect(await toolShortlisting(ctx, set, "Read a report")).toBeUndefined();
      expect(fixture.decide).toHaveBeenCalledTimes(1);
    } finally { await set.close(); }
  });
  it("rebuilds the picker catalog from current bot, company and personal skill grants", async () => {
    await db.insert(schema.skills).values([
      { id: "saved", ownerId: "owner", botId: "bot", slug: "saved", name: "Saved", description: "Allowed", instructions: "Steps" },
      { id: "private", ownerId: "member", botId: "bot", slug: "private", name: "Private", description: "Other user", instructions: "Private steps" },
    ]);
    await db.insert(schema.botTools).values({ botId: "bot", toolKey: "skills", approval: "auto" });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson(), lesson({ kind: "policy", topic: "safety-policy" })] } });
    await reviewNativeRun("run");
    const policy = (await learningViews(owner, "bot")).find(row => row.kind === "policy")!;
    if (policy.status === "pending") await changeLearning(owner, policy.id, policy.version, { status: "active" });
    const [bot] = await db.select().from(schema.bots);
    const ctx = { principal: boss, bot } as AgentCtx;
    const catalog = await currentSkillsForTurn(ctx);
    expect(catalog.map(s => s.id)).toContain("saved"); expect(catalog.map(s => s.id)).not.toContain("private");
    expect(catalog.find(s => s.id === policy.id)?.mandatory).toBe(true);
    await db.delete(schema.botTools);
    expect((await currentSkillsForTurn(ctx)).map(s => s.id)).not.toContain("saved");
    expect(await currentSkillsForTurn({ ...ctx, principal: { ...boss, user: { ...boss.user, prefs: { learningEnabled: false } } } })).toEqual([]);
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: ["skills"] } });
    expect(await currentSkillsForTurn(ctx)).toEqual([]);
  });
  it("learns a verified Action1 procedure for everyone, without installing updates or exposing the source chat", async () => {
    expect(await reviewNativeRun("run")).toBe(1);
    const shared = await learningViews(boss, "bot");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ scope: "bot", status: "active", canManage: false, version: 1 });
    expect(JSON.stringify(shared)).not.toMatch(/private-endpoint|KY-FINANCE|member@|sourceConversationId|sourceRunId/);
    const skills = await learnedSkillsForBot("bot", "boss");
    expect(renderSkill(skills[0])).toContain("A request to check does not authorize changes");
    expect(renderSkill(skills[0])).toContain("Never install");
    expect(skills[0].slug).toBe("learned-shared-critical-update-check");
    expect(fixture.generate.mock.calls[0][0].tools).toBeUndefined();
  });

  it("keeps MCP isError results out of verified shared learning", async () => {
    await db.update(schema.messages).set({ parts: [toolPart({ output: { isError: true, content: [{ type: "text", text: "Fixture connector failure" }] } })] }).where(eq(schema.messages.id, "reply"));
    expect(await reviewNativeRun("run")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(await db.select().from(schema.botLearnings)).toHaveLength(0);
  });

  it("splits mixed learning into a shared method and a private Helpdesk preference", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson(), lesson({
      topic: "report-format", name: "My report layout", description: "Use my preferred layout for update reports.",
      instructions: "Lead with a short summary, then group affected machines by account owner.", kind: "preference", scope: "bot", evidenceCallIds: [],
    })] } });
    expect(await reviewNativeRun("run")).toBe(2);
    expect(await learnedSkillsForBot("bot", "member")).toHaveLength(1);
    expect(await learnedPreferences("member", "bot")).toHaveLength(1);
    expect(await learnedPreferences("boss", "bot")).toHaveLength(0);
    expect((await selectMemories({ userId: "member", botId: "bot" })).map(m => m.content).join(" ")).toContain("Lead with a short summary");
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(1);
    expect(await learningViews(owner, "bot")).toHaveLength(1);
    const [privateRow] = await db.select().from(schema.botLearnings).where(eq(schema.botLearnings.userId, "member"));
    await expect(changeLearning(owner, privateRow.id, 1, { status: "archived" })).rejects.toMatchObject({ status: 403 });
    await expect(learningHistory(boss, privateRow.id)).rejects.toMatchObject({ status: 403 });
  });

  it("corrects ordinary memory and an approved personal preference by distinct IDs, retaining learned history", async () => {
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, "bot"));
    const ordinaryContent = "Use a short update summary.";
    const preferenceContent = { ...content, name: "Report format", description: "Use my report layout.", instructions: "Lead with a summary.", boundaries: "Always use two numbered summary bullets." };
    const [ordinary] = await db.insert(schema.memories).values({ userId: "member", botId: "bot", content: ordinaryContent, embedding: [0.1, 0.2] }).returning();
    const [preference] = await db.insert(schema.botLearnings).values({
      botId: "bot", userId: "member", topic: "report-format", kind: "preference", status: "active",
      content: preferenceContent, verification: "The user explicitly requested this format.", version: 1,
    }).returning();
    await db.insert(schema.botLearningRevisions).values({
      learningId: preference.id, version: 1, status: "active", kind: "preference", content: preferenceContent,
      verification: "The user explicitly requested this format.",
    });
    // Preserve microseconds that a JavaScript Date read would truncate.
    await fixture.client!.query("UPDATE memories SET updated_at = $1::timestamptz WHERE id = $2", ["2026-10-15T04:00:00.123456Z", ordinary.id]);
    const ctx = { principal: member, bot, app: {} as never, conversationId: "chat", depth: 0, background: false, toolSettings: await getSetting("tools"), usage: { pending: [] } } as AgentCtx;
    const entries = memoryTools(ctx);
    const correct = entries.find(entry => entry.name === "correct_memory")!.tool.execute!;
    const controller = new AbortController();
    const args = { toolCallId: "correction", messages: [], context: undefined, abortSignal: controller.signal };
    fixture.embed.mockResolvedValueOnce([[0.5, 0.25]]);

    expect(await correct({ id: ordinary.id, fact: "Lead with a concise executive summary." }, args as never)).toMatchObject({
      corrected: true, status: "corrected", recordType: "ordinary_memory", recallStatus: "semantic",
    });
    expect(fixture.embed).toHaveBeenCalledWith(["Lead with a concise executive summary."], { userId: "member", botId: "bot", conversationId: "chat" }, expect.objectContaining({ abortSignal: controller.signal, usage: ctx.usage }));
    expect(await correct({ id: preference.id, fact: "Use a concise executive summary before the details." }, args as never)).toMatchObject({
      corrected: true, status: "corrected", recordType: "learned_preference",
    });
    expect((await db.select({ content: schema.memories.content, embedding: schema.memories.embedding }).from(schema.memories).where(eq(schema.memories.id, ordinary.id)))[0])
      .toEqual({ content: "Lead with a concise executive summary.", embedding: [0.5, 0.25] });
    expect((await db.select().from(schema.botLearnings).where(eq(schema.botLearnings.id, preference.id)))[0]).toMatchObject({
      userId: "member", botId: "bot", kind: "preference", status: "active", version: 2,
      content: { ...preferenceContent, description: "Use a concise executive summary before the details.", instructions: "Use a concise executive summary before the details.", boundaries: "" },
    });
    expect(await learningHistory(member, preference.id)).toMatchObject([
      { version: 2, content: { description: "Use a concise executive summary before the details.", instructions: "Use a concise executive summary before the details.", boundaries: "" } },
      { version: 1, content: { description: "Use my report layout.", boundaries: "Always use two numbered summary bullets." } },
    ]);
    const recalled = await selectMemories({ userId: "member", botId: "bot" });
    expect(recalled).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ordinary.id, content: "Lead with a concise executive summary." }),
      expect.objectContaining({ id: preference.id, content: expect.stringContaining("Use a concise executive summary before the details.") }),
    ]));
    expect(recalled.find(entry => entry.id === preference.id)?.content).not.toContain("Always use two numbered summary bullets.");

    const [foreignPreference] = await db.insert(schema.botLearnings).values({
      botId: "bot", userId: "boss", topic: "private-layout", kind: "preference", status: "active",
      content: preferenceContent, verification: "Explicit preference.", version: 1,
    }).returning();
    expect(await correct({ id: foreignPreference.id, fact: "Unauthorized edit." }, args as never)).toMatchObject({ status: "not_found", corrected: false });
    expect((await db.select().from(schema.botLearnings).where(eq(schema.botLearnings.id, foreignPreference.id)))[0].content).toEqual(preferenceContent);
  });

  it("keeps the prior approved preference active when a correction is still pending", async () => {
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, "bot"));
    const approved = { ...content, description: "Approved short summaries." };
    const pending = { ...content, description: "Proposed new summary format." };
    const [row] = await db.insert(schema.botLearnings).values({
      botId: "bot", userId: "member", topic: "summary-format", kind: "preference", status: "pending",
      content: pending, verification: "User correction awaiting review.", version: 2,
    }).returning();
    await db.insert(schema.botLearningRevisions).values([
      { learningId: row.id, version: 1, status: "active", kind: "preference", content: approved, verification: "Approved." },
      { learningId: row.id, version: 2, status: "pending", kind: "preference", content: pending, verification: "Pending." },
    ]);
    const entries = memoryTools({ principal: member, bot, conversationId: "chat" } as AgentCtx);
    const correct = entries.find(entry => entry.name === "correct_memory")!.tool.execute!;
    expect(await correct({ id: row.id, fact: "Corrected summary still needs review." }, { toolCallId: "pending", messages: [], context: undefined } as never))
      .toMatchObject({ status: "corrected_pending", corrected: true, recordType: "learned_preference" });
    expect(await learnedPreferences("member", "bot")).toMatchObject([{ content: expect.stringContaining("Approved short summaries.") }]);
    expect(await learningHistory(member, row.id)).toMatchObject([
      { version: 3, content: { description: "Corrected summary still needs review.", instructions: "Corrected summary still needs review." } },
      { version: 2, content: pending },
      { version: 1, content: approved },
    ]);
  });

  it("honors Stop while a learned correction waits for its row lock", async () => {
    const controller = new AbortController();
    let releaseLock!: (value: string) => void;
    const lockBarrier = new Promise<string>(resolve => { releaseLock = resolve; });
    const result = afterLearningMutationLock(lockBarrier, controller.signal);
    controller.abort();
    releaseLock("row locked");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts a stopped correction and rejects a stale embedding after a concurrent memory edit", async () => {
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, "bot"));
    const [row] = await db.insert(schema.memories).values({ userId: "member", botId: "bot", content: "Original memory." }).returning();
    const correct = memoryTools({ principal: member, bot, conversationId: "chat" } as AgentCtx).find(entry => entry.name === "correct_memory")!.tool.execute!;
    const controller = new AbortController(); controller.abort();
    await expect(correct({ id: row.id, fact: "Stopped change." }, { toolCallId: "stopped", messages: [], context: undefined, abortSignal: controller.signal } as never)).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.embed).not.toHaveBeenCalled();
    expect((await db.select({ content: schema.memories.content }).from(schema.memories).where(eq(schema.memories.id, row.id)))[0].content).toBe("Original memory.");

    fixture.embed.mockImplementationOnce(async () => {
      await db.update(schema.memories).set({ content: "Concurrent correction." }).where(eq(schema.memories.id, row.id));
      return [[0.7, 0.3]];
    });
    expect(await correct({ id: row.id, fact: "Stale request." }, { toolCallId: "stale", messages: [], context: undefined } as never))
      .toMatchObject({ corrected: false, status: "conflict", recordType: "ordinary_memory" });
    expect((await db.select({ content: schema.memories.content }).from(schema.memories).where(eq(schema.memories.id, row.id)))[0].content).toBe("Concurrent correction.");
  });

  it("uses recent-recall fallback when embedding a corrected ordinary memory is unavailable", async () => {
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, "bot"));
    const [row] = await db.insert(schema.memories).values({ userId: "member", botId: "bot", content: "Original memory." }).returning();
    fixture.embed.mockRejectedValueOnce(new Error("fixture embedding unavailable"));
    const correct = memoryTools({ principal: member, bot, conversationId: "chat" } as AgentCtx).find(entry => entry.name === "correct_memory")!.tool.execute!;
    expect(await correct({ id: row.id, fact: "Updated detail." }, { toolCallId: "fallback", messages: [], context: undefined } as never))
      .toMatchObject({ corrected: true, recallStatus: "recent_fallback", message: expect.stringContaining("recent-memory recall") });
    expect((await db.select({ content: schema.memories.content, embedding: schema.memories.embedding }).from(schema.memories).where(eq(schema.memories.id, row.id)))[0])
      .toEqual({ content: "Updated detail.", embedding: null });
  });

  it("reports forget no-ops honestly, avoids repeating failed IDs, and archives only its owner's active bot preference", async () => {
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, "bot"));
    const ctx = { principal: member, bot, conversationId: "chat" } as AgentCtx;
    const forget = memoryTools(ctx).find(entry => entry.name === "forget")!.tool.execute!;
    const args = { toolCallId: "forget", messages: [], context: undefined };
    expect(await forget({ id: "missing-record" }, args as never)).toMatchObject({ status: "not_found", deleted: false });
    expect(await forget({ id: "missing-record" }, args as never)).toMatchObject({ status: "repeat_noop", deleted: false });

    const preferenceContent = { ...content, description: "Prefers short updates." };
    const [preference] = await db.insert(schema.botLearnings).values({
      botId: "bot", userId: "member", topic: "short-updates", kind: "preference", status: "active",
      content: preferenceContent, verification: "Explicit preference.", version: 1,
    }).returning();
    await db.insert(schema.botLearningRevisions).values({
      learningId: preference.id, version: 1, status: "active", kind: "preference", content: preferenceContent,
      verification: "Explicit preference.",
    });
    expect(await forget({ id: preference.id }, args as never)).toMatchObject({
      status: "forgotten", deleted: true, recordType: "learned_preference",
    });
    expect((await db.select().from(schema.botLearnings).where(eq(schema.botLearnings.id, preference.id)))[0].status).toBe("archived");
    expect(await db.select().from(schema.botLearningRevisions).where(eq(schema.botLearningRevisions.learningId, preference.id)))
      .toHaveLength(2);
  });

  it("keeps organizational policies pending until the bot owner approves", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind: "policy", instructions: "Proposed team procedure: escalate missing critical updates to the duty manager." })] } });
    await reviewNativeRun("run");
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(0);
    expect(await learningViews(member, "bot")).toHaveLength(0);
    const [proposal] = await learningViews(owner, "bot");
    await expect(changeLearning(member, proposal.id, 1, { status: "active" })).rejects.toMatchObject({ status: 403 });
    await changeLearning(owner, proposal.id, 1, { status: "active" });
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(1);
  });

  it.each(["member@fixture.invalid", "Helpdesk Person", "private-endpoint-123", "KY-FINANCE-001"])("refuses shared content containing private data: %s", async secret => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ instructions: `Inspect ${secret} before reporting.` })] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(await learningViews(boss, "bot")).toHaveLength(0);
  });

  it("requires successful evidence for shared procedures", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ evidenceCallIds: ["invented-call"] })] } });
    await reviewNativeRun("run");
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(0);
    expect((await learningViews(member, "bot"))[0].scope).toBe("user");
  });

  it("includes recovered errors as pitfalls without treating failed calls as verification", async () => {
    await db.update(schema.messages).set({ parts: [
      toolPart({ toolCallId: "failed-call", state: "output-error", errorText: "Unsupported severity CRITICAL; use critical." }), toolPart(),
    ] }).where(eq(schema.messages.id, "reply"));
    expect(await reviewNativeRun("run")).toBe(1);
    const prompt = JSON.parse(fixture.generate.mock.calls[0][0].prompt);
    expect(prompt.failedOrDeniedTools[0]).toMatchObject({ callId: "failed-call", state: "output-error" });
    expect(prompt.successfulTools.map((tool: { callId: string }) => tool.callId)).toEqual(["update-call"]);
  });

  it("commits a source run only once and retains its provenance privately", async () => {
    expect(await reviewNativeRun("run")).toBe(1);
    expect(await reviewNativeRun("run")).toBe(0);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    const history = await db.select().from(schema.botLearningRevisions);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ sourceRunId: "run", sourceConversationId: "chat" });
    expect(JSON.stringify(await learningHistory(owner, history[0].learningId))).not.toContain("sourceRunId");
  });

  it("supports corrections, version conflict protection, rollback and recoverable archives", async () => {
    await reviewNativeRun("run");
    const [row] = await learningViews(owner, "bot");
    await changeLearning(owner, row.id, 1, { content: { ...content, instructions: "Check every page before reporting. Never install." } });
    await expect(changeLearning(owner, row.id, 1, { status: "archived" })).rejects.toMatchObject({ status: 409 });
    await changeLearning(owner, row.id, 2, { restoreVersion: 1 });
    expect((await learnedSkillsForBot("bot", "boss"))[0].instructions).toBe(content.instructions);
    await changeLearning(owner, row.id, 3, { status: "archived" });
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(0);
    await changeLearning(owner, row.id, 4, { status: "active" });
    expect((await learnedSkillsForBot("bot", "boss"))[0].version).toBe(5);
  });

  it("does not overwrite a newer revision if a correction lands during review", async () => {
    await reviewNativeRun("run");
    const [row] = await learningViews(owner, "bot");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockImplementation(async () => {
      // Simulate the owner's concurrent committed correction through the fixture's single PGlite connection.
      await fixture.query!.update(schema.botLearnings).set({ version: 2, content: { ...content, instructions: "Owner correction. Check all pages." } }).where(eq(schema.botLearnings.id, row.id));
      return { output: { lessons: [lesson({ baseVersion: 1, instructions: "Stale automatic rewrite." })] } };
    });
    expect(await reviewNativeRun("run")).toBe(0);
    expect((await learnedSkillsForBot("bot", "boss"))[0].instructions).toContain("Owner correction");
  });

  it("does not resurrect archived topics or silently revise an approved policy", async () => {
    await reviewNativeRun("run");
    const [row] = await learningViews(owner, "bot");
    await changeLearning(owner, row.id, 1, { status: "archived" });
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ baseVersion: 2, instructions: "An unwanted automatic rewrite." })] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect((await learningViews(owner, "bot"))[0].status).toBe("archived");
    await changeLearning(owner, row.id, 2, { status: "active" });
    await db.update(schema.botLearnings).set({ kind: "policy" }).where(eq(schema.botLearnings.id, row.id));
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ baseVersion: 3, instructions: "A changed organizational procedure." })] } });
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot"))[0].status).toBe("pending");
    expect((await learnedSkillsForBot("bot", "boss"))[0].instructions).toBe(content.instructions);
  });

  it("does not retain a credential in either learning scope", async () => {
    await db.update(schema.messages).set({ parts: [toolPart({ output: { apiKey: "fixture-secret-credential", hasMore: false } })] }).where(eq(schema.messages.id, "reply"));
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ scope: "user", instructions: "Use fixture-secret-credential in the request." })] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(await learningViews(member, "bot")).toHaveLength(0);
  });

  it("skips personal-plan background billing when no company utility model is configured", async () => {
    await db.update(schema.aiApps).set({ credentialMode: "user" });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled();
    expect((await db.select().from(schema.botLearningReviews))[0].completedAt).not.toBeNull();
  });

  it("records updates to an existing topic as a new revision rather than another skill", async () => {
    await reviewNativeRun("run");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ baseVersion: 1, instructions: "A verified procedure including the pagination fix. Never install during a check." })] } });
    expect(await reviewNativeRun("run")).toBe(1);
    expect(await db.select().from(schema.botLearnings)).toHaveLength(1);
    expect(await db.select().from(schema.botLearningRevisions)).toHaveLength(2);
    expect((await learnedSkillsForBot("bot", "boss"))[0].version).toBe(2);
  });

  it("keeps readable slugs distinct across scopes and stable through edits", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson(), lesson({ scope: "user" })] } });
    await reviewNativeRun("run");
    const before = await learnedSkillsForBot("bot", "member");
    expect(before.map(s => s.slug).sort()).toEqual(["learned-personal-critical-update-check", "learned-shared-critical-update-check"]);
    const shared = before.find(s => s.ownerId === "")!;
    await changeLearning(owner, shared.id, 1, { content: { ...content, name: "New display name" } });
    const after = (await learnedSkillsForBot("bot", "member")).find(s => s.id === shared.id)!;
    expect(after.slug).toBe(shared.slug);
    expect(after.name).toBe("New display name");
  });

  it("resolves persisted learned-ID routine prompts and tool calls without changing readable catalog names", async () => {
    await db.insert(schema.botLearnings).values({ id: "legacy_ID-", botId: "bot", topic: "legacy-check", kind: "procedure", content, verification: "Observed" });
    const alias = "learned-legacy_ID-";
    await db.insert(schema.routines).values({ ownerId: "owner", botId: "bot", name: "Legacy", prompt: `/${alias} Check group updates`, triggerType: "cron" });
    const [routine] = await db.select().from(schema.routines);
    const available = await learnedSkillsForBot("bot", "owner");
    const invoked = slashInvokedSkill(available, routine.prompt)!;
    expect(invoked.slug).toBe("learned-shared-legacy-check");
    expect(invoked.aliases).toEqual([alias]);
    expect(slashInvokedSkill(available, `/${invoked.slug}, Check`)).toBe(invoked);
    const entry = skillTool({ bot: { id: "bot" }, principal: owner } as never, available)!;
    expect((entry.tool.inputSchema as unknown as { safeParse: (input: unknown) => { success: boolean } }).safeParse({ slug: alias }).success).toBe(true);
    const result = await entry.tool.execute!({ slug: alias }, { toolCallId: "legacy-load", messages: [], context: {} });
    expect(result).toMatchObject({ skillId: invoked.id, version: 1 });
    expect((await learningViews(owner, "bot"))[0].useCount).toBe(1);
    expect((await db.select().from(schema.routines))[0].prompt).toBe(routine.prompt);
    const authored = { ...invoked, id: "manual", aliases: undefined, slug: alias };
    expect(findSkill([invoked, authored], alias)?.id).toBe("manual");
    await changeLearning(owner, invoked.id, 1, { status: "archived" });
    expect(slashInvokedSkill(await learnedSkillsForBot("bot", "owner"), routine.prompt)).toBeUndefined();
  });

  it("keeps legacy aliases inside the user's authorized learning scope", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ scope: "user" })] } });
    await reviewNativeRun("run");
    const [privateSkill] = await learnedSkillsForBot("bot", "member");
    const alias = privateSkill.aliases![0];
    expect(slashInvokedSkill(await learnedSkillsForBot("bot", "member"), `/${alias} Check`)).toBeDefined();
    expect(findSkill(await learnedSkillsForBot("bot", "boss"), alias)).toBeUndefined();
  });

  it("keeps approved preference Memory during a pending policy and restores its kind on rejection", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind: "preference", scope: "user", topic: "report-format", evidenceCallIds: [], instructions: "Lead with a short report summary." })] } });
    await reviewNativeRun("run");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind: "policy", scope: "user", topic: "report-format", baseVersion: 1, evidenceCallIds: [], instructions: "Proposed team mandate: use a different report format." })] } });
    await reviewNativeRun("run");
    const [proposal] = await learningViews(member, "bot");
    expect(proposal).toMatchObject({ kind: "policy", status: "pending" });
    expect((await learnedPreferences("member", "bot", 1))[0].content).toContain("Lead with a short report summary.");
    expect(await learnedSkillsForBot("bot", "member")).toHaveLength(0);
    expect(await learnedPreferences("boss", "bot")).toHaveLength(0);
    await changeLearning(member, proposal.id, proposal.version, { status: "archived" });
    expect((await learningViews(member, "bot"))[0]).toMatchObject({ kind: "preference", status: "active", version: 3 });
    expect((await learnedPreferences("member", "bot"))[0].content).toContain("Lead with a short report summary.");
    expect((await db.select().from(schema.botLearningRevisions)).map(row => row.kind)).toEqual(["preference", "policy", "preference"]);
  });

  it("moves approved policies out of Memory and restores the preference kind with its historical revision", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind: "preference", scope: "user", topic: "report-format", evidenceCallIds: [], instructions: "Lead with a short report summary." })] } });
    await reviewNativeRun("run");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind: "policy", scope: "user", topic: "report-format", baseVersion: 1, evidenceCallIds: [], instructions: "A reviewed reporting policy." })] } });
    await reviewNativeRun("run");
    const [proposal] = await learningViews(member, "bot");
    await changeLearning(member, proposal.id, 2, { status: "active" });
    expect(await learnedPreferences("member", "bot")).toHaveLength(0);
    expect((await learnedSkillsForBot("bot", "member"))[0].instructions).toBe("A reviewed reporting policy.");
    await changeLearning(member, proposal.id, 3, { restoreVersion: 1 });
    expect((await learningViews(member, "bot"))[0]).toMatchObject({ kind: "preference", status: "active" });
    expect(await learnedSkillsForBot("bot", "member")).toHaveLength(0);
    expect((await learnedPreferences("member", "bot"))[0].content).toContain("Lead with a short report summary.");
  });

  it("upgrades existing #59 revision histories with their retained classification", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const legacy = new PGlite();
    try {
      await legacy.waitReady;
      for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql") && f < "0037").sort()) {
        await legacy.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
      }
      await legacy.exec("INSERT INTO users (id, upn, name, auth_source) VALUES ('legacy', 'legacy@fixture.invalid', 'Legacy', 'ldap'); INSERT INTO bots (id, owner_id, name) VALUES ('legacy-bot', 'legacy', 'Legacy');");
      for (const kind of ["preference", "procedure", "policy"]) {
        await legacy.query("INSERT INTO bot_learnings (id, bot_id, user_id, topic, kind, content, verification) VALUES ($1, 'legacy-bot', 'legacy', $1, $1, $2::jsonb, 'Observed')", [kind, JSON.stringify(content)]);
        await legacy.query("INSERT INTO bot_learning_revisions (id, learning_id, version, status, content, verification) VALUES ($1, $1, 1, 'active', $2::jsonb, 'Observed')", [kind, JSON.stringify(content)]);
      }
      await legacy.exec(readFileSync("src/db/migrations/0037_learning_usage.sql", "utf8"));
      expect((await legacy.query<{ kind: string }>("SELECT kind FROM bot_learning_revisions ORDER BY kind")).rows.map(row => row.kind)).toEqual(["policy", "preference", "procedure"]);
      await expect(legacy.exec("UPDATE bot_learning_revisions SET kind = 'unknown'")).rejects.toThrow();
      await expect(legacy.exec("UPDATE bot_learning_revisions SET kind = NULL")).rejects.toThrow();
    } finally { await legacy.close(); }
  });

  it("saves nothing when a routine repeat has no new learning", async () => {
    await reviewNativeRun("run");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(await db.select().from(schema.botLearnings)).toHaveLength(1);
    expect(await db.select().from(schema.botLearningRevisions)).toHaveLength(1);
  });

  it("rejects the same content under a different title and topic", async () => {
    await reviewNativeRun("run");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ topic: "another-update-check", name: "Another title" })] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(await db.select().from(schema.botLearnings)).toHaveLength(1);
  });

  it("does not create a revision for a title-only rewrite", async () => {
    await reviewNativeRun("run");
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ baseVersion: 1, name: "A cosmetic replacement title" })] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(await db.select().from(schema.botLearningRevisions)).toHaveLength(1);
    expect((await learnedSkillsForBot("bot", "boss"))[0].name).toBe(content.name);
  });

  it("stages learned writes when the approval gate is enabled", async () => {
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: [], learningRequireApproval: true } });
    await reviewNativeRun("run");
    expect(await learnedSkillsForBot("bot", "member")).toHaveLength(0);
    const [proposal] = await learningViews(owner, "bot");
    expect(proposal.status).toBe("pending");
    await changeLearning(owner, proposal.id, 1, { status: "active" });
    expect(await learnedSkillsForBot("bot", "member")).toHaveLength(1);
  });

  it("keeps the approved skill usable during a pending change and after rejection", async () => {
    await reviewNativeRun("run");
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: [], learningRequireApproval: true } });
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ baseVersion: 1, instructions: "Proposed new verified steps." })] } });
    await reviewNativeRun("run");
    const [old] = await learnedSkillsForBot("bot", "boss");
    expect(old.instructions).toBe(content.instructions);
    expect(old.version).toBe(1);
    expect((await learningViews(boss, "bot"))[0].content.instructions).toBe(content.instructions);
    const [proposal] = await learningViews(owner, "bot");
    expect(proposal.status).toBe("pending");
    await changeLearning(owner, proposal.id, 2, { status: "archived" });
    expect((await learnedSkillsForBot("bot", "boss"))[0].instructions).toBe(content.instructions);
  });

  it("tracks use without creating revisions and protects pinned content from automatic changes", async () => {
    await reviewNativeRun("run");
    const [saved] = await learnedSkillsForBot("bot", "boss");
    await recordLearnedSkillUse("bot", "boss", saved.id);
    expect((await learningViews(owner, "bot"))[0].useCount).toBe(1);
    expect(await db.select().from(schema.botLearningRevisions)).toHaveLength(1);
    await changeLearning(owner, saved.id, 1, { pinned: true });
    expect((await learnedSkillsForBot("bot", "boss"))[0].pinned).toBe(true);
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ baseVersion: 2, instructions: "Changed automatically." })] } });
    expect(await reviewNativeRun("run")).toBe(0);
    expect((await learnedSkillsForBot("bot", "boss"))[0].instructions).toBe(content.instructions);
  });

  it("archives unused procedures reversibly, preserving recently used and pinned skills", async () => {
    await reviewNativeRun("run");
    const [saved] = await db.select().from(schema.botLearnings);
    const old = new Date(Date.now() - 40 * 86400000);
    await db.update(schema.botLearnings).set({ createdAt: old, updatedAt: old });
    expect((await learningViews(owner, "bot"))[0].stale).toBe(true);
    await db.update(schema.botLearnings).set({ pinned: true });
    expect(await curateLearnedSkills()).toBe(0);
    await db.update(schema.botLearnings).set({ pinned: false, lastUsedAt: new Date() });
    expect(await curateLearnedSkills()).toBe(0);
    await db.update(schema.botLearnings).set({ lastUsedAt: old });
    expect(await curateLearnedSkills()).toBe(1);
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(0);
    await changeLearning(owner, saved.id, 2, { status: "active" });
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(1);
  });

  it("does not archive preferences, policies, routine references, or skills while a turn is running", async () => {
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson(), lesson({ kind: "preference", scope: "user", topic: "format" }), lesson({ kind: "policy", topic: "policy" })] } });
    await reviewNativeRun("run");
    const old = new Date(Date.now() - 40 * 86400000);
    await db.update(schema.botLearnings).set({ createdAt: old, updatedAt: old });
    await db.update(schema.agentRuns).set({ status: "running" });
    expect(await curateLearnedSkills()).toBe(0);
    await db.update(schema.agentRuns).set({ status: "succeeded" });
    await db.insert(schema.routines).values({ ownerId: "owner", botId: "bot", name: "Check", prompt: "/learned-shared-critical-update-check", triggerType: "cron" });
    expect(await curateLearnedSkills()).toBe(0);
    await db.delete(schema.routines);
    expect(await curateLearnedSkills()).toBe(1);
    expect(await learnedPreferences("member", "bot")).toHaveLength(1);
    expect((await learningViews(owner, "bot")).find(row => row.kind === "policy")?.status).toBe("pending");
  });

  it("consolidates only identical procedures when explicitly enabled, without crossing user scopes", async () => {
    await reviewNativeRun("run");
    await db.insert(schema.botLearnings).values([
      { id: "duplicate", botId: "bot", topic: "duplicate", kind: "procedure", content, verification: "Observed" },
      { id: "private", botId: "bot", userId: "member", topic: "private", kind: "procedure", content, verification: "Observed" },
    ]);
    expect(await curateLearnedSkills()).toBe(0);
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: [], learningConsolidationEnabled: true } });
    expect(await curateLearnedSkills()).toBe(1);
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(1);
    expect(await learnedSkillsForBot("bot", "member")).toHaveLength(2);
    expect((await db.select().from(schema.botLearnings).where(eq(schema.botLearnings.id, "duplicate")))[0].status).toBe("archived");
  });

  it("does not bypass the write approval gate during maintenance", async () => {
    await reviewNativeRun("run");
    const old = new Date(Date.now() - 40 * 86400000);
    await db.update(schema.botLearnings).set({ createdAt: old, updatedAt: old });
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: [], learningRequireApproval: true } });
    expect(await curateLearnedSkills()).toBe(0);
  });

  it("respects the maintenance opt-out", async () => {
    await reviewNativeRun("run");
    const old = new Date(Date.now() - 40 * 86400000);
    await db.update(schema.botLearnings).set({ createdAt: old, updatedAt: old });
    await db.insert(schema.settings).values({ key: "tools", value: { disabledTools: [], learningMaintenanceEnabled: false } });
    expect(await curateLearnedSkills()).toBe(0);
  });

  it("rechecks access and user opt-out after model generation", async () => {
    fixture.generate.mockImplementation(async () => {
      await fixture.query!.update(schema.users).set({ prefs: { learningEnabled: false } }).where(eq(schema.users.id, "member"));
      return { output: { lessons: [lesson()] } };
    });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(await learnedSkillsForBot("bot", "boss")).toHaveLength(0);
  });

  it.each(["failed", "cancelled", "waiting", "waiting_tasks"])("never learns from a %s run", async status => {
    await db.update(schema.agentRuns).set({ status: status as "failed" }).where(eq(schema.agentRuns.id, "run"));
    expect(await reviewNativeRun("run")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it.each(["service", "hermes", "memory-off", "learning-off", "org-off", "disabled-bot", "revoked-access"])("honors %s", async reason => {
    if (reason === "service") await db.update(schema.bots).set({ executionMode: "service" });
    if (reason === "hermes") await db.update(schema.aiApps).set({ provider: "hermes" });
    if (reason === "memory-off" || reason === "learning-off") await db.update(schema.users).set({ prefs: reason === "memory-off" ? { memoryEnabled: false } : { learningEnabled: false } }).where(eq(schema.users.id, "member"));
    if (reason === "org-off") await db.insert(schema.settings).values({ key: "tools", value: { learningEnabled: false } });
    if (reason === "disabled-bot") await db.update(schema.bots).set({ enabled: false });
    if (reason === "revoked-access") await db.update(schema.bots).set({ visibility: "private" });
    expect(await reviewNativeRun("run")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("records the review outbox before enqueue and recovers an interrupted enqueue", async () => {
    fixture.enqueue.mockResolvedValueOnce(null as never);
    await scheduleLearningReview("run");
    expect(await db.select().from(schema.botLearningReviews)).toHaveLength(1);
    await recoverLearningReviews();
    expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  });

  it("caps review model attempts across queue retries and recovery", async () => {
    fixture.generate.mockRejectedValue(new Error("Synthetic utility model failure"));
    for (let i = 0; i < 3; i++) await expect(reviewNativeRun("run")).rejects.toThrow("Synthetic utility model failure");
    expect(await reviewNativeRun("run")).toBe(0);
    await recoverLearningReviews();
    expect(fixture.generate).toHaveBeenCalledTimes(3);
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect((await db.select().from(schema.botLearningReviews))[0].attempts).toBe(3);
  });

  it("enforces unique topics per scope and refuses a shared preference at the database boundary", async () => {
    await reviewNativeRun("run");
    await expect(db.insert(schema.botLearnings).values({ botId: "bot", topic: "critical-update-check", kind: "procedure", content, verification: "Fixture" })).rejects.toThrow();
    await expect(db.insert(schema.botLearnings).values({ botId: "bot", topic: "personal", kind: "preference", content, verification: "Fixture" })).rejects.toThrow();
    await db.insert(schema.botLearnings).values({ botId: "bot", userId: "member", topic: "critical-update-check", kind: "procedure", content, verification: "Fixture" });
    expect(await db.select().from(schema.botLearnings)).toHaveLength(2);
  });
});

describe("learning evidence policy", () => {
  it.each([
    { state: "approval-requested" }, { state: "output-denied" }, { state: "output-error" }, { preliminary: true },
    { output: { isError: true, content: [{ type: "text", text: "Fixture connector failure" }] } },
    { output: { error: "Permission denied" } }, { output: { success: false } }, { output: { status: "queued" } },
  ])("does not treat unfinished, denied or failed tools as verification: %j", over => {
    expect(successfulToolEvidence({ id: "m", role: "assistant", parts: [toolPart(over)] } as PortalUIMessage)).toEqual([]);
  });
  it("preserves successful MCP content with isError false", () => {
    expect(successfulToolEvidence({ id: "m", role: "assistant", parts: [toolPart({ output: { isError: false, content: [{ type: "text", text: "Fixture success" }] } })] } as PortalUIMessage)).toHaveLength(1);
  });
  it("never promotes a personal preference into shared learning", () => {
    expect(lessonDisposition(lesson({ kind: "preference" }), new Set(["update-call"]))).toEqual({ scope: "user", status: "active" });
  });
});
