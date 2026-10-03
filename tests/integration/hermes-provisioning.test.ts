import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool } from "@/db";
import { agentRuns, aiApps, bots, conversations, messages, hermesConnections, hermesProvisions, hermesRunContexts, users, type AiApp, type Bot } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { decrypt } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { HERMES_PROTOCOL, connectionAAD } from "@/lib/hermes-provisioning/config";
import { assertManagedConversation, ensureProfile, managedTarget, registerConnection, rotateDashboardToken, setConnectionEnabled } from "@/lib/hermes-provisioning/store";
import { freshConversation } from "@/lib/chat/fresh";
import { hermesTargetFor, resolveModel } from "@/lib/llm/resolve";
import { startRun as admitRun } from "@/lib/runs/store";
import { answerApproval, startRun } from "@/lib/llm/providers/hermes/client";
import { ProvisioningMock } from "../fixtures/hermes/provisioning-mock";

import { approveManagedBot, lockBot, profileSpec } from "@/lib/hermes-provisioning/bot-policy";
import { createBot, deleteBot, updateBot, duplicateBot, createBotTemplate, addBotFromTemplate, type BotInput } from "@/app/(chat)/bots/actions";
import { deleteApp } from "@/app/admin/actions";
import { assertAdmin, HttpError } from "@/lib/authz";
import { POST } from "@/app/api/chat/route";
import { insertMessage } from "@/lib/chat/store";
import { stopProviderRun } from "@/lib/runs/provider-stop";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/session", () => ({
  requirePrincipal: async () => session.principal!,
  requireAdmin: async () => { assertAdmin(session.principal!); return session.principal!; },
  errorResponse: (err: unknown) => Response.json({ error: err instanceof HttpError ? err.message : "Failed" }, { status: err instanceof HttpError ? err.status : 500 }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/jobs", () => ({ enqueueRun: vi.fn(async () => "synthetic-job"), enqueue: vi.fn(), QUEUES: {}, getBoss: vi.fn() }));
const suite = process.env.HERMES_PROVISIONING_DB_TEST === "1" ? describe : describe.skip;
suite("Hermes durable provisioning (disposable PostgreSQL and synthetic transport)", () => {
  let admin: Principal, alice: Principal, bob: Principal, app: AiApp, bot: Bot, mock: ProvisioningMock;
  const ids: string[] = [], apps: string[] = [];
  const config = { provider: "openai", model: "mock-model", skills: [], toolsets: [] };
  const register = (p: Principal, port: number, keys = 3) => registerConnection(admin, {
    userId: p.user.id, boundaryId: `boundary-${p.user.id}`, isolated: true, protocol: HERMES_PROTOCOL,
    dashboardUrl: `http://127.0.0.1:${port}`, runsUrl: `http://127.0.0.1:${port + 1}`,
    expectedVersion: "mock-pinned", expectedDisplayVersion: "mock-pinned", dashboardToken: "synthetic-dashboard-token",
    provider: "openai", providerKey: "synthetic-provider-key", profileKeys: Array.from({ length: keys }, (_, i) => `synthetic-profile-key-${p.user.id}-${i}`),
  });
  const input = (extra: Partial<BotInput> = {}): BotInput => ({ name: bot.name, appId: app.id, visibility: "org", instructions: bot.instructions, description: bot.description, boundaries: bot.boundaries, groupIds: [], maxSteps: 10, starters: [], tools: [], delegateIds: [], ...extra });
  async function anotherBot() {
    const [otherApp] = await db.insert(aiApps).values({ name: "Other managed", model: "mock-model", provider: "hermes", baseUrl: "http://127.0.0.1", providerConfig: { managed: config } }).returning();
    apps.push(otherApp.id);
    const [other] = await db.insert(bots).values({ name: "Other", ownerId: admin.user.id, appId: otherApp.id, visibility: "org" }).returning();
    await approveManagedBot(admin, otherApp.id, other.id);
    return other;
  }
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_profiles_test") throw new Error("Named disposable database required");
    for (const name of ["admin", "alice", "bob"]) {
      const id = newId(); ids.push(id);
      await db.insert(users).values({ id, name, upn: `${id}@example.invalid`, authSource: "ldap", isAdmin: name === "admin" });
    }
    admin = (await loadPrincipal(ids[0]))!; alice = (await loadPrincipal(ids[1]))!; bob = (await loadPrincipal(ids[2]))!;
  });
  beforeEach(async () => {
    await db.delete(hermesProvisions).where(inArray(hermesProvisions.userId, ids));
    await db.delete(hermesConnections).where(inArray(hermesConnections.userId, ids));
    await db.delete(conversations).where(inArray(conversations.userId, ids));
    await db.update(users).set({ disabled: false }).where(inArray(users.id, ids));
    mock = new ProvisioningMock(); vi.stubGlobal("fetch", mock.fetch);
    [app] = await db.insert(aiApps).values({ name: "Managed test", provider: "hermes", baseUrl: "http://127.0.0.1", model: "mock-model", providerConfig: { profile: "managed", managed: config } }).returning(); apps.push(app.id);
    [bot] = await db.insert(bots).values({ name: "Shared test", ownerId: admin.user.id, appId: app.id, visibility: "org", instructions: "Explicit test instructions" }).returning();
    await approveManagedBot(admin, app.id, bot.id);
    [app] = await db.select().from(aiApps).where(eq(aiApps.id, app.id));
    session.principal = admin;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(hermesProvisions).where(inArray(hermesProvisions.userId, ids));
    await db.delete(hermesConnections).where(inArray(hermesConnections.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
    await db.delete(aiApps).where(inArray(aiApps.id, apps));
    await pool.end();
  });
  it("rejects ordinary administration and isolates a shared bot for two users", async () => {
    await expect(registerConnection(alice, {})).rejects.toMatchObject({ status: 403 });
    await register(alice, 19000); await register(bob, 19002);
    const [a, b] = await Promise.all([ensureProfile(alice.user.id, bot.id, app.id), ensureProfile(bob.user.id, bot.id, app.id)]);
    expect(a.profile).not.toBe(b.profile); expect(a.connectionId).not.toBe(b.connectionId);
    const ta = await managedTarget(alice.user.id, bot.id, app.id, a.id), tb = await managedTarget(bob.user.id, bot.id, app.id, b.id);
    expect(ta.target.baseUrl).not.toBe(tb.target.baseUrl); expect(ta.target.apiKey).not.toBe(tb.target.apiKey);
    await expect(managedTarget(bob.user.id, bot.id, app.id, a.id)).rejects.toThrow("not ready");
    await expect(hermesTargetFor(app)).rejects.toThrow("owned user and bot binding");
  });
  it("serializes concurrent first use and keeps one profile across repeated requests", async () => {
    await register(alice, 19000);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => ensureProfile(alice.user.id, bot.id, app.id)));
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const row = await ensureProfile(alice.user.id, bot.id, app.id);
    expect(row.status).toBe("ready");
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "/api/profiles")).toHaveLength(1);
    expect((await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id)))).toHaveLength(1);
  });
  it("prevents cross-user listener reuse and limits concurrent provisioning across bots", async () => {
    await register(alice, 19000);
    await expect(register(bob, 19000)).rejects.toMatchObject({ status: 409 });
    const a = await ensureProfile(alice.user.id, bot.id, app.id);
    await db.update(hermesProvisions).set({ status: "provisioning", lease: "busy-worker", retryAfter: new Date(Date.now() + 60000) }).where(eq(hermesProvisions.id, a.id));
    const other = await anotherBot();
    await expect(ensureProfile(alice.user.id, other.id, other.appId!)).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id)))).toHaveLength(1);
  });
  it("retains partial creation, backoff and quota reservation across retries", async () => {
    await register(alice, 19000, 1); mock.loseCreateReply = true;
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 503 });
    const [failed] = await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id));
    expect(failed).toMatchObject({ status: "failed", createAttempted: true, attempts: 1 });
    expect(JSON.stringify(failed)).not.toContain("mock-secret-never-display");
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 409 });
    await db.update(hermesProvisions).set({ retryAfter: new Date(0) }).where(eq(hermesProvisions.id, failed.id));
    const ready = await ensureProfile(alice.user.id, bot.id, app.id);
    expect(ready.id).toBe(failed.id); expect(ready.profile).toBe(failed.profile); expect(ready.attempts).toBe(2);
    const otherBot = await anotherBot();
    await expect(ensureProfile(alice.user.id, otherBot.id, otherBot.appId!)).rejects.toMatchObject({ status: 429 });
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "/api/profiles")).toHaveLength(1);
  });
  it("keeps lifetime quota atomic when different bots race for the final slot", async () => {
    await register(alice, 19000, 1);
    const other = await anotherBot();
    const results = await Promise.allSettled([ensureProfile(alice.user.id, bot.id, app.id), ensureProfile(alice.user.id, other.id, other.appId!)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { status: 429 } }]);
    expect(await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id))).toHaveLength(1);
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "/api/profiles")).toHaveLength(1);
  });
  it("halts partial provisioning after access is revoked during the create request", async () => {
    await register(alice, 19000);
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const result = await mock.fetch(...args);
      if (args[1]?.method === "POST" && String(args[0]).endsWith("/api/profiles"))
        await db.update(bots).set({ visibility: "private" }).where(eq(bots.id, bot.id));
      return result;
    });
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 403 });
    const [row] = await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id));
    expect(row).toMatchObject({ status: "failed", createAttempted: true });
    expect(mock.calls.some((c) => c.method === "PUT" || c.path.endsWith("/v1/runs"))).toBe(false);
    expect(mock.profiles.size).toBe(1); // retained partial profile; no automatic cleanup
  });
  it("does not admit a run when serving readiness fails", async () => {
    await register(alice, 19000); mock.ready = false;
    const [conv] = await db.insert(conversations).values({ userId: alice.user.id, botId: bot.id }).returning();
    await expect(admitRun({ principal: alice, conversation: conv, bot, app, parentId: null })).rejects.toMatchObject({ status: 503 });
    expect(mock.calls.some((c) => c.path.endsWith("/v1/runs"))).toBe(false);
  });
  it("reclaims an expired worker lease without allocating a new identity", async () => {
    await register(alice, 19000);
    const a = await ensureProfile(alice.user.id, bot.id, app.id);
    await db.update(hermesProvisions).set({ status: "provisioning", lease: "dead-worker", retryAfter: new Date(0) }).where(eq(hermesProvisions.id, a.id));
    expect((await ensureProfile(alice.user.id, bot.id, app.id)).id).toBe(a.id);
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "/api/profiles")).toHaveLength(1);
  });
  it("rechecks revoked user, bot and app access, including already-resolved transports", async () => {
    const id = await register(alice, 19000); const a = await ensureProfile(alice.user.id, bot.id, app.id);
    const { target } = await managedTarget(alice.user.id, bot.id, app.id, a.id);
    await setConnectionEnabled(admin, id, false); const before = mock.calls.length;
    await expect(startRun(target, { input: "hi", sessionId: "s", idempotencyKey: "i" })).rejects.toThrow();
    expect(mock.calls).toHaveLength(before);
    await setConnectionEnabled(admin, id, true);
    await db.update(bots).set({ visibility: "private" }).where(eq(bots.id, bot.id));
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 403 });
    await db.update(bots).set({ visibility: "org" }).where(eq(bots.id, bot.id));
    await db.update(aiApps).set({ isPublic: false }).where(eq(aiApps.id, app.id));
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 403 });
    await db.update(aiApps).set({ isPublic: true }).where(eq(aiApps.id, app.id));
    await db.update(users).set({ disabled: true }).where(eq(users.id, alice.user.id));
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 403 });
  });
  it("binds admission, /new and approval resume to one profile while changing native sessions", async () => {
    await register(alice, 19000);
    const a = await ensureProfile(alice.user.id, bot.id, app.id);
    const [conv] = await db.insert(conversations).values({ userId: alice.user.id, botId: bot.id, isBotHome: true }).returning();
    const { target } = await managedTarget(alice.user.id, bot.id, app.id, a.id);
    await startRun(target, { input: "hello", sessionId: `portal-${conv.id}-${bot.id}`, idempotencyKey: "first" });
    const next = await freshConversation(alice, { conversationId: conv.id, bot, app, requireSource: true }, newId());
    const duplicate = await freshConversation(alice, { conversationId: conv.id, bot, app, requireSource: true }, newId());
    expect(duplicate.id).toBe(next.id); expect(next.id).not.toBe(conv.id);
    const [old] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(old.homeSuccessorId).toBe(next.id); expect(old.isBotHome).toBe(false);
    await startRun(target, { input: "fresh", sessionId: `portal-${next.id}-${bot.id}`, idempotencyKey: "second" });
    await answerApproval(target, "mock-run", "approval", "once");
    const run = await admitRun({ principal: alice, conversation: next, bot, app, parentId: null });
    const [context] = await db.select().from(hermesRunContexts).where(eq(hermesRunContexts.runId, run.id));
    expect(context.provisionId).toBe(a.id);
    const resolved = await resolveModel(app, { purpose: "chat", principal: alice, botId: bot.id, conversationId: next.id, interactive: true,
      run: { id: run.id, segment: 1, legacy: false, resumeState: null, hermes: context, saveResumeState() {} } });
    expect(resolved.billing.source).toBe("hermes");
    const sends = mock.calls.filter((c) => c.path.endsWith("/v1/runs"));
    expect(sends[0].path).toBe(sends[1].path); expect(sends[0].body.session_id).not.toBe(sends[1].body.session_id);
    expect((await ensureProfile(alice.user.id, bot.id, app.id)).id).toBe(a.id);
  });
  it("rejects foreign conversations, definition drift and unmanaged execution purposes", async () => {
    await register(alice, 19000); await ensureProfile(alice.user.id, bot.id, app.id);
    const [conv] = await db.insert(conversations).values({ userId: alice.user.id, botId: bot.id }).returning();
    await expect(assertManagedConversation(bob.user.id, bot.id, conv.id)).rejects.toMatchObject({ status: 403 });
    await expect(resolveModel(app, { purpose: "delegate", principal: alice, botId: bot.id, conversationId: conv.id })).rejects.toThrow("direct bot chats only");
    await db.update(bots).set({ instructions: "Changed" }).where(eq(bots.id, bot.id));
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 409 });
    const [row] = await db.select().from(hermesProvisions).where(and(eq(hermesProvisions.userId, alice.user.id), eq(hermesProvisions.botId, bot.id)));
    expect(row.status).toBe("ready");
  });
  it("encrypts with row AAD and retains profiles when chats/bots are deleted", async () => {
    const id = await register(alice, 19000); const a = await ensureProfile(alice.user.id, bot.id, app.id);
    const [c] = await db.select().from(hermesConnections).where(eq(hermesConnections.id, id));
    expect(c.credentialsEnc).not.toContain("synthetic-");
    expect(decrypt(c.credentialsEnc, connectionAAD(id))).toContain("synthetic-profile-key");
    expect(() => decrypt(c.credentialsEnc, connectionAAD("wrong-row"))).toThrow();
    await db.delete(bots).where(eq(bots.id, bot.id));
    expect((await db.select().from(hermesProvisions).where(eq(hermesProvisions.id, a.id)))).toHaveLength(1);
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("rejects assigned definition changes and deletion, retaining two users' profiles and metadata edits", async () => {
    await register(alice, 19000); await register(bob, 19002);
    const a = await ensureProfile(alice.user.id, bot.id, app.id), b = await ensureProfile(bob.user.id, bot.id, app.id);
    for (const change of [{ name: "Changed" }, { instructions: "Changed" }, { description: "Changed" }, { boundaries: "Changed" }])
      await expect(updateBot(bot.id, input(change))).rejects.toMatchObject({ status: 409 });
    await expect(deleteBot(bot.id)).rejects.toMatchObject({ status: 409 });
    await expect(deleteApp(app.id)).rejects.toMatchObject({ status: 409 });
    await updateBot(bot.id, input({ label: "New label", avatar: "blob:circle:blue", starters: ["Hello"] }));
    expect((await ensureProfile(alice.user.id, bot.id, app.id)).id).toBe(a.id);
    expect((await ensureProfile(bob.user.id, bot.id, app.id)).id).toBe(b.id);
  });
  it("allows metadata edits on retained definitions created with the original longer field limits", async () => {
    const original = { name: "N".repeat(100), instructions: "I".repeat(24000) };
    await db.update(bots).set(original).where(eq(bots.id, bot.id));
    await register(alice, 19000); const profile = await ensureProfile(alice.user.id, bot.id, app.id);
    await updateBot(bot.id, input({ ...original, label: "Metadata only" }));
    expect((await ensureProfile(alice.user.id, bot.id, app.id)).id).toBe(profile.id);
  });
  it("rolls back managed metadata and access together when a relation fails", async () => {
    const { botAccess, botTools, groups } = await import("@/db/schema");
    await register(alice, 19000);
    const profile = await ensureProfile(alice.user.id, bot.id, app.id);
    const [group] = await db.insert(groups).values({ name: "Managed rollback fixture" }).returning();
    try {
      await db.insert(botAccess).values({ botId: bot.id, groupId: group.id });
      await db.insert(botTools).values({ botId: bot.id, toolKey: "knowledge" });
      const [before] = await db.select().from(bots).where(eq(bots.id, bot.id));
      await expect(updateBot(bot.id, input({ label: "Must roll back", visibility: "groups", groupIds: [newId()] }))).rejects.toThrow();
      expect((await db.select().from(bots).where(eq(bots.id, bot.id)))[0]).toEqual(before);
      expect(await db.select().from(botAccess).where(eq(botAccess.botId, bot.id))).toMatchObject([{ groupId: group.id }]);
      expect(await db.select().from(botTools).where(eq(botTools.botId, bot.id))).toHaveLength(1);
      expect((await ensureProfile(alice.user.id, bot.id, app.id)).id).toBe(profile.id);
    } finally { await db.delete(groups).where(eq(groups.id, group.id)); }
  });
  it("rejects actual delegate and group turns before allocating a managed profile", async () => {
    const { botDelegates, conversationBots } = await import("@/db/schema");
    const { newUsageScope } = await import("@/lib/llm");
    const { buildToolset } = await import("@/lib/agent/toolset");
    const { admitDelegation } = await import("@/lib/delegation/store");
    const { runHost } = await import("@/lib/runs/host");
    const { runGroupTurn } = await import("@/lib/agent/group");
    const { getSetting } = await import("@/lib/settings");
    await register(alice, 19000);
    const before = mock.calls.length;
    const [sourceApp] = await db.insert(aiApps).values({ name: "Delegating model fixture", model: "mock", baseUrl: "http://127.0.0.1:1/v1", supportsTools: true }).returning();
    apps.push(sourceApp.id);
    const [source] = await db.insert(bots).values({ name: "Delegating source", ownerId: admin.user.id, appId: sourceApp.id, visibility: "org" }).returning();
    await db.insert(botDelegates).values({ botId: source.id, delegateBotId: bot.id });
    const [conversation] = await db.insert(conversations).values({ userId: alice.user.id, isGroup: true }).returning();
    await db.insert(conversationBots).values({ conversationId: conversation.id, botId: source.id, position: 0 });
    const ctx = { principal: alice, app: sourceApp, bot: source, conversationId: conversation.id, usage: newUsageScope({ messageId: newId() }), inGroup: true, depth: 0, background: false, toolSettings: await getSetting("tools") };
    const ts = await buildToolset(ctx);
    try {
      expect(ts.delegates.map(delegate => delegate.id)).not.toContain(bot.id);
      expect(ts.entries.find(entry => entry.key === `delegate:${bot.id}`)).toBeUndefined();
      await expect(admitDelegation(ctx, bot.id, "Hello", "managed-delegate", runHost().instanceId)).rejects.toMatchObject({ status: 403 });
      const { delegatedTasks } = await import("@/db/schema");
      expect(await db.select().from(delegatedTasks).where(eq(delegatedTasks.originConversationId, conversation.id))).toHaveLength(0);
    } finally { await ts.close(); }
    const userMessage = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "Hello" }] };
    await insertMessage(conversation.id, userMessage, null);
    const stream = await runGroupTurn({ principal: alice, conversation, members: [{ bot, app }], history: [userMessage] });
    const reader = stream.getReader(), chunks = [];
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
    expect(chunks.filter(c => c.type === "data-bot-error")).toMatchObject([{ data: { message: expect.stringContaining("direct bot chats only") } }]);
    expect(mock.calls).toHaveLength(before);
    expect(await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id))).toHaveLength(0);
  });
  it("fails a managed routine once without provisioning or duplicating execution", async () => {
    const { routines, routineRuns, inboxItems } = await import("@/db/schema");
    const { executeRoutineRun } = await import("@/lib/agent/routine-runner");
    const { executeRun } = await import("@/lib/runs/execute");
    await register(alice, 19000);
    const before = mock.calls.length;
    const [routine] = await db.insert(routines).values({ ownerId: alice.user.id, botId: bot.id, name: "Managed background fixture", prompt: "Hello", triggerType: "webhook" }).returning();
    const [run] = await db.insert(routineRuns).values({ routineId: routine.id, trigger: "manual" }).returning();
    await Promise.all([executeRoutineRun(run.id), executeRoutineRun(run.id)]);
    const agents = await db.select().from(agentRuns).where(eq(agentRuns.routineRunId, run.id));
    expect(agents).toHaveLength(1);
    await executeRun(agents[0].id);
    await executeRun(agents[0].id);
    expect((await db.select().from(agentRuns).where(eq(agentRuns.id, agents[0].id)))[0]).toMatchObject({ status: "failed", error: expect.stringContaining("direct bot chats only") });
    expect((await db.select().from(routineRuns).where(eq(routineRuns.id, run.id)))[0].status).toBe("failed");
    expect(await db.select().from(inboxItems).where(eq(inboxItems.routineRunId, run.id))).toHaveLength(1);
    expect(mock.calls).toHaveLength(before);
    expect(await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id))).toHaveLength(0);
  });
  it("requires admin approval for ordinary creation, copies, templates and existing unapproved bots", async () => {
    await register(bob, 19000, 1);
    const template = await createBotTemplate(bot.id);
    session.principal = alice;
    await expect(createBot(input({ name: "New managed bot" }))).rejects.toMatchObject({ status: 403 });
    await expect(duplicateBot(bot.id)).rejects.toMatchObject({ status: 403 });
    await expect(addBotFromTemplate(template.token)).rejects.toMatchObject({ status: 403 });
    const [copy] = await db.insert(bots).values({ name: "Legacy copy", ownerId: alice.user.id, appId: app.id, visibility: "org" }).returning();
    await expect(ensureProfile(bob.user.id, copy.id, app.id)).rejects.toMatchObject({ status: 403 });
    await expect(approveManagedBot(alice, app.id, copy.id)).rejects.toMatchObject({ status: 403 });
    await expect(approveManagedBot(admin, app.id, copy.id)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, bob.user.id))).toHaveLength(0);
    await ensureProfile(bob.user.id, bot.id, app.id);
  });
  it("requires explicit approval of a legacy definition without changing its retained identity", async () => {
    await register(alice, 19000); const assigned = await ensureProfile(alice.user.id, bot.id, app.id);
    const legacy = { ...app.providerConfig }; delete legacy.managedBotId;
    await db.update(aiApps).set({ providerConfig: legacy }).where(eq(aiApps.id, app.id));
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 403 });
    await db.update(bots).set({ name: "Accidental old edit" }).where(eq(bots.id, bot.id));
    await expect(approveManagedBot(admin, app.id, bot.id)).rejects.toMatchObject({ status: 409 });
    const original = { name: bot.name, description: bot.description, instructions: bot.instructions, boundaries: bot.boundaries };
    await expect(approveManagedBot(admin, app.id, bot.id, { ...original, instructions: "Guess" })).rejects.toMatchObject({ status: 409 });
    await expect(approveManagedBot(alice, app.id, bot.id, original)).rejects.toMatchObject({ status: 403 });
    await approveManagedBot(admin, app.id, bot.id, original);
    expect((await ensureProfile(alice.user.id, bot.id, app.id)).id).toBe(assigned.id);
  });
  it("reserves the definition read under the edit lock, not a stale pre-lock snapshot", async () => {
    await register(alice, 19000);
    let unlock!: () => void, acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const edit = db.transaction(async (tx) => { await lockBot(tx, bot.id); acquired(); await release; await tx.update(bots).set({ instructions: "New locked instructions" }).where(eq(bots.id, bot.id)); });
    await locked;
    const provisioning = ensureProfile(alice.user.id, bot.id, app.id);
    // Wait until provisioning has queued its reservation transaction behind the locked row.
    await new Promise((resolve) => setTimeout(resolve, 30)); unlock(); await edit;
    const row = await provisioning;
    const [saved] = await db.select().from(bots).where(eq(bots.id, bot.id));
    expect(row.specHash).toBe(profileSpec(app, saved).hash);
    await expect(updateBot(bot.id, input())).rejects.toMatchObject({ status: 409 });
  });
  it("preserves operator-action identity conflicts and never modifies the foreign profile", async () => {
    await register(alice, 19000); mock.loseCreateReply = true;
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 503 });
    const [p] = await db.select().from(hermesProvisions).where(eq(hermesProvisions.userId, alice.user.id));
    mock.profiles.get(`19000:${p.profile}`)!.description = "foreign-marker";
    await db.update(hermesProvisions).set({ retryAfter: new Date(0) }).where(eq(hermesProvisions.id, p.id));
    mock.calls.length = 0;
    await expect(ensureProfile(alice.user.id, bot.id, app.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("identity conflicts") });
    expect(mock.calls.every((c) => c.method === "GET")).toBe(true);
    const [after] = await db.select().from(hermesProvisions).where(eq(hermesProvisions.id, p.id));
    expect(after.error).toContain("operator"); expect(after.error).not.toContain("Retry after one minute");
  });
  it("distinguishes database outages from duplicate connections and validates token rotation", async () => {
    const tx = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("synthetic SQL and secret must not escape"));
    await expect(register(alice, 19000)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Database service") }); tx.mockRestore();
    const id = await register(alice, 19000);
    await expect(register(alice, 19002)).rejects.toMatchObject({ status: 409 });
    await expect(rotateDashboardToken(alice, id, "synthetic-new-dashboard")).rejects.toMatchObject({ status: 403 });
    for (const token of ["short", "synthetic-provider-key", `synthetic-profile-key-${alice.user.id}-0`, "synthetic-token-with\nnewline"])
      await expect(rotateDashboardToken(admin, id, token)).rejects.toMatchObject({ status: 400 });
    await rotateDashboardToken(admin, id, "synthetic-new-dashboard");
    const [c] = await db.select().from(hermesConnections).where(eq(hermesConnections.id, id));
    expect(JSON.parse(decrypt(c.credentialsEnc, connectionAAD(id))).dashboardToken).toBe("synthetic-new-dashboard");
  });
  it("keeps stored regeneration prompts and restores only new unsaved drafts on setup failures", async () => {
    const connection = await register(alice, 19000); await ensureProfile(alice.user.id, bot.id, app.id); session.principal = alice;
    const [conv] = await db.insert(conversations).values({ userId: alice.user.id, botId: bot.id }).returning();
    const user = { id: newId(), role: "user" as const, parts: [{ type: "text" as const, text: "Stored question" }] };
    const answer = { id: newId(), role: "assistant" as const, parts: [{ type: "text" as const, text: "Stored answer" }] };
    await insertMessage(conv.id, user, null); await insertMessage(conv.id, answer, user.id); await setConnectionEnabled(admin, connection, false);
    let responseBody: Record<string, unknown> = {};
    const chat = new Chat({ id: conv.id, messages: [user, answer], transport: new DefaultChatTransport({ api: "http://localhost/api/chat", fetch: async (_url, init) => {
      const response = await POST(new Request("http://localhost/api/chat", init)); responseBody = await response.clone().json(); return response;
    }, prepareSendMessagesRequest: ({ messages }) => ({ body: { conversationId: conv.id, regenerate: true, parentId: messages.at(-1)!.id } }) }) });
    await chat.regenerate({ messageId: answer.id });
    expect(responseBody.error).toContain("disabled"); expect(responseBody).not.toHaveProperty("unsavedMessageId"); expect(responseBody).not.toHaveProperty("unsaved");
    expect(chat.messages.at(-1)?.id).toBe(user.id);
    const draft = { ...user, id: newId() };
    const refused = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: conv.id, message: draft, parentId: answer.id }) }));
    expect(await refused.json()).toMatchObject({ unsavedMessageId: draft.id });
    for (const payload of [{ regenerate: true, parentId: newId() }, { regenerate: true, parentId: answer.id }, { message: user }]) {
      const res = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: conv.id, ...payload }) }));
      expect(await res.json()).not.toHaveProperty("unsavedMessageId");
    }
    expect(await db.select().from(messages).where(eq(messages.conversationId, conv.id))).toHaveLength(2);
  });
  it("refreshes authorization for every parallel readiness read with fewer redundant queries", async () => {
    const connection = await register(alice, 19000); const p = await ensureProfile(alice.user.id, bot.id, app.id);
    mock.calls.length = 0;
    const query = vi.spyOn(pool, "query");
    await managedTarget(alice.user.id, bot.id, app.id, p.id, true);
    const count = query.mock.calls.length; query.mockRestore();
    expect(mock.calls).toHaveLength(7); expect(count).toBeLessThan(53);
    console.log(`Managed ready verification: ${mock.calls.length} remote reads, ${count} database queries; authorization refreshed per request.`);
    mock.calls.length = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await mock.fetch(...args);
      if (String(args[0]).endsWith("/api/health")) await setConnectionEnabled(admin, connection, false);
      return response;
    });
    await expect(managedTarget(alice.user.id, bot.id, app.id, p.id, true)).rejects.toMatchObject({ status: 403 });
    expect(mock.calls.map((c) => c.path)).toEqual(["/api/health"]);
  });
  it("cancels a managed run without a local parked stream through its persisted profile", async () => {
    await register(alice, 19000); const p = await ensureProfile(alice.user.id, bot.id, app.id);
    const [conv] = await db.insert(conversations).values({ userId: alice.user.id, botId: bot.id }).returning();
    const run = await admitRun({ principal: alice, conversation: conv, bot, app, parentId: null });
    await db.update(hermesRunContexts).set({ upstreamRunId: "mock-run" }).where(eq(hermesRunContexts.runId, run.id));
    await db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.id, run.id));
    mock.calls.length = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await mock.fetch(...args);
      return String(args[0]).endsWith("/mock-run") ? Response.json({ run_id: "mock-run", status: "running" }) : response;
    });
    await stopProviderRun(run);
    expect(mock.calls.some((c) => c.path === `/p/${p.profile}/v1/runs/mock-run/stop`)).toBe(true);
    const [context] = await db.select().from(hermesRunContexts).where(eq(hermesRunContexts.runId, run.id));
    expect(context.stopState).toBe("pending");
    vi.stubGlobal("fetch", mock.fetch);
    await stopProviderRun(run);
    const [confirmed] = await db.select().from(hermesRunContexts).where(eq(hermesRunContexts.runId, run.id));
    expect(confirmed.stopState).toBe("confirmed");
    expect(mock.calls.some((c) => c.path === "/v1/runs/mock-run/stop")).toBe(false);
  });
});
