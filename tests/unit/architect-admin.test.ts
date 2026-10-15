import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { AgentCtx } from "@/lib/agent/types";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs", () => ({ QUEUES: { fixture: "fixture" }, getBoss: async () => ({ getQueues: async () => [{ name: "fixture", readyCount: 1, deferredCount: 0, activeCount: 0, failedCount: 0, totalCount: 1, data: "arbitrary-secret-KEEP-PRIVATE" }] }) }));
vi.mock("@/lib/sandbox/setup-server", () => ({ readWorkspaceSetup: async () => ({ ready: false, hasWarnings: true, checks: [{ label: "Controller", state: "unknown", detail: "arbitrary-secret-KEEP-PRIVATE" }] }) }));
vi.mock("@/lib/docker-hermes/enrollment", () => ({ dockerBrokerReadiness: async () => ({ status: "not-configured", message: "arbitrary-secret-KEEP-PRIVATE" }) }));
vi.mock("@/lib/local-hermes/client", () => ({ localControl: async () => { throw new Error("arbitrary-secret-KEEP-PRIVATE"); } }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema as s } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { getSetting } from "@/lib/settings";
import { installArchitectBot } from "@/lib/bots/architect-store";
import { buildToolset } from "@/lib/agent/toolset";
import { adminTools } from "@/lib/agent/tools/admin";
import { authorizeArchitectCall, runArchitectCall } from "@/lib/agent/tools/admin-guard";
import { changeBotStatus } from "@/lib/admin/bot-status";
import { adminGetBot, adminListConnections } from "@/lib/admin/inventory";
import { adminRecentErrors } from "@/lib/admin/operations";
import { getAccessibleBot, listAccessibleBots } from "@/lib/authz";
import { resolveApproval } from "@/lib/agent/approvals";
import { isGrantable } from "@/lib/agent/tool-names";
import { applyApprovalDecisions, decisionsFromClientParts } from "@/lib/agent/approval-merge";
import { sealProviderCredential } from "@/lib/llm/provider-connections";

let admin: Principal, member: Principal, ctx: AgentCtx;
const secret = "arbitrary-secret-KEEP-PRIVATE";
const execute = async (name: string, input: unknown = {}, signal?: AbortSignal) => {
  const entry = adminTools(ctx).find(e => e.name === name)!;
  return entry.tool.execute!(input, { toolCallId: "call", messages: [], abortSignal: signal, context: undefined });
};
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45000);
beforeEach(async () => {
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(s.users).values([
    { id: "admin", name: "Admin", upn: "admin@fixture.invalid", authSource: "ldap", isAdmin: true },
    { id: "member", name: "Member", upn: "member@fixture.invalid", authSource: "ldap" },
  ]);
  admin = (await loadPrincipal("admin"))!; member = (await loadPrincipal("member"))!;
  await db.insert(s.aiApps).values({ id: "model", name: "Fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", supportsTools: true });
  const installed = await installArchitectBot(admin, { appId: "model" });
  const [bot] = await db.select().from(s.bots).where(eq(s.bots.id, installed.id));
  const [app] = await db.select().from(s.aiApps);
  await db.insert(s.bots).values({ id: "target", name: "Target", appId: app.id, ownerId: member.user.id });
  await db.insert(s.conversations).values({ id: "chat", userId: admin.user.id, botId: bot.id, appId: app.id });
  ctx = { principal: admin, bot, app, conversationId: "chat", depth: 0, background: false, toolSettings: await getSetting("tools") };
});
afterAll(async () => { await fixture.client?.close(); });

