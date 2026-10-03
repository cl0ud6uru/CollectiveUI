import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApp, Bot, Conversation } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";

vi.mock("@/lib/jobs", async (original) => ({ ...(await original<typeof import("@/lib/jobs")>()), enqueueRun: vi.fn(async () => "mock-job") }));
vi.mock("@/lib/runs/hooks", () => ({ afterRunTransition: vi.fn(async () => {}) }));

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("Hermes commands (real database, isolated HTTP mock, no worker)", () => {
  const load = async () => {
    await import("@/lib/jobs");
    const { db, pool } = await import("@/db");
    const schema = await import("@/db/schema");
    const service = await import("@/lib/chat/hermes-command-service");
    const store = await import("@/lib/runs/store");
    const state = await import("@/lib/runs/state");
    const chat = await import("@/lib/chat/store");
    const resolve = await import("@/lib/llm/resolve");
    const { newId } = await import("@/lib/ids");
    const { sealAppSecret } = await import("@/lib/llm/secrets");
    return { db, pool, schema, service, store, state, chat, resolve, newId, sealAppSecret };
  };
  let m: Awaited<ReturnType<typeof load>>;
  let p: Principal, other: Principal, app: AiApp, bot: Bot, conv: Conversation;
  const userIds: string[] = [], appIds: string[] = [];
  const calls: { path: string; method: string; body?: unknown }[] = [];
  let stopFails = false, stillRunning = false, skillsFail = false;
  const remote = new Map<string, string>();

  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", "42".repeat(32));
    m = await load();
    for (let i = 0; i < 2; i++) {
      const id = `hc-${m.newId()}`;
      const [user] = await m.db.insert(m.schema.users).values({ id, upn: `${id}@isolated.test`, name: id, authSource: "ldap" }).returning();
      userIds.push(id);
      const principal = { user, groupIds: [], isAdmin: false, canCreateBots: false };
      if (i === 0) p = principal; else other = principal;
    }
  });
  beforeEach(async () => {
    // Each case owns fresh conversations; previous deliberately queued runs must not consume the user's cap.
    await m.db.delete(m.schema.conversations).where(inArray(m.schema.conversations.userId, userIds));
    calls.length = 0; stopFails = stillRunning = skillsFail = false; remote.clear();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith("/v1/capabilities")) return Response.json({ features: { run_stop: true } });
      if (path.endsWith("/v1/models")) return Response.json({ data: [{ id: "fast" }, { id: "reasoning" }, { id: "not-allowed" }] });
      if (path.endsWith("/v1/skills")) return skillsFail ? new Response("upstream bug", { status: 500 }) : Response.json({ data: [{ name: "help", description: "Native skill named help" }] });
      if (path.endsWith("/v1/toolsets")) return Response.json({ data: [{ name: "terminal", description: "Mock only", enabled: true, configured: true }] });
      const match = /\/v1\/runs\/([^/]+)(\/stop)?$/.exec(path);
      if (match) {
        if (match[2]) {
          if (stopFails) return new Response("unavailable", { status: 503 });
          if (!stillRunning) remote.set(match[1], "cancelled");
          return Response.json({ status: "stopping" });
        }
        return Response.json({ run_id: match[1], status: remote.get(match[1]) ?? "running" });
      }
      throw new Error(`Unexpected mock request: ${method} ${path}`);
    }));
    const id = `hc-${m.newId()}`; appIds.push(id);
    [app] = await m.db.insert(m.schema.aiApps).values({ id, name: id, provider: "hermes", baseUrl: "http://127.0.0.1:18642", model: "coder", providerConfig: { profile: "alice", approvalTimeoutSec: 300, allowedModels: "fast, reasoning" }, apiKeyEnc: m.sealAppSecret(id, "mock-profile-key"), isPublic: true }).returning();
    [bot] = await m.db.insert(m.schema.bots).values({ id: m.newId(), ownerId: p.user.id, name: "Hermes test bot", appId: app.id, visibility: "org" }).returning();
    [conv] = await m.db.insert(m.schema.conversations).values({ id: m.newId(), userId: p.user.id, botId: bot.id }).returning();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (m) {
      if (userIds.length) await m.db.delete(m.schema.users).where(inArray(m.schema.users.id, userIds));
      if (appIds.length) await m.db.delete(m.schema.aiApps).where(inArray(m.schema.aiApps.id, appIds));
      await m.pool.end();
    }
    vi.unstubAllEnvs();
  });
  const command = (text: string, extra = {}, principal = p) => m.service.executeHermesCommand(principal, { conversationId: conv.id, text, revision: 0, ...extra });
  async function start() {
    return m.store.startRun({ principal: p, conversation: conv, app, bot, userMessage: { id: m.newId(), role: "user", parts: [{ type: "text", text: "hello" }] }, parentId: null });
  }
  async function waiting() {
    const run = await start();
    await m.state.claimRun(run.id, "test-worker");
    const upstreamId = `remote-${m.newId()}`;
    await m.state.noteRunResumeState(run.id, "test-worker", { hermes: { runId: upstreamId } });
    await m.chat.insertMessage(conv.id, { id: run.messageId, role: "assistant", parts: [{ type: "dynamic-tool", toolName: "terminal", toolCallId: "call-one", state: "approval-requested", input: {}, approval: { id: "approval-one" } }] }, run.parentMessageId);
    await m.state.pauseRun(run, "test-worker", { hermes: { runId: upstreamId } });
    return { run, upstreamId };
  }

  it("keeps help/status/usage/discovery out of messages, runs and the usage ledger", async () => {
    for (const text of ["/help", "/status", "/usage", "/skills", "/tools", "/model"]) expect((await command(text)).lines.length).toBeGreaterThan(0);
    for (const table of [m.schema.messages, m.schema.agentRuns, m.schema.usageEvents]) {
      const [{ n }] = await m.db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.conversationId, conv.id));
      expect(n).toBe(0);
    }
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("rejects another user's conversation and inaccessible targets before upstream discovery", async () => {
    await expect(command("/status", {}, other)).rejects.toMatchObject({ status: 404 });
    await expect(command("/stop", {}, other)).rejects.toMatchObject({ status: 404 });
    await m.db.update(m.schema.aiApps).set({ isPublic: false }).where(eq(m.schema.aiApps.id, app.id));
    await expect(m.service.resolveCommandTarget(other, { conversationId: m.newId(), appId: app.id })).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });
  it("rejects commands in groups, routine results and non-Hermes targets", async () => {
    await m.db.update(m.schema.conversations).set({ isGroup: true }).where(eq(m.schema.conversations.id, conv.id));
    await expect(command("/reset")).rejects.toMatchObject({ status: 400 });
    await m.db.update(m.schema.conversations).set({ isGroup: false, source: "routine" }).where(eq(m.schema.conversations.id, conv.id));
    await expect(command("/stop")).rejects.toMatchObject({ status: 400 });
    await m.db.update(m.schema.conversations).set({ source: "chat" }).where(eq(m.schema.conversations.id, conv.id));
    await m.db.update(m.schema.aiApps).set({ provider: "openai-compatible" }).where(eq(m.schema.aiApps.id, app.id));
    await expect(command("/help")).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
  it("does not resolve an unknown/native slash token or a clashing portal skill as model text", async () => {
    for (const text of ["/terminal ls", "/compress", "/portal help", "/skills install x", "/new argument", "/unknown"])
      await expect(command(text)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
  it("filters model discovery by admin permission and degrades a broken skill endpoint", async () => {
    skillsFail = true;
    const catalog = await m.service.commandCatalog(await m.service.resolveCommandTarget(p, { conversationId: conv.id }));
    expect(catalog).toMatchObject({ models: { available: true, items: ["fast", "reasoning"] }, skills: { available: false } });
    await expect(command("/model not-allowed")).rejects.toMatchObject({ status: 400 });
    expect((await command("/skills")).lines.join(" ")).toContain("skills-discovery bug");
    expect((await command("/help")).title).toBe("Hermes commands");
  });
  it("uses revision checks and absolute idempotent selections, never app defaults", async () => {
    expect((await command("/model fast")).revision).toBe(1);
    expect((await command("/model fast")).revision).toBe(1); // retry after response loss
    await expect(command("/model reasoning")).rejects.toMatchObject({ status: 409 });
    expect((await command("/model reasoning", { revision: 1 })).revision).toBe(2);
    const [unchanged] = await m.db.select().from(m.schema.aiApps).where(eq(m.schema.aiApps.id, app.id));
    expect(unchanged.model).toBe("coder");
    const [separate] = await m.db.insert(m.schema.conversations).values({ id: m.newId(), userId: other.user.id, botId: bot.id }).returning();
    expect((await command("/model", { conversationId: separate.id }, other)).lines[0]).toContain("Hermes default");
  });
  it("snapshots a requested model for admission and keeps it on approval continuation", async () => {
    await command("/model fast");
    const { run } = await waiting();
    await expect(command("/model reasoning", { revision: 1 })).rejects.toMatchObject({ status: 409 });
    const resumed = await m.store.continueRun({ principal: p, conversation: conv, messageId: run.messageId, decisions: new Map([["approval-one", { approved: true }]]) });
    expect(resumed.segment).toBe(1);
    const [context] = await m.db.select().from(m.schema.hermesRunContexts).where(eq(m.schema.hermesRunContexts.runId, run.id));
    expect(context.model).toBe("fast");
  });
  it("serializes a setting change against a run admission", async () => {
    const [selection, admission] = await Promise.allSettled([command("/model fast"), start()]);
    expect(admission.status).toBe("fulfilled");
    const [snapshot] = await m.db.select().from(m.schema.hermesRunContexts).innerJoin(m.schema.agentRuns, eq(m.schema.agentRuns.id, m.schema.hermesRunContexts.runId)).where(eq(m.schema.agentRuns.conversationId, conv.id));
    expect(snapshot.hermes_run_contexts.model).toBe(selection.status === "fulfilled" ? "fast" : null);
  });
  it("opens an idempotent fresh session preserving old history and scoped settings", async () => {
    await command("/model fast");
    await m.chat.insertMessage(conv.id, { id: m.newId(), role: "user", parts: [{ type: "text", text: "keep this" }] }, null);
    const next = m.newId();
    expect((await command("/new", { newConversationId: next })).navigateTo).toBe(`/c/${next}`);
    expect((await command("/reset", { newConversationId: next })).navigateTo).toBe(`/c/${next}`);
    expect((await m.chat.loadMessageRows(conv.id))[0].parts).toEqual([{ type: "text", text: "keep this" }]);
    expect(await m.chat.loadMessageRows(next)).toEqual([]);
    const [setting] = await m.db.select().from(m.schema.hermesChatSettings).where(eq(m.schema.hermesChatSettings.conversationId, next));
    expect(setting.model).toBe("fast");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
  it("cancels queued work without starting a Hermes run", async () => {
    const run = await start();
    await expect(command("/new", { newConversationId: m.newId() })).rejects.toMatchObject({ status: 409 });
    expect((await command("/stop")).lines).toContain("Cancelled before Hermes started.");
    expect((await m.state.getRun(run.id))?.status).toBe("cancelled");
    expect(calls).toEqual([]);
    await command("/new", { newConversationId: m.newId() });
  });
  it("cancels approval waits, closes stored cards, and rejects later approval replay", async () => {
    const { run, upstreamId } = await waiting();
    const result = await command("/stop");
    expect(result.lines.join(" ")).toContain("Hermes reply ended (cancelled)");
    expect(remote.get(upstreamId)).toBe("cancelled");
    expect((await m.state.getRun(run.id))?.resumeState).toBeNull();
    const finished = (await m.state.getRun(run.id))!;
    expect(finished.segment).toBe(1);
    const { readEvents } = await import("@/lib/runs/log");
    const { replayFilter } = await import("@/lib/runs/replay");
    const filter = replayFilter(finished.segment);
    const replay = [];
    for (const event of await readEvents(run.id, 0, 100)) {
      const chunk = filter(event);
      if (chunk === "end") break;
      if (chunk) replay.push(chunk);
    }
    expect(replay).toContainEqual({ type: "tool-output-denied", toolCallId: "call-one" });
    const [context] = await m.db.select().from(m.schema.hermesRunContexts).where(eq(m.schema.hermesRunContexts.runId, run.id));
    expect(context.upstreamRunId).toBe(upstreamId);
    const row = (await m.chat.loadMessageRows(conv.id)).find((r) => r.id === run.messageId)!;
    expect(JSON.stringify(row.parts)).not.toContain("approval-requested");
    await expect(m.store.continueRun({ principal: p, conversation: conv, messageId: run.messageId, decisions: new Map([["approval-one", { approved: true }]]) })).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    await command("/stop"); // safe retry
  });
  it("retains failed cancellation for retries and blocks new/model/admission until confirmed", async () => {
    const { run } = await waiting();
    stopFails = true;
    expect((await command("/stop")).lines.join(" ")).toContain("unconfirmed");
    expect((await m.state.getRun(run.id))?.status).toBe("cancelled");
    await expect(command("/new", { newConversationId: m.newId() })).rejects.toMatchObject({ status: 409 });
    await expect(command("/model fast")).rejects.toMatchObject({ status: 409 });
    await expect(start()).rejects.toMatchObject({ status: 409 });
    stopFails = false;
    await command("/stop");
    await command("/new", { newConversationId: m.newId() });
  });
  it("distinguishes an accepted stop from actual remote termination and can reconcile interrupted replies", async () => {
    const { run, upstreamId } = await waiting();
    stillRunning = true;
    expect((await command("/stop")).lines.join(" ")).toContain("not confirmed an ended state");
    await m.db.transaction((tx) => m.state.finalizeRunTx(tx, run.id, { status: ["cancelled"] }, { status: "interrupted" }));
    remote.set(upstreamId, "cancelled");
    expect((await command("/status")).lines.join(" ")).toContain("Hermes reply ended");
    await command("/new", { newConversationId: m.newId() });
  });
  it("will not send a stored upstream id to a replacement profile", async () => {
    await waiting();
    await m.db.update(m.schema.aiApps).set({ providerConfig: { ...app.providerConfig, profile: "bob" } }).where(eq(m.schema.aiApps.id, app.id));
    expect((await command("/stop")).lines.join(" ")).toContain("connection changed");
    expect(calls).toEqual([]);
    await expect(command("/new", { newConversationId: m.newId() })).rejects.toMatchObject({ status: 409 });
  });
  it("refuses a run snapshot after credential/permission changes at execution time", async () => {
    await command("/model fast");
    const run = await start();
    const [context] = await m.db.select().from(m.schema.hermesRunContexts).where(eq(m.schema.hermesRunContexts.runId, run.id));
    const opts = { purpose: "chat" as const, principal: p, botId: bot.id, conversationId: conv.id, interactive: true, run: { id: run.id, segment: 0, legacy: false, resumeState: null, hermes: context, saveResumeState() {} } };
    await expect(m.resolve.resolveModel({ ...app, providerConfig: { ...app.providerConfig, allowedModels: "reasoning" } }, opts)).rejects.toThrow("permission changed");
    await expect(m.resolve.resolveModel({ ...app, apiKeyEnc: m.sealAppSecret(app.id, "replacement-key") }, opts)).rejects.toThrow("connection or model");
    await expect(m.resolve.resolveModel({ ...app, provider: "openai-compatible" }, opts)).rejects.toThrow("backend changed");
  });

  it("serializes stop against an approval answer without sending the approval itself", async () => {
    const { run } = await waiting();
    await Promise.allSettled([
      command("/stop"),
      m.store.continueRun({ principal: p, conversation: conv, messageId: run.messageId, decisions: new Map([["approval-one", { approved: true }]]) }),
    ]);
    expect((await m.state.getRun(run.id))?.status).toBe("cancelled");
    expect(calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
  });

  it("handles a stop before admission, and retains a running reply's late upstream identity", async () => {
    const messageId = m.newId();
    const stopping = command("/stop", { messageId });
    const run = await m.store.startRun({ principal: p, conversation: conv, app, bot, userMessage: { id: messageId, role: "user", parts: [{ type: "text", text: "hello" }] }, parentId: null });
    await stopping;
    expect((await m.state.getRun(run.id))?.status).toBe("cancelled");

    const running = await start();
    await m.state.claimRun(running.id, "late-worker");
    expect((await command("/stop")).lines.join(" ")).toContain("identity is not recorded yet");
    await m.state.noteRunResumeState(running.id, "late-worker", { hermes: { runId: "late-upstream" } });
    await m.db.transaction((tx) => m.state.finalizeRunTx(tx, running.id, { status: ["running"] }, { status: "cancelled" }));
    expect((await command("/stop")).lines.join(" ")).toContain("Hermes reply ended");
    expect(remote.get("late-upstream")).toBe("cancelled");
  });
});
