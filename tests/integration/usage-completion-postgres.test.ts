import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
vi.mock("server-only", () => ({}));
import { db, pool, schema } from "@/db";
import { createVoiceSession } from "@/lib/voice/session";
import { sealProviderCredential } from "@/lib/llm/provider-connections";
import { usageMiddleware } from "@/lib/llm/middleware";
import { nativeRunBudgetMiddleware } from "@/lib/llm/run-budget-middleware";
import { newUsageScope, type UsageContext } from "@/lib/llm/usage";
import { usageExportRows } from "@/lib/usage";

const suite = process.env.USAGE_COMPLETION_POSTGRES === "1" ? describe : describe.skip;
suite("usage completion on disposable PostgreSQL with no live provider calls", () => {
  const owner = `usage-completion-${process.pid}-${Date.now()}`;
  let connectionId: string, voiceApp: typeof schema.aiApps.$inferSelect, backend: typeof voiceApp;
  let chatId: string;
  const ledger = () => db.select().from(schema.usageEvents).where(eq(schema.usageEvents.userId, owner));
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_review_usage_completion_test")
      throw new Error("Requires disposable collective_review_usage_completion_test database");
    await db.insert(schema.users).values({ id: owner, upn: `${owner}@fixture.invalid`, name: "Synthetic usage owner", authSource: "ldap" });
    connectionId = `${owner}-connection`;
    await db.insert(schema.providerConnections).values({ id: connectionId, name: "Synthetic OpenAI transport", provider: "openai", organization: "org-before", project: "project-before", credentialEnc: sealProviderCredential(connectionId, "synthetic-never-live-key") });
    [voiceApp, backend] = await db.insert(schema.aiApps).values([
      { name: "Voice transport", provider: "openai", model: "backend-responses-model", providerConnectionId: connectionId },
      { name: "Hermes backend", provider: "hermes", model: "profile-alias", baseUrl: "http://127.0.0.1:1" },
    ]).returning();
    chatId = `${owner}-chat`;
    await db.insert(schema.conversations).values({ id: chatId, userId: owner, appId: backend.id });
  });
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected live provider call"); })); });
  afterEach(async () => {
    await db.delete(schema.usageEvents).where(eq(schema.usageEvents.userId, owner));
    await db.delete(schema.nativeRunBudgets).where(eq(schema.nativeRunBudgets.userId, owner));
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, owner));
    if (voiceApp) await db.delete(schema.aiApps).where(eq(schema.aiApps.id, voiceApp.id));
    if (backend) await db.delete(schema.aiApps).where(eq(schema.aiApps.id, backend.id));
    if (connectionId) await db.delete(schema.providerConnections).where(eq(schema.providerConnections.id, connectionId));
    await pool.end();
  });

  it("records the actual saved voice transport and immutable billing selectors, with null token counts", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      expect(url).toBe("https://api.openai.com/v1/live/sessions");
      expect(new Headers(options?.headers).get("OpenAI-Organization")).toBe("org-before");
      return Response.json({ session: { id: "synthetic-session" }, transport: { type: "webrtc", sdp: "synthetic-answer" } });
    });
    await createVoiceSession({ app: backend, bot: null, voiceApp }, "synthetic-offer", fetcher, [], { userId: owner, conversationId: chatId });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "voice", completionStatus: "started", providerKind: "openai", model: "gpt-live-1", appId: voiceApp.id, userId: owner, conversationId: chatId,
      billingSource: "org", billingRoute: "api:openai", providerConnectionId: connectionId, providerOrganization: "org-before", providerProject: "project-before", inputTokens: null, outputTokens: null, costMicros: null });
    await db.update(schema.providerConnections).set({ organization: "org-after", project: "project-after" }).where(eq(schema.providerConnections.id, connectionId));
    expect((await ledger())[0]).toMatchObject({ providerOrganization: "org-before", providerProject: "project-before" });
    const exported = (await usageExportRows()).find(row => row.upn === `${owner}@fixture.invalid` && row.purpose === "voice")!;
    expect([exported.calls, exported.voice_sessions, exported.input_tokens, exported.output_tokens].map(Number)).toEqual([1, 1, 0, 0]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("records one incomplete cancellation row while retaining the actual native budget reservation", async () => {
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ enabled: true, maxTokens: 100_000, maxCostMicros: 1_000_000, maxInputTokensPerCall: 50_000, maxOutputTokensPerCall: 64,
      routes: [{ provider: "openai", model: "synthetic-model", inputContract: "conservative-text-v1", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 }] }));
    const ctx: UsageContext = { purpose: "chat", providerKind: "openai", model: "synthetic-model", billingSource: "org", billingRoute: "api:openai", providerConnectionId: connectionId,
      userId: owner, conversationId: chatId, appId: voiceApp.id, scope: newUsageScope({ messageId: "synthetic-reply", rootBudgetId: `${owner}-root` }) };
    const cancel = vi.fn();
    const model = wrapLanguageModel({ model: new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "text-delta", id: "t", delta: "partial" }); }, cancel }) }) }),
      middleware: [usageMiddleware(ctx), nativeRunBudgetMiddleware(ctx)] });
    const result = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "Synthetic only" }] }] });
    const reader = result.stream.getReader(); await reader.read(); await reader.cancel("synthetic Stop");
    await Promise.all(ctx.scope!.pending);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("synthetic Stop");
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completionStatus: "incomplete", inputTokens: null, outputTokens: null, model: "synthetic-model", providerConnectionId: connectionId });
    const [attempt] = await db.select().from(schema.nativeRunBudgetAttempts).where(eq(schema.nativeRunBudgetAttempts.rootMessageId, `${owner}-root`));
    expect(attempt.state).toBe("uncertain");
    const [budget] = await db.select().from(schema.nativeRunBudgets).where(eq(schema.nativeRunBudgets.rootMessageId, `${owner}-root`));
    expect(budget.reservedTokens).toBeGreaterThan(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
