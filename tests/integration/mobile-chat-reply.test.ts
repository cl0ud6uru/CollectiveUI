import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockLlm } from "./helpers/mock-llm";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("@/auth", () => ({ auth: async () => null }));
// Drive the real executor explicitly. Never enqueue work for a separately running worker.
vi.mock("@/lib/jobs", async (original) => ({
  ...(await original<typeof import("@/lib/jobs")>()),
  enqueueRun: vi.fn(async () => "fixture-job"),
  enqueue: vi.fn(async () => null),
  scheduleMemoryExtraction: vi.fn(async () => {}),
}));

// Opt in separately from the general integration database. Validate before importing
// application/database modules, including teardown after a failed setup.
const fixtureURL = process.env.MOBILE_CHAT_REPLY_TEST_URL;
if (fixtureURL) {
  const failure = () => new Error("Use MOBILE_CHAT_REPLY_TEST_URL with an explicit port and disposable loopback collective_native_reply_test database, without connection overrides.");
  let database: URL;
  try { database = new URL(fixtureURL); } catch { throw failure(); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || database.hostname !== "127.0.0.1" ||
    !database.port || database.pathname !== "/collective_native_reply_test" || fixtureURL.includes("?") || fixtureURL.includes("#") ||
    Object.keys(process.env).some(key => /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|OPTIONS|SERVICE|SERVICEFILE|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key) && process.env[key])) {
    throw failure();
  }
}
const suite = fixtureURL ? describe : describe.skip;

