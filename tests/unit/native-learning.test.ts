import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { ReviewedLesson } from "@/lib/agent/learning/types";
import type { Tx } from "@/db";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, query: null as Tx | null, generate: vi.fn(), enqueue: vi.fn(async () => "job") }));
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
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), resolveModel: async () => ({ model: {} }) }));
vi.mock("@/lib/hermes-team/learning", async original => {
  const learning = await original<typeof import("@/lib/hermes-team/learning")>();
  return { ...learning, withNonTeamLearning: <T>(id: string, skip: T, work: (q: Tx) => Promise<T>, onSkip?: (q: Tx) => Promise<void>) =>
    learning.withNonTeamLearning(id, skip, async q => { fixture.query = q; try { return await work(q); } finally { fixture.query = null; } }, onSkip) };
});

import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { changeLearning, learnedSkillsForBot, learnedPreferences, recordLearnedSkillUse, learningHistory, learningViews } from "@/lib/agent/learning/store";
import { reviewNativeRun, scheduleLearningReview, recoverLearningReviews } from "@/lib/agent/learning/review";
import { successfulToolEvidence, lessonDisposition } from "@/lib/agent/learning/policy";
import { curateLearnedSkills } from "@/lib/agent/learning/curator";
import { selectMemories } from "@/lib/agent/memory";
import { renderSkill } from "@/lib/agent/tools/skills";

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
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
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
    { output: { error: "Permission denied" } }, { output: { success: false } }, { output: { status: "queued" } },
  ])("does not treat unfinished, denied or failed tools as verification: %j", over => {
    expect(successfulToolEvidence({ id: "m", role: "assistant", parts: [toolPart(over)] } as PortalUIMessage)).toEqual([]);
  });
  it("never promotes a personal preference into shared learning", () => {
    expect(lessonDisposition(lesson({ kind: "preference" }), new Set(["update-call"]))).toEqual({ scope: "user", status: "active" });
  });
});
