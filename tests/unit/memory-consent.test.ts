import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { Tx } from "@/db";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, query: null as Tx | null, generate: vi.fn(), embed: vi.fn(async () => null) }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client ??= new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: fixture.generate }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), resolveModel: vi.fn(async () => ({ model: {} })), embedTexts: fixture.embed }));
vi.mock("@/lib/jobs", () => ({ QUEUES: { learningReview: "learning.review" }, enqueue: vi.fn(async () => "fixture") }));
vi.mock("@/lib/hermes-team/learning", async original => {
  const learning = await original<typeof import("@/lib/hermes-team/learning")>();
  return { ...learning, withNonTeamLearning: <T>(id: string, skip: T, work: (q: Tx) => Promise<T>, onSkip?: (q: Tx) => Promise<void>) =>
    learning.withNonTeamLearning(id, skip, async q => { fixture.query = q; try { return await work(q); } finally { fixture.query = null; } }, onSkip) };
});

import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { applyApprovalDecisions } from "@/lib/agent/approval-merge";
import { extractMemoriesFromConversation, selectMemories } from "@/lib/agent/memory";
import { reviewNativeRun } from "@/lib/agent/learning/review";
import { changeLearning, learnedSkillsForBot, learningViews } from "@/lib/agent/learning/store";
import { buildToolset } from "@/lib/agent/toolset";
import type { AgentCtx } from "@/lib/agent/types";
import { getSetting } from "@/lib/settings";

let owner: Principal;
const fact = "Uses synthetic footer marker COPPER-MOON-78 for reports.";
const content = { name: "Synthetic footer", description: "Preferred report footer.", instructions: fact, expectedOutput: "A report.", boundaries: "Synthetic fixture only." };
const lesson = (over: object = {}) => ({ ...content, topic: "report-footer", kind: "preference", scope: "user", baseVersion: 0, evidenceCallIds: [], verification: "The user requested a footer.", ...over });
const remember = (over: object = {}) => ({ type: "tool-remember", toolCallId: "remember-call", state: "approval-requested", input: { fact, shared: false }, approval: { id: "approval" }, ...over });

async function deny() {
  const parts = applyApprovalDecisions([remember()], new Map([["approval", { approved: false }]])).parts;
  await db.update(schema.messages).set({ parts }).where(eq(schema.messages.id, "reply"));
}

async function allowAutomaticExtraction() {
  await db.update(schema.botTools).set({ approval: "auto" });
  await db.update(schema.messages).set({ parts: [{ type: "text", text: "Synthetic reply." }] }).where(eq(schema.messages.id, "reply"));
}

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(name => name.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 45000);
beforeEach(async () => {
  vi.clearAllMocks(); fixture.query = null; fixture.embed.mockResolvedValue(null);
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values(["owner", "other"].map(id => ({ id, name: id, upn: `${id}@fixture.invalid`, authSource: "local" as const, identityRealm: "local" as const })));
  owner = (await loadPrincipal("owner"))!;
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic utility", provider: "openai", model: "fixture", supportsTools: true, isPublic: true });
  await db.insert(schema.settings).values({ key: "tools", value: { utilityAppId: "model" } });
  await db.insert(schema.bots).values(["bot", "other-bot"].map(id => ({ id, name: id, ownerId: "owner", appId: "model", visibility: "org" as const })));
  await db.insert(schema.botTools).values({ botId: "bot", toolKey: "memory", approval: "ask" });
  await db.insert(schema.conversations).values({ id: "chat", userId: "owner", botId: "bot", appId: "model", currentLeafId: "reply" });
  await db.insert(schema.messages).values([
    { id: "prompt", conversationId: "chat", role: "user", parts: [{ type: "text", text: `Remember: ${fact}` }], createdAt: new Date(Date.now() - 300000) },
    { id: "reply", conversationId: "chat", parentId: "prompt", role: "assistant", parts: [remember()], createdAt: new Date(Date.now() - 299000) },
  ]);
  await db.insert(schema.agentRuns).values({ id: "run", userId: "owner", conversationId: "chat", botId: "bot", appId: "model", messageId: "reply", parentMessageId: "prompt", status: "succeeded" });
  await db.insert(schema.botLearningReviews).values({ runId: "run" });
  fixture.generate.mockResolvedValue({ output: { memories: [{ content: fact, shared: true }], lessons: [lesson()] } });
});
afterAll(async () => { await fixture.client!.close(); });

