import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "./helpers/mock-llm";

// Keep the turn self-contained: no embedding app (memory selection falls back to recent memories).
vi.mock("@/lib/llm/apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/apps")>()),
  embeddingApp: async () => undefined,
}));

// Integration: needs DATABASE_URL pointing at a migrated database. Skipped otherwise.
const run = process.env.DATABASE_URL ? describe : describe.skip;

async function drain(stream: ReadableStream<unknown>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
}

run("native providers through the agent loop (integration)", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  const userId = `it-prov-${process.pid}-${Date.now()}`;
  const appIds: string[] = [];

  beforeAll(async () => {
    mock = await startMockLlm();
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    await db.insert(users).values({ id: userId, upn: `${userId}@corp.local`, name: "Provider Test", authSource: "ldap" });
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { aiApps, usageEvents, users } = await import("@/db/schema");
    await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
    if (appIds.length) await db.delete(aiApps).where(inArray(aiApps.id, appIds));
    await db.delete(users).where(eq(users.id, userId)); // cascades to bots, conversations, memories
    await pool.end();
    mock?.stop();
  });

  it.each([
    ["openai", "/v1", "mock-gpt"],
    ["azure", "/openai/v1", "mock-gpt"],
    ["anthropic", "/v1", "claude-sonnet-4-5"],
  ] as const)("%s: tool approval pause, continuation, message billing columns and usage ledger", { timeout: 60_000 }, async (provider, path, model) => {
    const { db } = await import("@/db");
    const { aiApps, botTools, bots, conversations, memories, messages, usageEvents, users } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    const { insertMessage, updateMessageParts } = await import("@/lib/chat/store");
    const { applyApprovalDecisions } = await import("@/lib/agent/approval-merge");
    const { runTurn } = await import("@/lib/agent/run");

    const appId = newId();
    appIds.push(appId);
    await db.insert(aiApps).values({
      id: appId,
      name: `IT ${provider}`,
      provider,
      baseUrl: `${mock.url}${path}`,
      apiKeyEnc: sealAppSecret(appId, provider === "anthropic" ? "sk-ant-api03-integration" : "sk-integration"),
      model,
      supportsTools: true,
    });
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, appId));
    const [bot] = await db.insert(bots).values({ ownerId: userId, name: `IT bot ${provider}`, appId, description: "Remembers things." }).returning();
    await db.insert(botTools).values({ botId: bot.id, toolKey: "memory", approval: "ask" });
    const [conversation] = await db.insert(conversations).values({ id: newId(), userId, botId: bot.id, title: "IT" }).returning();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const principal = { user, groupIds: [], isAdmin: false, canCreateBots: true };

    const userMsg = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: `[tool:remember {"fact":"likes ${provider} tea"}]` }] };
    await insertMessage(conversation.id, userMsg, null);

    // Turn 1: the model calls `remember`, which needs approval, so the turn pauses. Both turns run as part of one
    // durable run (its id is on every usage row), background so no memory-extraction job is queued on the dev stack.
    const run = { id: `it-run-${newId()}`, segment: 0, legacy: false, resumeState: null, saveResumeState: () => {} };
    const first = await runTurn({ principal, conversation, app, bot, history: [userMsg], continuation: false, background: true, interactive: true, run });
    await drain(first.stream);
    const paused = await first.done;
    expect(paused.error).toBeUndefined();
    expect(paused.pendingApproval).toBe(true);
    const assistantId = paused.responseMessage.id;

    // Approve (as the chat route does: decisions merged into the stored parts), then continue.
    const approvalId = (paused.responseMessage.parts.find((p) => "approval" in p && p.state === "approval-requested") as { approval: { id: string } })
      .approval.id;
    const { parts } = applyApprovalDecisions(paused.responseMessage.parts as never[], new Map([[approvalId, { approved: true }]]));
    const approved = { ...paused.responseMessage, parts };
    await updateMessageParts(conversation.id, approved);
    const second = await runTurn({ principal, conversation, app, bot, history: [userMsg, approved], continuation: true, background: true, interactive: true, run });
    await drain(second.stream);
    const finished = await second.done;
    expect(finished.error).toBeUndefined();
    expect(finished.responseMessage.id).toBe(assistantId);
    const text = finished.responseMessage.parts.map((p) => ("text" in p ? p.text : "")).join("");
    expect(text).toContain("The `remember` tool returned");

    const [row] = await db.select().from(messages).where(eq(messages.id, assistantId));
    expect(row).toMatchObject({ billingSource: "org", providerKind: provider, appId });

    const events = await db.select().from(usageEvents).where(eq(usageEvents.messageId, assistantId));
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(e).toMatchObject({ purpose: "chat", providerKind: provider, appId, userId, conversationId: conversation.id, botId: bot.id, billingSource: "org", runId: run.id });
      expect(e.inputTokens).toBeGreaterThan(0);
      expect(e.outputTokens).toBeGreaterThan(0);
    }
    if (provider === "anthropic") {
      // The stable system block carries a cache breakpoint: written on the first call, read on the next.
      expect(events.some((e) => (e.cacheWriteTokens ?? 0) > 0)).toBe(true);
      expect(events.some((e) => (e.cacheReadTokens ?? 0) > 0)).toBe(true);
    }

    const saved = await db.select().from(memories).where(eq(memories.userId, userId));
    expect(saved.some((m) => m.content === `likes ${provider} tea`)).toBe(true);
  });
});