suite("native bearer chat through admission, execution, SSE and snapshot", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let userId: string;
  const appIds: string[] = [];
  const botIds = new Map<string, string>();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", fixtureURL!);
    vi.stubEnv("MOBILE_APP_ENABLED", "true");
    vi.stubEnv("LDAP_ENABLED", "true");
    vi.stubEnv("LDAP_URL", "ldaps://ldap.example.invalid");
    mock = await startMockLlm();
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    const { issueAuthCode, exchangeAuthCode } = await import("@/lib/auth/mobile");
    userId = `it-native-reply-${newId()}`;
    await db.insert(schema.users).values({ id: userId, upn: `${userId}@fixture.invalid`, name: "Native Reply Fixture", authSource: "ldap", prefs: { memoryEnabled: false } });
    const principal = (await loadPrincipal(userId))!;
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const code = await issueAuthCode(principal, {
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      state: "native-reply-fixture", deviceName: "Fixture Mac",
    }, "ldap");
    const { token } = await exchangeAuthCode(code, verifier);
    request.headers = new Headers({ authorization: `Bearer ${token}` });
    for (const provider of ["openai", "openai-compatible"] as const) {
      const id = newId();
      appIds.push(id);
      await db.insert(schema.aiApps).values({ id, name: "Native reply fixture", provider,
        baseUrl: `${mock.url}/v1`, apiKeyEnc: sealAppSecret(id, "synthetic-native-reply-key"), model: "mock-gpt" });
      // No configured tools, delegates, MCP servers or external connections.
      const [bot] = await db.insert(schema.bots).values({ ownerId: userId, name: "Native reply fixture", appId: id }).returning();
      botIds.set(provider, bot.id);
    }
  });

  afterAll(async () => {
    const { runListener } = await import("@/lib/runs/listener");
    await runListener().close();
    const { db, pool, schema } = await import("@/db");
    if (userId) {
      await db.delete(schema.usageEvents).where(eq(schema.usageEvents.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    if (appIds.length) await db.delete(schema.aiApps).where(inArray(schema.aiApps.id, appIds));
    await pool.end();
    mock?.stop();
    vi.unstubAllEnvs();
  });

  async function send(conversationId: string, text: string, options: { botId?: string; parentId?: string } = {}) {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { POST } = await import("@/app/api/chat/route");
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const { GET } = await import("@/app/api/chat/[id]/route");
    const messageId = newId();
    // The same request shape as shared ChatModel.send() and APIClient.streamChat().
    const req = new Request("http://fixture.invalid/api/chat", { method: "POST",
      headers: { ...Object.fromEntries(request.headers), "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ conversationId, ...options, parentId: options.parentId ?? null,
        message: { id: messageId, role: "user", parts: [{ type: "text", text }] } }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.parentMessageId, messageId));
    expect(run).toMatchObject({ userId, status: "queued" });
    const [wire] = await Promise.all([response.text(), executeRun(run.id)]);
    expect(wire).toContain("data: [DONE]\n\n");
    const chunks = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const snapshotResponse = await GET(new Request(`http://fixture.invalid/api/chat/${conversationId}`), { params: Promise.resolve({ id: conversationId }) });
    expect(snapshotResponse.status).toBe(200);
    return { chunks, wire, run: (await getRun(run.id))!, snapshot: await snapshotResponse.json(), messageId };
  }

  it.each([
    { provider: "openai", home: false }, { provider: "openai", home: true },
    { provider: "openai-compatible", home: false }, { provider: "openai-compatible", home: true },
  ])("streams and persists a first reply and follow-up with $provider, bot home=$home", { timeout: 30_000 }, async ({ provider, home }) => {
    const { newId } = await import("@/lib/ids");
    const botId = botIds.get(provider)!;
    let conversationId = newId();
    if (home) {
      const { POST } = await import("@/app/api/mobile/v1/bots/[id]/chat/route");
      const opened = await POST(new Request(`http://fixture.invalid/api/mobile/v1/bots/${botId}/chat`, {
        method: "POST", headers: request.headers, body: JSON.stringify({ kind: "home" }),
      }), { params: Promise.resolve({ id: botId }) });
      expect(opened.status).toBe(200);
      conversationId = (await opened.json()).conversationId;
    }
    const first = await send(conversationId, "Fixture first question", home ? {} : { botId });
    expect(first.run).toMatchObject({ status: "succeeded", error: null });
    expect(first.chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.delta).join("")).toContain("Fixture first question");
    expect(first.chunks.some(chunk => chunk.type === "error" || chunk.type.startsWith("tool-"))).toBe(false);
    expect(first.snapshot.initialLeafId).toBe(first.run.messageId);
    expect(first.snapshot.initialRows).toHaveLength(2);
    expect(first.snapshot.isBotHome).toBe(home);
    const follow = await send(conversationId, "[history] Fixture next question", { parentId: first.run.messageId });
    expect(follow.run).toMatchObject({ status: "succeeded", error: null });
    const text = follow.chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.delta).join("");
    expect(text).toContain("user: Fixture first question");
    expect(text).toContain('assistant: You said: "Fixture first question"');
    expect(text).toContain("user: [history] Fixture next question");
    expect(follow.snapshot.initialRows).toHaveLength(4);
    expect(follow.snapshot.resume).toBe(false);
  });

  it("correlates a rejected provider request without exposing its private body", { timeout: 30_000 }, async () => {
    const { newId } = await import("@/lib/ids");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await send(newId(), "[draft:reject]", { botId: botIds.get("openai-compatible") });
      const errors = result.chunks.filter(chunk => chunk.type === "error");
      expect(errors).toHaveLength(1);
      const record = log.mock.calls.find(call => call[0] === "[native] request failed")?.[1];
      expect(record).toMatchObject({ kind: "provider", status: 400 });
      expect(errors[0].errorText).toBe(`Something went wrong. Try again. Reference: ${record.reference}.`);
      expect(result.run).toMatchObject({ status: "failed", error: errors[0].errorText });
      expect(result.snapshot.initialRows.some((row: { id: string }) => row.id === result.messageId)).toBe(true);
      expect(result.snapshot.initialRows.find((row: { id: string }) => row.id === result.run.messageId)?.message.parts)
        .toContainEqual({ type: "data-run-error", data: { message: errors[0].errorText } });
      expect(JSON.stringify([result, log.mock.calls])).not.toContain("sk-mock-provider-detail");
    } finally {
      log.mockRestore();
    }
  });
});
