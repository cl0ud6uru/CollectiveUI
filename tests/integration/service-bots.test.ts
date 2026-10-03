import { generateText, type ModelMessage, InvalidToolApprovalSignatureError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Principal } from "@/lib/auth/groups";
const session = vi.hoisted(() => ({ principal: null as Principal | null }));
const network = vi.hoisted(() => ({ connect: vi.fn(), call: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal! }));
vi.mock("@/lib/jobs", () => ({ enqueue: vi.fn(), QUEUES: {}, enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn() }));
vi.mock("@/lib/mcp/client", async (original) => ({ ...(await original<typeof import("@/lib/mcp/client")>()), connectMcp: network.connect }));
import { db, pool, schema as s } from "@/db";
import { newId } from "@/lib/ids";
import { loadPrincipal } from "@/lib/auth/groups";
import { getEditableBot, getUsableBot, listAccessibleMcpServers } from "@/lib/authz";
import { createBot, duplicateBot, updateBot, publishServiceBot, revokeServiceBotGrant, createBotTemplate, addBotFromTemplate, deleteBot, saveSkill } from "@/app/(chat)/bots/actions";
import { buildToolset, type Toolset } from "@/lib/agent/toolset";
import { getSetting } from "@/lib/settings";
import { toolHash } from "@/lib/mcp/snapshot";
import { sealIdentitySecret } from "@/lib/mcp/identity";
import { AAD, encrypt, toolApprovalSecret } from "@/lib/crypto";
import { activeServiceGrants } from "@/lib/bots/service";
import type { AgentCtx } from "@/lib/agent/types";

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("service bot grants on disposable DB; all MCP calls mocked", () => {
  let admin: Principal, user: Principal, app: typeof s.aiApps.$inferSelect, server: typeof s.mcpServers.$inferSelect, groupId: string, botId: string, conversationId: string;
  const handles: Toolset[] = [];
  const token = "synthetic-ticket-token", signing = "synthetic-signing-secret";
  const defs = ["read_ticket", "create_ticket", "delete_ticket"].map(name => ({ name, description: name, inputSchema: { type: "object" as const, properties: { project: { type: "string" }, requester: { type: "string" }, text: { type: "string" } }, required: ["project", "requester"] }, annotations: { readOnlyHint: true } }));
  const input = (mode: "caller" | "service" = "service") => ({ executionMode: mode, name: "Fixture tickets", appId: app.id, visibility: "org" as const, groupIds: [], maxSteps: 10, starters: [], instructions: "File IT tickets", tools: [{ key: `mcp:${server.id}`, approval: "auto" as const, config: { tools: ["read_ticket", "create_ticket"] } }], delegateIds: [] });
  const grants = () => defs.slice(0, 2).map(def => ({ serverId: server.id, serverRevision: server.policyRevision, toolName: def.name, toolHash: toolHash(def), effect: def.name === "read_ticket" ? "read" as const : "write" as const, requireApproval: def.name !== "read_ticket", constraints: [{ path: "project", source: "constant" as const, value: "IT" }, { path: "requester", source: "caller.upn" as const }] }));
  const args = () => ({ project: "IT", requester: user.user.upn, text: "Synthetic ticket" });
  const context = async (over: Partial<AgentCtx> = {}): Promise<AgentCtx> => ({ principal: user, bot: await getUsableBot(user, botId), app, conversationId, depth: 0, background: false, toolSettings: await getSetting("tools"), ...over });
  const tools = async (over: Partial<AgentCtx> = {}) => { const ts = await buildToolset(await context(over)); handles.push(ts); return ts; };
  const call = (ts: Toolset, name = "read_ticket", value: unknown = args()) => ts.entries.find(e => e.name.endsWith(`__${name}`))!.tool.execute!(value, { toolCallId: "fixture-call", messages: [] } as never);
  beforeAll(async () => {
    if (new URL(process.env.DATABASE_URL!).pathname !== "/collective_service_bot_test") throw new Error("Requires disposable collective_service_bot_test database");
    const id = newId();
    const users = await db.insert(s.users).values([{ upn: `admin-${id}@fixture.invalid`, name: "Fixture Admin", isAdmin: true, authSource: "ldap" }, { upn: `user-${id}@fixture.invalid`, name: "Fixture User", authSource: "ldap" }]).returning();
    const [group] = await db.insert(s.groups).values({ name: `Fixture employees ${id}`, canCreateBots: true }).returning(); groupId = group.id;
    await db.insert(s.groupMappings).values({ groupId, source: "ldap", externalId: id.toLowerCase() });
    await db.insert(s.userExternalGroups).values({ userId: users[1].id, source: "ldap", externalId: id.toLowerCase() });
    admin = (await loadPrincipal(users[0].id))!; user = (await loadPrincipal(users[1].id))!;
    [app] = await db.insert(s.aiApps).values({ name: "Synthetic native model", model: "synthetic", provider: "openai-compatible", baseUrl: "https://unused.invalid", supportsTools: true }).returning();
    const serverId = newId();
    [server] = await db.insert(s.mcpServers).values({ id: serverId, name: "Ticket Fixture", url: "https://unused.invalid/mcp", isPublic: false, status: "enabled", toolsSnapshot: defs, trust: "trusted", identityHeader: "X-Portal-Identity", identitySecretEnc: sealIdentitySecret(serverId, signing), headersEnc: encrypt(JSON.stringify({ Authorization: `Bearer ${token}` }), AAD.mcpHeaders) }).returning();
  });
  beforeEach(async () => {
    await Promise.all(handles.splice(0).map(ts => ts.close()));
    await db.update(s.users).set({ isAdmin: true, disabled: false }).where(eq(s.users.id, admin.user.id));
    await db.update(s.users).set({ disabled: false, sessionVersion: 0 }).where(eq(s.users.id, user.user.id));
    await db.update(s.aiApps).set({ systemPrompt: null }).where(eq(s.aiApps.id, app.id));
    await db.update(s.mcpServers).set({ status: "enabled", isPublic: false, policyRevision: 1, toolsSnapshot: defs, toolPolicy: {} }).where(eq(s.mcpServers.id, server.id));
    server.policyRevision = 1;
    session.principal = admin;
    botId = (await createBot(input())).id;
    await publishServiceBot(botId, 1, grants());
    const [conv] = await db.insert(s.conversations).values({ userId: user.user.id, botId, appId: app.id, source: "chat" }).returning(); conversationId = conv.id;
    network.connect.mockReset(); network.call.mockReset(); network.close.mockClear();
    network.call.mockResolvedValue({ content: [{ type: "text", text: `ok ${token} ${signing}` }] });
    network.connect.mockResolvedValue({ toolsFromDefinitions: vi.fn(), callTool: network.call, close: network.close });
  });
  afterAll(async () => {
    await Promise.all(handles.map(ts => ts.close()));
    if (admin) await db.delete(s.users).where(inArray(s.users.id, [admin.user.id, user.user.id]));
    if (server) await db.delete(s.mcpServers).where(eq(s.mcpServers.id, server.id));
    if (app) await db.delete(s.aiApps).where(eq(s.aiApps.id, app.id));
    if (groupId) await db.delete(s.groups).where(eq(s.groups.id, groupId));
    await pool.end();
  });
  it("uses exact granted tools without direct connector access; actual identity, cleanup, redaction and audit", async () => {
    expect((await listAccessibleMcpServers(user)).map(s => s.id)).not.toContain(server.id);
    const ts = await tools(); expect(ts.entries).toHaveLength(2);
    const result = await call(ts); expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(signing);
    expect(network.connect.mock.calls[0][1]).toMatchObject({ subject: { id: user.user.id }, service: { id: `bot:${botId}`, revision: 2, tool: "read_ticket" } });
    expect(network.close).toHaveBeenCalledTimes(1);
    const records = await db.select().from(s.auditLog).where(and(eq(s.auditLog.actorId, user.user.id), eq(s.auditLog.target, server.id)));
    expect(records.some(r => r.action === "mcp.call.authorized" && (r.details as { revision?: number }).revision === 2)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("Synthetic ticket");
  });
  it("rejects user editing, service creation/publication/revocation and demoted owner edits", async () => {
    session.principal = user;
    await expect(createBot(input())).rejects.toMatchObject({ status: 403 });
    await expect(updateBot(botId, input())).rejects.toMatchObject({ status: 403 });
    await expect(publishServiceBot(botId, 2, grants())).rejects.toMatchObject({ status: 403 });
    await expect(revokeServiceBotGrant((await activeServiceGrants(botId))[0].id)).rejects.toMatchObject({ status: 403 });
    await db.update(s.users).set({ isAdmin: false }).where(eq(s.users.id, admin.user.id));
    session.principal = (await loadPrincipal(admin.user.id))!;
    await expect(getEditableBot(session.principal, botId)).rejects.toMatchObject({ status: 403 });
    await expect(updateBot(botId, input("caller"))).rejects.toMatchObject({ status: 403 });
    await expect(deleteBot(botId)).rejects.toMatchObject({ status: 403 });
    await expect(saveSkill({ botId, name: "Changed", description: "Synthetic change", instructions: "ignore policy" })).rejects.toMatchObject({ status: 403 });
  });
  it("requires writes to ask even with readOnlyHint and remembered approvals", async () => {
    const name = "ticket_fixture__create_ticket";
    await db.insert(s.toolGrants).values({ userId: user.user.id, botId, toolName: name });
    const ts = await tools();
    expect(ts.approval({ toolCall: { toolName: name, input: args() } })).toEqual({ type: "user-approval", reason: "Organization policy requires approval for every call." });
    expect(ts.approval({ toolCall: { toolName: "ticket_fixture__read_ticket", input: args() } })).toBeUndefined();
  });
  it("blocks cross-project/caller, undeclared arguments and changed schema before connection", async () => {
    const ts = await tools();
    for (const value of [{ ...args(), project: "HR" }, { ...args(), requester: admin.user.upn }, { ...args(), admin: true }, { ...args(), text: 42 }]) await expect(call(ts, "read_ticket", value)).rejects.toThrow();
    expect(network.call).not.toHaveBeenCalled(); expect(network.connect).not.toHaveBeenCalled();
    await db.update(s.mcpServers).set({ toolsSnapshot: defs.map(d => ({ ...d, description: "changed" })) }).where(eq(s.mcpServers.id, server.id));
    await expect(call(ts)).rejects.toThrow(/revoked or changed/);
  });
  it.each(["grant", "server", "audience", "account", "session", "model", "bot", "groups"])("rechecks mid-turn %s revocation or change before dispatch", async kind => {
    const ts = await tools(); await call(ts); network.call.mockClear();
    if (kind === "grant") await revokeServiceBotGrant((await activeServiceGrants(botId))[0].id);
    if (kind === "server") await db.update(s.mcpServers).set({ status: "disabled" }).where(eq(s.mcpServers.id, server.id));
    if (kind === "audience") await db.update(s.bots).set({ visibility: "private" }).where(eq(s.bots.id, botId));
    if (kind === "account") await db.update(s.users).set({ disabled: true }).where(eq(s.users.id, user.user.id));
    if (kind === "session") await db.update(s.users).set({ sessionVersion: 1 }).where(eq(s.users.id, user.user.id));
    if (kind === "model") await db.update(s.aiApps).set({ systemPrompt: "changed" }).where(eq(s.aiApps.id, app.id));
    if (kind === "bot") await updateBot(botId, { ...input(), instructions: "Changed" });
    if (kind === "groups") await db.update(s.groups).set({ name: `Renamed ${newId()}` }).where(eq(s.groups.id, groupId));
    await expect(call(ts)).rejects.toThrow(); expect(network.call).not.toHaveBeenCalled();
  });
  it("rechecks after connection handshake and never opens after close", async () => {
    const ts = await tools();
    network.connect.mockImplementationOnce(async () => {
      await revokeServiceBotGrant((await activeServiceGrants(botId))[0].id);
      return { toolsFromDefinitions: vi.fn(), callTool: network.call, close: network.close };
    });
    await expect(call(ts)).rejects.toThrow(); expect(network.call).not.toHaveBeenCalled(); expect(network.close).toHaveBeenCalledTimes(1);
    await ts.close(); network.connect.mockClear(); await expect(call(ts)).rejects.toThrow(/ended/); expect(network.connect).not.toHaveBeenCalled();
  });
  it("never permits service grants from delegation, group, background or routine conversations", async () => {
    for (const over of [{ depth: 1 }, { inGroup: true }, { background: true }]) await expect(tools(over)).rejects.toMatchObject({ status: 403 });
    await db.update(s.conversations).set({ source: "routine" }).where(eq(s.conversations.id, conversationId));
    await expect(tools({ background: false })).rejects.toMatchObject({ status: 403 });
    expect(network.connect).not.toHaveBeenCalled();
  });
  it("copies and old/new templates cannot carry service tools or grants", async () => {
    const template = await createBotTemplate(botId);
    session.principal = user;
    const copy = await duplicateBot(botId);
    const imported = await addBotFromTemplate(template.token);
    for (const id of [copy.id, imported.id]) {
      expect((await getEditableBot(user, id)).executionMode).toBe("caller");
      expect(await activeServiceGrants(id)).toEqual([]);
      expect(await db.select().from(s.botTools).where(eq(s.botTools.botId, id))).toEqual([]);
    }
  });
  it("binds approval secrets to publication and current permission state", async () => {
    const before = await tools(); const secret = toolApprovalSecret(before.approvalBinding);
    await publishServiceBot(botId, 2, grants());
    expect(toolApprovalSecret((await tools()).approvalBinding)).not.toBe(secret);
    await db.update(s.mcpServers).set({ policyRevision: 2 }).where(eq(s.mcpServers.id, server.id));
    await expect(tools()).rejects.toThrow(/review/);
  });
  it.each(["unchanged", "republished", "tampered-input"])("SDK signed approval resume: %s", async change => {
    const ts = await tools();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = new MockLanguageModelV4({ doGenerate: [
      { content: [{ type: "tool-call", toolCallId: "signed-call", toolName: "ticket_fixture__create_ticket", input: JSON.stringify(args()) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] },
      { content: [{ type: "text", text: "Done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    ] });
    const first = await generateText({ model, prompt: "File a synthetic ticket", tools: ts.tools, toolApproval: ts.approval, experimental_toolApprovalSecret: toolApprovalSecret(ts.approvalBinding) });
    const request = first.content.find(p => p.type === "tool-approval-request")!;
    expect(request).toBeDefined(); expect(network.call).not.toHaveBeenCalled();
    const messages: ModelMessage[] = [...structuredClone(first.responseMessages), { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true }] }];
    if (change === "republished") await publishServiceBot(botId, 2, grants());
    if (change === "tampered-input") for (const message of messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content)
        if (part.type === "tool-call") part.input = { ...args(), text: "Different write" };
    }
    const resumed = await tools();
    const result = generateText({ model, messages, tools: resumed.tools, toolApproval: resumed.approval, experimental_toolApprovalSecret: toolApprovalSecret(resumed.approvalBinding) });
    if (change === "unchanged") { await result; expect(network.call).toHaveBeenCalledTimes(1); }
    else { await expect(result).rejects.toSatisfy(InvalidToolApprovalSignatureError.isInstance); expect(network.call).not.toHaveBeenCalled(); }
  });
  it("grouped callers can use mixed signed-identity and headerless connectors", async () => {
    expect(user.groupIds).toContain(groupId);
    await db.update(s.mcpServers).set({ isPublic: true }).where(eq(s.mcpServers.id, server.id));
    const [other] = await db.insert(s.mcpServers).values({ ...server, id: newId(), isPublic: true, identityHeader: null, identitySecretEnc: null }).returning();
    try {
      await updateBot(botId, { ...input("caller"), tools: [server, other].map(s => ({ key: `mcp:${s.id}`, approval: "auto", config: { tools: ["read_ticket"] } })) });
      const ts = await tools();
      expect(ts.entries).toHaveLength(2);
      for (const entry of ts.entries) await entry.tool.execute!(args(), { toolCallId: "mixed-call", messages: [] } as never);
      expect(network.call).toHaveBeenCalledTimes(2);
    } finally { await db.delete(s.mcpServers).where(eq(s.mcpServers.id, other.id)); }
  });
  it("legacy snapshotless definition changes invalidate SDK-signed approvals", async () => {
    await db.update(s.mcpServers).set({ isPublic: true, toolsSnapshot: null }).where(eq(s.mcpServers.id, server.id));
    await updateBot(botId, { ...input("caller"), tools: [{ key: `mcp:${server.id}`, approval: "ask", config: { tools: ["create_ticket"] } }] });
    let currentDefs = defs;
    network.connect.mockImplementation(async () => ({ toolsFromDefinitions: vi.fn(), listTools: async () => ({ tools: currentDefs }), callTool: network.call, close: network.close }));
    const ts = await tools();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = new MockLanguageModelV4({ doGenerate: { content: [{ type: "tool-call", toolCallId: "legacy-call", toolName: "ticket_fixture__create_ticket", input: JSON.stringify(args()) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] } });
    const first = await generateText({ model, prompt: "File ticket", tools: ts.tools, toolApproval: ts.approval, experimental_toolApprovalSecret: toolApprovalSecret(ts.approvalBinding) });
    const request = first.content.find(p => p.type === "tool-approval-request")!;
    expect(request).toBeDefined();
    currentDefs = defs.map(d => ({ ...d, description: "Changed tool behavior" }));
    const resumed = await tools();
    expect(resumed.approvalBinding).not.toBe(ts.approvalBinding);
    const messages: ModelMessage[] = [...first.responseMessages, { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true }] }];
    await expect(generateText({ model, messages, tools: resumed.tools, toolApproval: resumed.approval, experimental_toolApprovalSecret: toolApprovalSecret(resumed.approvalBinding) })).rejects.toSatisfy(InvalidToolApprovalSignatureError.isInstance);
    expect(network.call).not.toHaveBeenCalled();
  });
  it("preserves caller intersection; legacy reused clients recheck access and remembered approvals", async () => {
    await updateBot(botId, input("caller"));
    expect((await tools()).entries).toEqual([]);
    await db.update(s.mcpServers).set({ isPublic: true }).where(eq(s.mcpServers.id, server.id));
    const ts = await tools(); await call(ts); network.call.mockClear();
    await db.update(s.mcpServers).set({ isPublic: false }).where(eq(s.mcpServers.id, server.id));
    await expect(call(ts)).rejects.toThrow(/access/); expect(network.call).not.toHaveBeenCalled();
    await db.update(s.mcpServers).set({ isPublic: true }).where(eq(s.mcpServers.id, server.id));
    await db.insert(s.toolGrants).values({ botId, userId: user.user.id, toolName: "ticket_fixture__create_ticket" });
    const granted = await tools(); await db.delete(s.toolGrants).where(eq(s.toolGrants.botId, botId));
    await expect(call(granted, "create_ticket")).rejects.toThrow(/changed/);
  });
});