describe("memory consent with migrated synthetic persistence", () => {
  it("keeps a denied fact out of ordinary memory and new-chat recall after processing, reload and proposal archive", async () => {
    await db.update(schema.settings).set({ value: { utilityAppId: "model", learningRequireApproval: true } }).where(eq(schema.settings.key, "tools"));
    await deny();
    expect(await reviewNativeRun("run")).toBe(1);
    const [proposal] = await learningViews(owner, "bot");
    expect(proposal.status).toBe("pending");
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(await db.select().from(schema.memories)).toEqual([]);
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
    await changeLearning(owner, proposal.id, proposal.version, { status: "archived" });
    await db.insert(schema.conversations).values({ id: "new-chat", userId: "owner", botId: "bot", appId: "model" });
    // Recreate module/query handles while retaining the database, as on a worker restart/reload.
    vi.resetModules();
    const reloaded = await import("@/lib/agent/memory");
    expect(await reloaded.extractMemoriesFromConversation("chat")).toBe(0);
    expect(await reloaded.selectMemories({ userId: "owner", botId: "bot", conversationId: "new-chat", query: "What report footer did I save?" })).toEqual([]);
    expect((await learningViews(owner, "bot"))[0].status).toBe("archived");
    expect(await learnedSkillsForBot("bot", "owner")).toEqual([]);
    expect(await selectMemories({ userId: "owner", botId: "other-bot" })).toEqual([]);
    expect(await selectMemories({ userId: "other", botId: "bot" })).toEqual([]);
  });

  it("cannot activate a denied fact through learning when global learning approval is off", async () => {
    await deny();
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot"))[0].status).toBe("pending");
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
  });

  it.each([
    remember(),
    remember({ state: "approval-responded", approval: { id: "approval", approved: false } }),
    remember({ state: "output-denied" }),
    remember({ type: "dynamic-tool", toolName: "remember", state: "output-denied" }),
    remember({ state: "output-available", approval: { id: "approval", approved: false }, output: { saved: true } }),
  ])("keeps pending/denied server state inert even with automatic memory and grants: %j", async part => {
    await db.update(schema.botTools).set({ approval: "auto" });
    await db.insert(schema.toolGrants).values({ userId: "owner", botId: "bot", toolName: "remember" });
    await db.update(schema.messages).set({ parts: [part] }).where(eq(schema.messages.id, "reply"));
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.embed).not.toHaveBeenCalled();
    // A paraphrase classified as a procedure must not carry the denied preference into active skills.
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind: "procedure", instructions: `While drafting any report, apply this reusable method: ${fact}` })] } });
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot"))[0].status).toBe("pending");
    expect(await learnedSkillsForBot("bot", "owner")).toEqual([]);
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
  });

  it.each(["preference", "procedure"])("respects Ask me first for a learned %s independently of learning approval or a remember grant", async kind => {
    await db.update(schema.messages).set({ parts: [{ type: "text", text: "Synthetic reply." }] }).where(eq(schema.messages.id, "reply"));
    await db.insert(schema.toolGrants).values({ userId: "owner", botId: "bot", toolName: "remember" });
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.embed).not.toHaveBeenCalled();
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ kind })] } });
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot"))[0].status).toBe("pending");
    expect(await learnedSkillsForBot("bot", "owner")).toEqual([]);
  });

  it.each([
    { enforcedApproval: ["memory"] }, { enforcedApproval: ["remember"] },
    { disabledTools: ["memory"] }, { learningRequireApproval: true },
  ])("does not bypass organization consent policy: %j", async policy => {
    await allowAutomaticExtraction();
    await db.update(schema.settings).set({ value: { utilityAppId: "model", ...policy } }).where(eq(schema.settings.key, "tools"));
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.embed).not.toHaveBeenCalled();
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot"))[0].status).toBe("pending");
  });

  it.each(["generation", "embedding"])("discards delayed extraction when a denial arrives during %s", async phase => {
    await allowAutomaticExtraction();
    const denyInFlight = async () => fixture.query!.update(schema.messages).set({ parts: [remember({ state: "output-denied" })] }).where(eq(schema.messages.id, "reply"));
    if (phase === "generation") fixture.generate.mockImplementation(async () => { await denyInFlight(); return { output: { memories: [{ content: fact, shared: true }] } }; });
    else fixture.embed.mockImplementation(async () => { await denyInFlight(); return null; });
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.memories)).toEqual([]);
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
  });

  it.each(["memory-policy", "user-opt-out"])("discards generation after an in-flight %s change", async policy => {
    await allowAutomaticExtraction();
    fixture.generate.mockImplementation(async () => {
      if (policy === "memory-policy") await fixture.query!.update(schema.settings).set({ value: { utilityAppId: "model", enforcedApproval: ["memory"] } }).where(eq(schema.settings.key, "tools"));
      else await fixture.query!.update(schema.users).set({ prefs: { memoryEnabled: false } }).where(eq(schema.users.id, "owner"));
      return { output: { memories: [{ content: fact, shared: true }] } };
    });
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(fixture.embed).not.toHaveBeenCalled();
    expect(await db.select().from(schema.memories)).toEqual([]);
  });

  it("requires approval if a denial arrives while a learning review is generating", async () => {
    await allowAutomaticExtraction();
    fixture.generate.mockImplementation(async () => {
      await fixture.query!.update(schema.messages).set({ parts: [remember({ state: "output-denied" })] }).where(eq(schema.messages.id, "reply"));
      return { output: { lessons: [lesson()] } };
    });
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot"))[0].status).toBe("pending");
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
  });

  it("retains denial outside the recent transcript, on an inactive branch, across repeated requests and archived synonyms", async () => {
    await deny();
    await db.update(schema.botTools).set({ approval: "auto" });
    for (let i = 0; i < 25; i++) await db.insert(schema.messages).values({
      id: `later-${i}`, parentId: i ? `later-${i - 1}` : "prompt", conversationId: "chat", role: "user",
      parts: [{ type: "text", text: `Remember again: ${fact}` }], createdAt: new Date(Date.now() - 100000 + i * 1000),
    });
    await db.insert(schema.messages).values({ id: "later-reply", parentId: "later-24", conversationId: "chat", role: "assistant", parts: [{ type: "text", text: "Synthetic later reply." }] });
    await db.update(schema.conversations).set({ currentLeafId: "later-reply", memoryProcessedAt: new Date(Date.now() - 150000) });
    await db.update(schema.agentRuns).set({ messageId: "later-reply", parentMessageId: "later-24" });
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(await reviewNativeRun("run")).toBe(1);
    const [proposal] = await learningViews(owner, "bot");
    await changeLearning(owner, proposal.id, proposal.version, { status: "archived" });
    await db.update(schema.botLearningReviews).set({ completedAt: null });
    fixture.generate.mockResolvedValue({ output: { lessons: [lesson({ topic: "footer-synonym", description: "Alternate synthetic description.", instructions: `Reports end with the unique marker from this preference: ${fact}` })] } });
    expect(await reviewNativeRun("run")).toBe(1);
    expect((await learningViews(owner, "bot")).map(row => row.status).sort()).toEqual(["archived", "pending"]);
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(await db.select().from(schema.memories)).toEqual([]);
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
  });

  it("preserves consented automatic extraction, processed-turn idempotency and owner/bot recall scope", async () => {
    await allowAutomaticExtraction();
    fixture.generate.mockResolvedValue({ output: { memories: [{ content: fact, shared: false }] } });
    expect(await extractMemoriesFromConversation("chat")).toBe(1);
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(fixture.generate).toHaveBeenCalledTimes(1);
    expect(await selectMemories({ userId: "owner", botId: "bot", conversationId: "new-chat" })).toMatchObject([{ content: fact }]);
    expect(await selectMemories({ userId: "other", botId: "bot" })).toEqual([]);
    expect(await selectMemories({ userId: "owner", botId: "other-bot" })).toEqual([]);
  });

  it("keeps foreground Ask me first and an explicitly approved remember call working", async () => {
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, "bot"));
    const [app] = await db.select().from(schema.aiApps);
    const ctx = { principal: owner, bot, app, conversationId: "chat", depth: 0, background: false, toolSettings: await getSetting("tools") } as AgentCtx;
    const set = await buildToolset(ctx);
    try {
      expect(set.approval({ toolCall: { toolName: "remember", input: { fact, shared: false } } })).toBe("user-approval");
      const answer = applyApprovalDecisions([remember()], new Map([["approval", { approved: true }]])).parts[0];
      expect(answer.approval).toMatchObject({ approved: true });
      await set.tools.remember.execute!({ fact, shared: false }, { toolCallId: "remember-call", messages: [], context: undefined });
      expect(await selectMemories({ userId: "owner", botId: "bot" })).toMatchObject([{ content: fact }]);
      // Allow once authorizes this foreground action, not a second background extraction.
      expect(await extractMemoriesFromConversation("chat")).toBe(0);
      expect(await db.select().from(schema.memories)).toHaveLength(1);
    } finally { await set.close(); }
  });

  it("activates a retained proposal only after an explicit human approval", async () => {
    await deny(); await reviewNativeRun("run");
    const [proposal] = await learningViews(owner, "bot");
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toEqual([]);
    await expect(changeLearning((await loadPrincipal("other"))!, proposal.id, proposal.version, { status: "active" })).rejects.toMatchObject({ status: 403 });
    await changeLearning(owner, proposal.id, proposal.version, { status: "active" });
    expect(await selectMemories({ userId: "owner", botId: "bot" })).toMatchObject([{ content: expect.stringContaining(fact) }]);
    expect(await extractMemoriesFromConversation("chat")).toBe(0);
    expect(await db.select().from(schema.memories)).toEqual([]);
  });
});