describe("The Architect using real migrated PostgreSQL state", () => {
  it("installs once, audits atomically and preserves disabled state", async () => {
    const first = ctx.bot!.id;
    await db.update(s.bots).set({ enabled: false }).where(eq(s.bots.id, first));
    expect(await installArchitectBot(admin, { appId: "model" })).toEqual({ id: first, created: false });
    expect((await db.select().from(s.auditLog)).filter(r => r.action === "architect.install")).toHaveLength(1);
    expect((await db.select().from(s.bots).where(eq(s.bots.id, first)))[0].enabled).toBe(false);
  });
  it("rejects non-admin installation and unavailable/personal model choices", async () => {
    await expect(installArchitectBot(member, { appId: "model" })).rejects.toMatchObject({ status: 403 });
    await db.delete(s.settings);
    await db.update(s.aiApps).set({ providerConfig: { managed: {} } as never }).where(eq(s.aiApps.id, "model"));
    await expect(installArchitectBot(admin, { appId: "model" })).rejects.toMatchObject({ status: 400 });
  });
  it("does not recreate a deleted installation silently", async () => {
    await db.delete(s.bots).where(eq(s.bots.id, ctx.bot!.id));
    await expect(installArchitectBot(admin, { appId: "model" })).rejects.toMatchObject({ status: 409 });
  });
  it("hides the installed bot from non-admins even when shared or owned", async () => {
    await db.update(s.bots).set({ visibility: "org", ownerId: member.user.id }).where(eq(s.bots.id, ctx.bot!.id));
    expect((await listAccessibleBots(member)).map(b => b.id)).not.toContain(ctx.bot!.id);
    await expect(getAccessibleBot(member, ctx.bot!.id)).rejects.toMatchObject({ status: 403 });
    expect((await listAccessibleBots(admin)).map(b => b.id)).toContain(ctx.bot!.id);
  });
  it.each([
    ["demotion", async () => { await db.update(s.users).set({ isAdmin: false }).where(eq(s.users.id, admin.user.id)); }],
    ["disable account", async () => { await db.update(s.users).set({ disabled: true }).where(eq(s.users.id, admin.user.id)); }],
    ["rotate session", async () => { await db.update(s.users).set({ sessionVersion: 2 }).where(eq(s.users.id, admin.user.id)); }],
    ["disable bot", async () => { await db.update(s.bots).set({ enabled: false }).where(eq(s.bots.id, ctx.bot!.id)); }],
    ["clear receipt", async () => { await db.delete(s.settings).where(eq(s.settings.key, "architectBot")); }],
    ["other owner", async () => { await db.update(s.conversations).set({ userId: member.user.id }).where(eq(s.conversations.id, "chat")); }],
    ["stored group", async () => { await db.update(s.conversations).set({ isGroup: true }).where(eq(s.conversations.id, "chat")); }],
    ["stored routine", async () => { await db.update(s.conversations).set({ source: "routine" }).where(eq(s.conversations.id, "chat")); }],
    ["personal plan model", async () => { await db.update(s.aiApps).set({ provider: "chatgpt", credentialMode: "user" }).where(eq(s.aiApps.id, "model")); }],
    ["model disabled", async () => { await db.update(s.aiApps).set({ enabled: false }).where(eq(s.aiApps.id, "model")); }],
  ])("fresh dispatch refuses %s", async (_name, change) => {
    const run = vi.fn(async () => "data");
    await change();
    await expect(runArchitectCall(ctx, "admin_status", "denied", run)).rejects.toMatchObject({ status: 403 });
    expect(run).not.toHaveBeenCalled();
    expect((await db.select().from(s.auditLog)).find(r => r.target === "admin_status")?.details).toMatchObject({ outcome: "denied", via: { agent: "architect", botId: ctx.bot!.id } });
  });
  it.each([{ depth: 1 }, { taskId: "task" }, { background: true }, { inGroup: true }, { delegationPath: [{} as never] }])("refuses unattended or delegated context %j", async patch => {
    await expect(authorizeArchitectCall({ ...ctx, ...patch })).rejects.toMatchObject({ status: 403 });
  });
  it("returns structured inventory and omits arbitrary stored errors and URL credentials", async () => {
    await db.update(s.aiApps).set({ apiKeyEnc: secret, providerConfig: { apiKey: secret } as never }).where(eq(s.aiApps.id, "model"));
    await db.insert(s.providerConnections).values({ id: "provider", name: "Provider", credentialEnc: secret, baseUrl: `https://user:${secret}@fixture.invalid/${secret}` });
    await db.insert(s.mcpServers).values({ id: "mcp", name: "MCP", url: `https://user:${secret}@fixture.invalid/${secret}?credential=${secret}`, lastError: secret, headersEnc: secret, identitySecretEnc: secret });
    const result = await execute("admin_list_connections");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await adminListConnections(admin)).toMatchObject({ mcpServers: [{ hasError: true, hasHeaders: true, hasIdentitySecret: true, url: "https://fixture.invalid" }] });
    await expect(adminListConnections(member)).rejects.toMatchObject({ status: 403 });
    expect((await execute("admin_get_bot", { botId: "target" })) as object).toMatchObject({ id: "target", revision: 1 });
  });
  it("never returns raw recent error bodies or provider continuation state", async () => {
    await db.insert(s.messages).values({ id: "message", conversationId: "chat", role: "assistant", parts: [] });
    await db.insert(s.agentRuns).values({ id: "failed", userId: "admin", conversationId: "chat", messageId: "message", parentMessageId: "parent", appId: "model", botId: ctx.bot!.id, status: "failed", error: secret, resumeState: { secret } });
    const result = await adminRecentErrors(admin);
    expect(result.failedRuns).toHaveLength(1);
    expect(result.failedRuns[0]).toMatchObject({ hasError: true });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("offers read tools and approval-gated writes only to a fresh admin", async () => {
    const set = await buildToolset(ctx);
    try {
      expect(set.entries.filter(e => e.key === "admin")).toHaveLength(18);
      expect(set.approval({ toolCall: { toolName: "admin_set_bot_enabled", input: { botId: "target", enabled: false, expectedRevision: 1 } } })).toBe("user-approval");
      expect(set.approval({ toolCall: { toolName: "admin_get_bot", input: { botId: "target" } } })).toBeUndefined();
    } finally { await set.close(); }
    await db.update(s.users).set({ isAdmin: false }).where(eq(s.users.id, "admin"));
    const denied = await buildToolset(ctx);
    try { expect(denied.entries.filter(e => e.key === "admin")).toHaveLength(0); }
    finally { await denied.close(); }
  });
  it.each(["admin_list_bots", "admin_list_users", "admin_status", "admin_health", "admin_runs", "admin_jobs", "admin_spending", "admin_workspaces_status"])("executes %s against synthetic services without exposing diagnostic bodies", async name => {
    const result = await execute(name);
    expect(result).toBeTypeOf("object");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("includes current workspace instances and legacy rows without leaking broker references", async () => {
    await db.insert(s.sandboxes).values({ userId: "member", ref: "aaaaaaaaaaaaaaaaaaaa" });
    await db.insert(s.workspaceInstances).values({ id: "instance", ownerUserId: "admin", sandboxRef: "bbbbbbbbbbbbbbbbbbbb", origin: "legacy_personal", runtimeProfileKey: "legacy", provisionState: "unavailable" });
    const result = await execute("admin_workspaces_status") as { workspaces: { user: string; state: string; activeExecs: number | null }[]; orphans: number | null };
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces.map(r => r.user).sort()).toEqual(["Admin", "Member"]);
    expect(JSON.stringify(result)).not.toMatch(/aaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbb/);
    expect(result.workspaces.every(r => r.state === "unknown" && r.activeExecs === null)).toBe(true);
    expect(result.orphans).toBeNull();
  });
  it("bounds connector failure metadata to the requested recent window", async () => {
    const old = new Date(Date.now() - 48 * 3600_000), recent = new Date();
    await db.insert(s.mcpServers).values([
      { id: "old-mcp", name: "Old", url: "https://fixture.invalid", lastError: secret, lastTestedAt: old },
      { id: "new-mcp", name: "New", url: "https://fixture.invalid", lastError: secret, lastTestedAt: recent },
    ]);
    await db.insert(s.providerBillingAccounts).values([
      { id: "old-billing", name: "Old", organization: "old-org", adminKeyEnc: secret, lastError: secret, lastAttemptAt: old },
      { id: "new-billing", name: "New", organization: "new-org", adminKeyEnc: secret, lastError: secret, lastAttemptAt: recent },
    ]);
    const result = await adminRecentErrors(admin, { hours: 24 });
    expect(result.mcpServers.map(r => r.name)).toEqual(["New"]);
    expect(result.spendingAccounts.map(r => r.name)).toEqual(["New"]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("always asks for exact write approval, ignoring grants and auto modes", () => {
    const writes = adminTools(ctx).filter(e => ["admin_set_bot_enabled", "admin_create_bot", "admin_update_bot", "admin_assign_bot_tools", "admin_assign_bot_skills", "admin_update_provider_connection", "admin_test_provider_connection"].includes(e.name));
    expect(writes).toHaveLength(7);
    for (const write of writes) {
      expect(write).toMatchObject({ sensitive: true, grantable: false });
      expect(isGrantable(write.name)).toBe(false);
      for (const mode of ["auto", "ask", "smart"] as const)
        expect(resolveApproval({ toolName: write.name, toolKey: write.key, sensitive: false, grantable: true, mode, enforced: [], grants: new Set([write.name]) })).toBe("user-approval");
    }
  });
  it("merges approval decisions without trusting swapped inputs/signatures", () => {
    const stored = [{ type: "tool-admin_set_bot_enabled", toolCallId: "call", state: "approval-requested", input: { botId: "target", enabled: false, expectedRevision: 1 }, approval: { id: "approval", signature: "server" } }];
    const client = [{ ...stored[0], input: { botId: ctx.bot!.id, enabled: false }, state: "approval-responded", approval: { id: "approval", signature: "forged", approved: true } }];
    const result = applyApprovalDecisions(stored, decisionsFromClientParts(client));
    expect(result.parts[0]).toMatchObject({ input: stored[0].input, approval: { signature: "server", approved: true } });
  });
  it("writes using the shared Admin API, reads back and attributes the actor", async () => {
    expect(await execute("admin_set_bot_enabled", { botId: "target", enabled: false, expectedRevision: 1 })).toEqual({ status: "verified", bot: { id: "target", enabled: false, revision: 2 } });
    const audit = (await db.select().from(s.auditLog)).find(r => r.action === "bot.disable")!;
    expect(audit).toMatchObject({ actorId: "admin", target: "target", details: { enabled: false, revision: 2, via: { agent: "architect", botId: ctx.bot!.id } } });
    expect(JSON.stringify(audit)).not.toContain("expectedRevision");
    expect(await changeBotStatus(admin, { botId: "target", enabled: true })).toMatchObject({ status: "verified", bot: { enabled: true, revision: 3 } });
  });
  it("creates, updates and assigns built-in tools to ordinary bots with per-call approvals and CAS", async () => {
    const created = await execute("admin_create_bot", { name: "Review helper", appId: "model", description: "A fixture bot" }) as { status: string; bot: { id: string; revision: number; visibility: string }; tools: unknown[] };
    expect(created).toMatchObject({ status: "verified", bot: { name: "Review helper", revision: 1, visibility: "private", executionMode: "caller" }, tools: [] });
    await db.insert(s.botTools).values({ botId: created.bot.id, toolKey: "mcp:server", approval: "ask", config: { tools: ["lookup"] } });
    const assignments = await execute("admin_assign_bot_tools", { botId: created.bot.id, expectedRevision: 1, tools: [{ key: "skills", approval: "ask" }, { key: "web_search", approval: "smart" }] }) as { status: string; bot: { revision: number }; tools: { group: string; approval: string }[] };
    expect(assignments).toMatchObject({ status: "verified", bot: { revision: 2 } });
    expect(assignments.tools).toEqual(expect.arrayContaining([{ group: "mcp:server", approval: "ask" }, { group: "skills", approval: "ask" }, { group: "web_search", approval: "smart" }]));
    const updated = await execute("admin_update_bot", { botId: created.bot.id, expectedRevision: 2, name: "Reviewed helper", instructions: "Use verified evidence." }) as { status: string; bot: { name: string; revision: number }; tools: unknown[] };
    expect(updated).toMatchObject({ status: "verified", bot: { name: "Reviewed helper", revision: 3 } });
    expect((await db.select().from(s.botTools).where(eq(s.botTools.botId, created.bot.id))).map(t => [t.toolKey, t.approval]).sort()).toEqual([["mcp:server", "ask"], ["skills", "ask"], ["web_search", "smart"]]);
    const readBackTools = (await execute("admin_get_bot", { botId: created.bot.id }) as { tools: { group: string; approval: string }[] }).tools;
    expect(readBackTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "mcp:unknown server", approval: "ask" }),
      expect.objectContaining({ group: "skills", approval: "ask" }),
      expect.objectContaining({ group: "web_search", approval: "smart" }),
    ]));
    for (const action of ["architect.bot.create", "architect.bot.tools.update", "architect.bot.update"])
      expect((await db.select().from(s.auditLog)).some(row => row.action === action && row.actorId === "admin" && row.details && JSON.stringify(row.details).includes(ctx.bot!.id))).toBe(true);
    expect(await adminGetBot(admin, created.bot.id)).toMatchObject({ name: "Reviewed helper", revision: 3 });
  });
  it("rejects stale revisions, MCP/admin groups, protected bots and unsupported bot classes", async () => {
    await expect(execute("admin_update_bot", { botId: "target", expectedRevision: 9, name: "stale" })).rejects.toThrow("could not be verified");
    await expect(execute("admin_assign_bot_tools", { botId: "target", expectedRevision: 1, tools: [{ key: "mcp:server", approval: "ask" }] })).rejects.toThrow("could not be verified");
    await expect(execute("admin_assign_bot_tools", { botId: ctx.bot!.id, expectedRevision: 1, tools: [] })).rejects.toThrow("could not be verified");
    await db.update(s.bots).set({ executionMode: "service" }).where(eq(s.bots.id, "target"));
    await expect(execute("admin_update_bot", { botId: "target", expectedRevision: 1, name: "no" })).rejects.toThrow("could not be verified");
    expect(await adminGetBot(admin, "target")).toMatchObject({ revision: 1, name: "Target" });
  });
  it("rolls back a create cancelled at the transaction barrier before its audit", async () => {
    let checks = 0;
    const signal = { throwIfAborted: () => { if (++checks === 3) throw new Error(secret); } } as unknown as AbortSignal;
    await expect(execute("admin_create_bot", { name: "Cancelled helper", appId: "model" }, signal)).rejects.toThrow("could not be verified");
    expect((await db.select().from(s.bots)).some(bot => bot.name === "Cancelled helper")).toBe(false);
    expect((await db.select().from(s.auditLog)).some(row => row.action === "architect.bot.create")).toBe(false);
  });
  it("assigns caller-owned skills with exact bot revisions without replacing audiences or MCP assignments", async () => {
    const created = await execute("admin_create_bot", { name: "Skill helper", appId: "model" }) as { bot: { id: string; revision: number } };
    await execute("admin_assign_bot_tools", { botId: created.bot.id, expectedRevision: 1, tools: [{ key: "skills", approval: "ask" }] });
    await db.insert(s.groups).values({ id: "reviewers", name: "Reviewers" });
    await db.update(s.bots).set({ visibility: "groups" }).where(eq(s.bots.id, created.bot.id));
    await db.insert(s.botAccess).values({ botId: created.bot.id, groupId: "reviewers" });
    await db.insert(s.botTools).values({ botId: created.bot.id, toolKey: "mcp:server", approval: "ask", config: { tools: ["lookup"] } });
    const [skill] = await db.insert(s.skills).values({ ownerId: admin.user.id, name: "Review policy", slug: "review-policy", description: "Review guidance", instructions: "Check source evidence." }).returning();
    const attached = await execute("admin_assign_bot_skills", { botId: created.bot.id, expectedRevision: 2, attachSkillIds: [skill.id] }) as { status: string; bot: { revision: number }; skills: { id: string; scope: string }[] };
    expect(attached).toMatchObject({ status: "verified", bot: { revision: 3 }, skills: [{ id: skill.id, scope: "bot" }] });
    const [assigned] = await db.select().from(s.skills).where(eq(s.skills.id, skill.id));
    expect(assigned).toMatchObject({ ownerId: admin.user.id, botId: created.bot.id, version: 2 });
    expect(await db.select().from(s.botAccess).where(eq(s.botAccess.botId, created.bot.id))).toMatchObject([{ groupId: "reviewers" }]);
    expect((await db.select().from(s.botTools).where(eq(s.botTools.botId, created.bot.id))).map(row => row.toolKey).sort()).toEqual(["mcp:server", "skills"]);
    await execute("admin_assign_bot_skills", { botId: created.bot.id, expectedRevision: 3, detachSkillIds: [skill.id] });
    const [shared] = await db.select().from(s.skills).where(eq(s.skills.id, skill.id));
    expect(shared).toMatchObject({ botId: null, version: 3 });
    await expect(execute("admin_assign_bot_skills", { botId: "target", expectedRevision: 1, attachSkillIds: [skill.id] })).rejects.toThrow("could not be verified");
    expect((await db.select().from(s.auditLog)).filter(row => row.action === "architect.bot.skills.update")).toHaveLength(2);
  });
  it("updates provider connection metadata with CAS while preserving its credential and destination", async () => {
    const credentialEnc = sealProviderCredential("provider", secret);
    await db.insert(s.providerConnections).values({ id: "provider", name: "Shared API", provider: "openai", baseUrl: null,
      organization: "org-a", project: "proj-a", credentialEnc, createdBy: admin.user.id });
    const [before] = await db.select().from(s.providerConnections).where(eq(s.providerConnections.id, "provider"));
    const updated = await execute("admin_update_provider_connection", { connectionId: "provider", expectedUpdatedAt: before.updatedAt.toISOString(), name: "Production API", enabled: false }) as { status: string; connection: { name: string; enabled: boolean; baseUrl: string | null; hasCredential: boolean } };
    expect(updated).toMatchObject({ status: "verified", connection: { name: "Production API", enabled: false, baseUrl: null, hasCredential: true } });
    const [after] = await db.select().from(s.providerConnections).where(eq(s.providerConnections.id, "provider"));
    expect(after).toMatchObject({ credentialEnc, provider: "openai", baseUrl: null, organization: "org-a", project: "proj-a" });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    await expect(execute("admin_update_provider_connection", { connectionId: "provider", expectedUpdatedAt: before.updatedAt.toISOString(), enabled: true })).rejects.toThrow("could not be verified");
    expect((await db.select().from(s.auditLog)).filter(row => row.action === "architect.provider_connection.update")).toHaveLength(1);
  });
  it("tests a saved provider connection through a metadata endpoint and never returns its credential", async () => {
    const credentialEnc = sealProviderCredential("provider", secret);
    await db.insert(s.providerConnections).values({ id: "provider", name: "Shared API", provider: "openai", baseUrl: null, credentialEnc, createdBy: admin.user.id });
    const [row] = await db.select().from(s.providerConnections).where(eq(s.providerConnections.id, "provider"));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
      return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await execute("admin_test_provider_connection", { connectionId: "provider", expectedUpdatedAt: row.updatedAt.toISOString() });
      expect(result).toMatchObject({ status: "verified", models: ["fixture-model"] });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await db.select().from(s.auditLog)).some(audit => audit.action === "architect.provider_connection.test" && JSON.stringify(audit.details).includes('"modelsFound":1'))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("rolls back provider metadata and test audits when their transaction barriers are cancelled", async () => {
    const credentialEnc = sealProviderCredential("provider", secret);
    await db.insert(s.providerConnections).values({ id: "provider", name: "Shared API", provider: "openai", credentialEnc, createdBy: admin.user.id });
    const [row] = await db.select().from(s.providerConnections).where(eq(s.providerConnections.id, "provider"));
    let updateChecks = 0;
    const updateSignal = { throwIfAborted: () => { if (++updateChecks === 4) throw new Error(secret); } } as unknown as AbortSignal;
    await expect(execute("admin_update_provider_connection", { connectionId: "provider", expectedUpdatedAt: row.updatedAt.toISOString(), name: "Cancelled" }, updateSignal)).rejects.toThrow("could not be verified");
    expect((await db.select().from(s.providerConnections).where(eq(s.providerConnections.id, "provider")))[0].name).toBe("Shared API");
    expect((await db.select().from(s.auditLog)).some(audit => audit.action === "architect.provider_connection.update")).toBe(false);

    const controller = new AbortController();
    vi.stubGlobal("fetch", async () => { controller.abort(); return new Response(JSON.stringify({ data: [] }), { status: 200 }); });
    try {
      await expect(execute("admin_test_provider_connection", { connectionId: "provider", expectedUpdatedAt: row.updatedAt.toISOString() }, controller.signal)).rejects.toThrow("could not be verified");
      expect((await db.select().from(s.auditLog)).some(audit => audit.action === "architect.provider_connection.test")).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
  it("refuses stale approval, missing targets and missing revisions without mutation", async () => {
    await expect(execute("admin_set_bot_enabled", { botId: "target", enabled: false, expectedRevision: 9 })).rejects.toMatchObject({ status: 409 });
    await expect(execute("admin_set_bot_enabled", { botId: "missing", enabled: false, expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(execute("admin_set_bot_enabled", { botId: "target", enabled: false })).rejects.toMatchObject({ status: 409 });
    expect(await adminGetBot(admin, "target")).toMatchObject({ enabled: true, revision: 1 });
  });
  it("rechecks after approval when the actor is demoted or a request is cancelled", async () => {
    await db.update(s.users).set({ isAdmin: false }).where(eq(s.users.id, "admin"));
    await expect(execute("admin_set_bot_enabled", { botId: "target", enabled: false, expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(s.bots).where(eq(s.bots.id, "target")))[0].enabled).toBe(true);
    const cancelled = AbortSignal.abort(new Error(secret));
    await expect(execute("admin_list_connections", {}, cancelled)).rejects.toThrow(/access changed/);
  });
  it("does not expose arbitrary failures through output or audit", async () => {
    await expect(runArchitectCall(ctx, "admin_status", "failure", async () => { throw new Error(secret); })).rejects.toThrow(/could not be verified/);
    expect(JSON.stringify(await db.select().from(s.auditLog))).not.toContain(secret);
  });
  it.each(["audit", "readback"])("rolls back when %s cannot verify the write", async kind => {
    const trigger = kind === "audit"
      ? `CREATE FUNCTION architect_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'bot.disable' THEN RAISE EXCEPTION '${secret}'; END IF; RETURN NEW; END $$; CREATE TRIGGER architect_test_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION architect_test_failure();`
      : `CREATE FUNCTION architect_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.enabled = true; RETURN NEW; END $$; CREATE TRIGGER architect_test_failure BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION architect_test_failure();`;
    await fixture.client!.exec(trigger);
    try {
      await expect(execute("admin_set_bot_enabled", { botId: "target", enabled: false, expectedRevision: 1 })).rejects.toThrow(/could not be verified/);
      expect(await adminGetBot(admin, "target")).toMatchObject({ enabled: true, revision: 1 });
      expect((await db.select().from(s.auditLog)).filter(r => r.action === "bot.disable")).toHaveLength(0);
    } finally { await fixture.client!.exec(`DROP TRIGGER architect_test_failure ON ${kind === "audit" ? "audit_log" : "bots"}; DROP FUNCTION architect_test_failure();`); }
  });
});
