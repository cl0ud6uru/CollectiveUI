import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import type { AgentCtx } from "@/lib/agent/types";
import type { Tool } from "ai";
import { startMockLlm } from "./helpers/mock-llm";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal!, requireAdmin: async () => session.principal! }));
vi.mock("@/lib/jobs", () => ({ enqueue: vi.fn(), QUEUES: {}, enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn() }));
import { db, pool, schema as s } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { newId } from "@/lib/ids";
import { getSetting, setSetting } from "@/lib/settings";
import { configureCoordinator, createCoordinatorStarter, defaultCoordinator } from "@/lib/coordinator/store";
import { assertDelegationPath, authorizeDelegation, discoverDelegates, MAX_DELEGATION_CALLS } from "@/lib/coordinator/delegation";
import { buildToolset } from "@/lib/agent/toolset";
import { openBotHome } from "@/lib/chat/home";
import { newUsageScope } from "@/lib/llm";
import { runHost } from "@/lib/runs/host";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("coordinator on disposable Postgres and synthetic local model", () => {
  let admin: Principal, alice: Principal, bob: Principal;
  let app: typeof s.aiApps.$inferSelect;
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let groupId: string;
  const userIds: string[] = [];
  const apps: string[] = [];
  const handles: Awaited<ReturnType<typeof buildToolset>>[] = [];

  async function newBot(extra: Partial<typeof s.bots.$inferInsert> = {}) {
    const [bot] = await db.insert(s.bots).values({ ownerId: admin.user.id, name: "Specialist", appId: app.id, visibility: "org", ...extra }).returning();
    return bot;
  }
  async function setup() {
    const { id } = await createCoordinatorStarter(admin, { name: "Queen", appId: app.id });
    const [bot] = await db.select().from(s.bots).where(eq(s.bots.id, id));
    const home = await openBotHome(alice, id);
    const [run] = await db.insert(s.agentRuns).values({ userId: alice.user.id, conversationId: home.id, botId: bot.id, appId: app.id,
      messageId: newId(), status: "running", holder: runHost().instanceId }).returning();
    const ctx: AgentCtx = { principal: alice, conversationId: home.id, bot, app, depth: 0, background: false, toolSettings: await getSetting("tools"),
      usage: newUsageScope({ runId: run.id, messageId: run.messageId }), execution: { holder: runHost().instanceId, deadlineAt: Date.now() + 60_000, segment: 0 } };
    return ctx;
  }
  async function nestedContext(ctx: AgentCtx, bot: typeof s.bots.$inferSelect) {
    const { admitDelegation } = await import("@/lib/delegation/store");
    const { task } = await admitDelegation(ctx, bot.id, "Synthetic nested context", newId(), runHost().instanceId, "sync", "coordinator");
    const [run] = await db.select().from(s.agentRuns).where(eq(s.agentRuns.id, task.childRunId!));
    return { ...ctx, principal: (await loadPrincipal(ctx.principal.user.id))!, bot, conversationId: task.childConversationId!, taskId: task.id,
      depth: task.depth, delegationPath: task.ancestry, usage: newUsageScope({ runId: run.id, messageId: run.messageId }) };
  }
  async function toolset(ctx: AgentCtx) { const ts = await buildToolset(ctx); handles.push(ts); return ts; }
  async function invoke(tool: Tool, task = "Say hello") {
    const value = await tool.execute!({ task }, { toolCallId: newId(), messages: [], context: undefined });
    const values: Record<string, unknown>[] = [];
    if (value && typeof value === "object" && Symbol.asyncIterator in value)
      for await (const v of value as AsyncIterable<Record<string, unknown>>) values.push(v);
    return values;
  }
  async function entry(ctx: AgentCtx, id: string) { return (await toolset(ctx)).entries.find(e => e.key === `delegate:${id}`)!.tool; }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_coordinator_test") throw new Error("Isolated collective_coordinator_test DB required");
    mock = await startMockLlm();
    runHost().start();
    for (const name of ["Admin", "Alice", "Bob"]) {
      const [user] = await db.insert(s.users).values({ name, upn: `${newId()}@fixture.invalid`, authSource: "ldap", isAdmin: name === "Admin" }).returning();
      userIds.push(user.id);
      const p = (await loadPrincipal(user.id))!;
      if (name === "Admin") admin = p; else if (name === "Alice") alice = p; else bob = p;
    }
    [app] = await db.insert(s.aiApps).values({ name: "Synthetic native model", model: "mock", provider: "openai-compatible", baseUrl: `${mock.url}/v1`, supportsTools: true, isPublic: true }).returning();
    apps.push(app.id);
    const [group] = await db.insert(s.groups).values({ name: `Coordinator fixture ${newId()}` }).returning(); groupId = group.id;
    await db.insert(s.groupMappings).values({ groupId, source: "ldap", externalId: "coordinator-fixture" });
  });
  beforeEach(async () => {
    await Promise.all(handles.splice(0).map(h => h.close()));
    await db.delete(s.conversations).where(inArray(s.conversations.userId, userIds));
    await db.delete(s.settings).where(inArray(s.settings.key, ["coordinator", "tools", "sandbox"]));
    await db.delete(s.bots).where(inArray(s.bots.ownerId, userIds));
    await db.update(s.users).set({ disabled: false, sessionVersion: 0 }).where(inArray(s.users.id, userIds));
    await db.update(s.users).set({ isAdmin: true }).where(eq(s.users.id, admin.user.id));
    await db.delete(s.userExternalGroups).where(inArray(s.userExternalGroups.userId, userIds));
    await db.update(s.aiApps).set({ enabled: true, isPublic: true, provider: "openai-compatible", supportsTools: true }).where(eq(s.aiApps.id, app.id));
    session.principal = admin;
  });
  afterAll(async () => {
    await Promise.all(handles.map(h => h.close()));
    await runHost().shutdown(2000);
    const { runListener } = await import("@/lib/runs/listener");
    await runListener().close();
    if (userIds.length) await db.delete(s.users).where(inArray(s.users.id, userIds));
    if (apps.length) await db.delete(s.aiApps).where(inArray(s.aiApps.id, apps));
    if (groupId) await db.delete(s.groups).where(eq(s.groups.id, groupId));
    await db.delete(s.settings).where(inArray(s.settings.key, ["coordinator", "tools", "sandbox"]));
    mock?.stop(); await pool.end();
  });

  it("defaults off; concurrent starter retries preserve renamed identity, tools and no-model choice; deletion retains receipt", async () => {
    expect(await defaultCoordinator(alice)).toBeNull();
    const before = await getSetting("branding");
    const results = await Promise.all(Array.from({ length: 16 }, () => createCoordinatorStarter(admin, { name: "Queen", appId: null })));
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    const id = results[0].id;
    expect((await defaultCoordinator(alice))?.ready).toBe(false);
    expect(await getSetting("branding")).toEqual(before);
    expect(await db.select().from(s.botTools).where(eq(s.botTools.botId, id))).toHaveLength(0);
    await db.update(s.bots).set({ name: "Lloyd GPT", instructions: "Keep my personality", avatar: "🟣" }).where(eq(s.bots.id, id));
    await configureCoordinator(admin, { enabled: false, defaultBotId: null });
    expect(await createCoordinatorStarter(admin, { name: "Overwrite", appId: app.id })).toEqual({ id });
    const [saved] = await db.select().from(s.bots).where(eq(s.bots.id, id));
    expect(saved).toMatchObject({ name: "Lloyd GPT", instructions: "Keep my personality", avatar: "🟣", appId: null });
    expect((await getSetting("coordinator")).enabled).toBe(false);
    await db.delete(s.bots).where(eq(s.bots.id, id));
    await expect(createCoordinatorStarter(admin, { name: "Again", appId: null })).rejects.toMatchObject({ status: 409 });
  });

  it("requires a current admin even through server actions and rejects ineligible defaults", async () => {
    const { saveCoordinator, createQueenStarter } = await import("@/app/admin/coordinator-actions");
    session.principal = alice;
    await expect(saveCoordinator({ enabled: false, defaultBotId: null })).rejects.toMatchObject({ status: 403 });
    await expect(createQueenStarter({ name: "No", appId: null })).rejects.toMatchObject({ status: 403 });
    await db.update(s.users).set({ isAdmin: false }).where(eq(s.users.id, admin.user.id));
    await expect(createCoordinatorStarter(admin, { name: "Stale admin", appId: null })).rejects.toMatchObject({ status: 403 });
    await db.update(s.users).set({ isAdmin: true, sessionVersion: 1 }).where(eq(s.users.id, admin.user.id));
    await expect(configureCoordinator(admin, { enabled: false, defaultBotId: null })).rejects.toMatchObject({ status: 403 });
    await db.update(s.users).set({ sessionVersion: 0 }).where(eq(s.users.id, admin.user.id));
    for (const extra of [{ enabled: false }, { executionMode: "service" as const }]) {
      const bot = await newBot(extra);
      await expect(configureCoordinator(admin, { enabled: true, defaultBotId: bot.id })).rejects.toMatchObject({ status: 400 });
    }
    await expect(configureCoordinator(admin, { enabled: true, defaultBotId: "deleted" })).rejects.toMatchObject({ status: 400 });
    await expect(configureCoordinator(admin, { enabled: true, defaultBotId: null })).rejects.toMatchObject({ status: 400 });
  });

  it("audience, hidden, disabled, deleted and inaccessible-model defaults never grant access or pick a fallback", async () => {
    const bot = await newBot({ name: "Hidden coordinator marker", visibility: "private", ownerId: bob.user.id });
    await configureCoordinator(admin, { enabled: true, defaultBotId: bot.id });
    expect(await defaultCoordinator(alice)).toBeNull();
    expect(await defaultCoordinator(admin)).toBeNull(); // oversight is not an automatic audience grant
    await db.update(s.bots).set({ visibility: "groups" }).where(eq(s.bots.id, bot.id));
    await db.insert(s.botAccess).values({ botId: bot.id, groupId });
    await db.insert(s.userExternalGroups).values({ userId: alice.user.id, source: "ldap", externalId: "coordinator-fixture" });
    expect((await defaultCoordinator(alice))?.bot.id).toBe(bot.id); // refresh membership
    await db.insert(s.userBotPrefs).values({ userId: alice.user.id, botId: bot.id, hidden: true });
    expect(await defaultCoordinator(alice)).toBeNull();
    await db.delete(s.userBotPrefs).where(eq(s.userBotPrefs.botId, bot.id));
    await db.update(s.aiApps).set({ isPublic: false }).where(eq(s.aiApps.id, app.id));
    expect((await defaultCoordinator(alice))?.ready).toBe(false);
    await db.update(s.aiApps).set({ provider: "hermes" }).where(eq(s.aiApps.id, app.id));
    expect(await defaultCoordinator(alice)).toBeNull();
    await db.update(s.aiApps).set({ provider: "openai-compatible", isPublic: true }).where(eq(s.aiApps.id, app.id));
    await db.update(s.bots).set({ enabled: false }).where(eq(s.bots.id, bot.id));
    expect(await defaultCoordinator(alice)).toBeNull();
    await db.delete(s.bots).where(eq(s.bots.id, bot.id));
    expect(await defaultCoordinator(alice)).toBeNull();
  });

  it("selecting an existing bot changes no profile or prior homes; different people keep isolated homes", async () => {
    const first = await setup();
    const bot = await newBot({ name: "Lloyd GPT", instructions: "Keep", avatar: "🟣" });
    const home = await openBotHome(alice, bot.id);
    const other = await openBotHome(bob, bot.id);
    await configureCoordinator(admin, { enabled: true, defaultBotId: bot.id });
    expect((await defaultCoordinator(alice))?.bot).toEqual(bot);
    expect((await openBotHome(alice, bot.id)).id).toBe(home.id);
    expect((await openBotHome(bob, bot.id)).id).toBe(other.id);
    expect(home.id).not.toBe(other.id);
    expect((await openBotHome(alice, first.bot!.id)).id).toBe(first.conversationId);
    const { getOwnedConversation } = await import("@/lib/authz");
    await expect(getOwnedConversation({ ...bob, isAdmin: true }, home.id)).rejects.toMatchObject({ status: 404 });
  });

  it("automatic discovery is explicit, native and audience scoped while manual opt-out targets still work", async () => {
    const ctx = await setup();
    const yes = await newBot({ coordinatorEligible: true });
    const manual = await newBot({ name: "Manual", coordinatorEligible: false });
    await db.insert(s.botDelegates).values({ botId: ctx.bot!.id, delegateBotId: manual.id });
    await newBot({ name: "No opt in" });
    await newBot({ name: "Private secret", coordinatorEligible: true, visibility: "private" });
    await newBot({ name: "Disabled", coordinatorEligible: true, enabled: false });
    await newBot({ name: "Service", coordinatorEligible: true, executionMode: "service" });
    const [hermes] = await db.insert(s.aiApps).values({ name: "Synthetic managed Hermes", provider: "hermes", model: "mock", providerConfig: { managed: { provisionId: "fixture" } }, baseUrl: "http://127.0.0.1:1", supportsTools: true }).returning(); apps.push(hermes.id);
    const managed = await newBot({ name: "Managed", appId: hermes.id, coordinatorEligible: true });
    await db.insert(s.botDelegates).values({ botId: ctx.bot!.id, delegateBotId: managed.id });
    expect((await discoverDelegates(ctx)).map(c => [c.bot.id, c.mode])).toEqual([[manual.id, "manual"], [yes.id, "coordinator"]]);
    await configureCoordinator(admin, { enabled: false, defaultBotId: null });
    expect((await discoverDelegates(ctx)).map(c => c.bot.id)).toEqual([manual.id]);
    expect((await invoke(await entry(ctx, manual.id))).at(-1)?.status).toBe("done");
  });

  it("rechecks opt-in, default, source, target, session and model rights after discovery before dispatch", async () => {
    const ctx = await setup();
    const target = await newBot({ coordinatorEligible: true });
    const cases = [
      [async () => db.update(s.bots).set({ coordinatorEligible: false }).where(eq(s.bots.id, target.id)), async () => db.update(s.bots).set({ coordinatorEligible: true }).where(eq(s.bots.id, target.id))],
      [async () => configureCoordinator(admin, { enabled: false, defaultBotId: null }), async () => configureCoordinator(admin, { enabled: true, defaultBotId: ctx.bot!.id })],
      [async () => db.update(s.bots).set({ enabled: false }).where(eq(s.bots.id, ctx.bot!.id)), async () => db.update(s.bots).set({ enabled: true }).where(eq(s.bots.id, ctx.bot!.id))],
      [async () => db.update(s.bots).set({ visibility: "private" }).where(eq(s.bots.id, target.id)), async () => db.update(s.bots).set({ visibility: "org" }).where(eq(s.bots.id, target.id))],
      [async () => db.update(s.users).set({ sessionVersion: 1 }).where(eq(s.users.id, alice.user.id)), async () => db.update(s.users).set({ sessionVersion: 0 }).where(eq(s.users.id, alice.user.id))],
      [async () => db.update(s.aiApps).set({ isPublic: false }).where(eq(s.aiApps.id, app.id)), async () => db.update(s.aiApps).set({ isPublic: true }).where(eq(s.aiApps.id, app.id))],
    ];
    for (const [revoke, restore] of cases) {
      const stale = await entry(ctx, target.id);
      await revoke(); expect((await invoke(stale))[0]?.status).toBe("error"); await restore();
    }
    const stale = await entry(ctx, target.id);
    await db.delete(s.bots).where(eq(s.bots.id, target.id));
    expect((await invoke(stale))[0]?.status).toBe("error");
  });

  it("enforces human-owned direct sources, nested cycles/depth and a shared call budget", async () => {
    const ctx = await setup();
    const target = await newBot({ coordinatorEligible: true });
    const edge = { from: ctx.bot!.id, to: target.id, mode: "coordinator" as const };
    for (const change of [{ background: true }, { inGroup: true }, { principal: bob }])
      await expect(authorizeDelegation({ ...ctx, ...change }, target.id, "coordinator")).rejects.toMatchObject({ status: 403 });
    for (const change of [{ source: "routine" as const }, { isGroup: true }, { archived: true }]) {
      // A side chat can represent each unsupported source without violating the home table constraint.
      const [conv] = await db.insert(s.conversations).values({ userId: alice.user.id, botId: ctx.bot!.id, ...change }).returning();
      await expect(authorizeDelegation({ ...ctx, conversationId: conv.id }, target.id, "coordinator")).rejects.toMatchObject({ status: 403 });
    }
    const nested = { ...ctx, bot: target, depth: 1, delegationPath: [edge] };
    await db.insert(s.botDelegates).values({ botId: target.id, delegateBotId: ctx.bot!.id });
    await expect(authorizeDelegation(nested, ctx.bot!.id, "manual")).rejects.toMatchObject({ status: 403 });
    await expect(assertDelegationPath({ ...nested, depth: 2 })).rejects.toMatchObject({ status: 403 });
    expect(await discoverDelegates({ ...nested, depth: 2 })).toEqual([]);
    const tool = await entry(ctx, target.id);
    for (let i = 0; i < MAX_DELEGATION_CALLS; i++) expect((await invoke(tool, `Assignment ${i}`)).at(-1)?.status).toBe("done");
    expect((await invoke(tool)).at(-1)?.error).toMatch(/budget/);
    expect(MAX_DELEGATION_CALLS).toBe(8);
  });

  it("nested builtins fail closed when bot tools, enforced approvals, grants or workspace policy change", async () => {
    const ctx = await setup();
    const target = await newBot({ coordinatorEligible: true });
    await db.insert(s.botTools).values({ botId: target.id, toolKey: "memory" });
    const nested = await nestedContext(ctx, target);
    const readTool = async () => (await toolset(nested)).entries.find(e => e.key === "memory")!.tool;
    async function collect(tool: Tool) {
      const result = await tool.execute!({ fact: "Private fixture", shared: false }, { toolCallId: newId(), messages: [], context: undefined });
      if (result && typeof result === "object" && Symbol.asyncIterator in result) for await (const v of result as AsyncIterable<unknown>) void v;
    }
    await collect(await readTool());
    expect(await db.select().from(s.memories).where(eq(s.memories.userId, alice.user.id))).toHaveLength(1);
    await db.delete(s.memories).where(eq(s.memories.userId, alice.user.id));
    const cases = [
      async () => db.delete(s.botTools).where(eq(s.botTools.botId, target.id)),
      async () => setSetting("tools", { ...ctx.toolSettings, enforcedApproval: ["memory"] }),
      async () => db.insert(s.toolGrants).values({ userId: alice.user.id, botId: target.id, toolName: "remember" }),
      async () => setSetting("sandbox", { ...await getSetting("sandbox"), allowedGroupIds: [groupId] }),
    ];
    for (const mutate of cases) {
      await db.insert(s.botTools).values({ botId: target.id, toolKey: "memory" }).onConflictDoNothing();
      await db.delete(s.settings).where(inArray(s.settings.key, ["tools", "sandbox"]));
      await db.delete(s.toolGrants).where(eq(s.toolGrants.botId, target.id));
      const stale = await readTool(); await mutate();
      await expect(collect(stale)).rejects.toMatchObject({ status: 403 });
    }
    // A stale captured tool policy cannot be legitimized by a freshly calculated DB binding.
    await setSetting("tools", { ...ctx.toolSettings, disabledTools: ["memory"] });
    const staleStart = await readTool();
    await expect(collect(staleStart)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(s.memories).where(eq(s.memories.userId, alice.user.id))).toHaveLength(0);
  });

  it("automatic delegates gain no private MCP rights and group revocation removes discovery and dispatch", async () => {
    const ctx = await setup();
    const target = await newBot({ coordinatorEligible: true, visibility: "groups" });
    await db.insert(s.botAccess).values({ botId: target.id, groupId });
    await db.insert(s.userExternalGroups).values({ userId: alice.user.id, source: "ldap", externalId: "coordinator-fixture" });
    const [server] = await db.insert(s.mcpServers).values({ name: "Private fixture MCP", url: "http://127.0.0.1:1/mcp", isPublic: false, status: "enabled",
      toolsSnapshot: [{ name: "secret", inputSchema: { type: "object", properties: {} } }] }).returning();
    try {
      await db.insert(s.botTools).values({ botId: target.id, toolKey: `mcp:${server.id}` });
      const nested = await nestedContext(ctx, target);
      expect((await toolset(nested)).entries.filter(e => e.key.startsWith("mcp:"))).toEqual([]);
      const stale = await entry(ctx, target.id);
      await db.delete(s.userExternalGroups).where(eq(s.userExternalGroups.userId, alice.user.id));
      expect((await discoverDelegates(ctx)).map(c => c.bot.id)).not.toContain(target.id);
      expect((await invoke(stale))[0]?.status).toBe("error");
    } finally { await db.delete(s.mcpServers).where(eq(s.mcpServers.id, server.id)); }
  });

  it("the durable executor commits specialist output and synthesizes it into the owner's persisted reply", async () => {
    const ctx = await setup();
    const specialist = await newBot({ name: "Research", coordinatorEligible: true });
    const tool = (await toolset(ctx)).entries.find(e => e.key === `delegate:${specialist.id}`)!;
    const { executeRun } = await import("@/lib/runs/execute");
    const { getRun } = await import("@/lib/runs/state");
    const [conversation] = await db.select().from(s.conversations).where(eq(s.conversations.id, ctx.conversationId));
    const id = newId();
    const question = `[tool:${tool.name} ${JSON.stringify({ task: "Return synthetic finding 4927" })}]`;
    await db.insert(s.messages).values({ id, conversationId: conversation.id, role: "user", parts: [{ type: "text", text: question }], searchText: question });
    await db.update(s.conversations).set({ currentLeafId: id }).where(eq(s.conversations.id, conversation.id));
    await db.update(s.agentRuns).set({ status: "queued", holder: null, parentMessageId: id }).where(eq(s.agentRuns.id, ctx.usage!.runId!));
    await executeRun(ctx.usage!.runId!);
    expect(await getRun(ctx.usage!.runId!)).toMatchObject({ status: "succeeded", error: null });
    const replies = await db.select().from(s.messages).where(and(eq(s.messages.conversationId, conversation.id), eq(s.messages.role, "assistant")));
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies)).toContain("4927");
    expect(JSON.stringify(replies)).toContain('"status":"done"');
    const [task] = await db.select().from(s.delegatedTasks).where(eq(s.delegatedTasks.parentRunId, ctx.usage!.runId!));
    expect(task.ancestry).toEqual([{ from: ctx.bot!.id, to: specialist.id, mode: "coordinator" }]);
    expect(task.returnedAt).not.toBeNull();
  });
});
