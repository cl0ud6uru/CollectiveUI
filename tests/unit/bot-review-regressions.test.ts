import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { generateText, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { AgentCtx } from "@/lib/agent/types";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null,
  call: vi.fn(), connect: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => fixture.principal! }));
vi.mock("@/lib/jobs", () => ({ enqueue: vi.fn(), QUEUES: {}, enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn() }));
vi.mock("@/lib/mcp/client", async (original) => ({
  ...await original<typeof import("@/lib/mcp/client")>(), connectMcp: fixture.connect,
}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

import { db, schema as s } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { duplicateBot, createBotTemplate, draftBotFromDescription } from "@/app/(chat)/bots/actions";
import { buildToolset, type Toolset } from "@/lib/agent/toolset";
import { toolApprovalSecret } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";
import { NO_UTILITY_MODEL } from "@/lib/bots/draft";

const handles: Toolset[] = [];
beforeAll(async () => {
  await fixture.client!.waitReady;
  // Real migrations and queries. Only unrelated pgvector columns use arrays; no embedding execution is tested.
  for (const file of readdirSync("src/db/migrations").filter((name) => name.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8")
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45_000);
beforeEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings, mcp_servers CASCADE");
  await db.insert(s.users).values(["owner", "copier"].map((id) => ({ id, name: id, upn: `${id}@fixture.invalid`, identityRealm: "local" as const, authSource: "local" as const })));
  await db.insert(s.aiApps).values({ id: "model", name: "Synthetic model", provider: "openai-compatible", model: "synthetic", baseUrl: "https://unused.invalid/v1", isPublic: true, supportsTools: true });
  await db.insert(s.bots).values({ id: "source", name: "Shared bot", ownerId: "owner", appId: "model", visibility: "org" });
  fixture.principal = (await loadPrincipal("copier"))!;
  fixture.call.mockReset(); fixture.connect.mockReset(); fixture.close.mockClear();
  fixture.call.mockResolvedValue({ content: [{ type: "text", text: "Synthetic result" }] });
  fixture.connect.mockResolvedValue({ toolsFromDefinitions: vi.fn(), callTool: fixture.call, close: fixture.close });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network call"); }));
});
afterAll(async () => {
  await Promise.all(handles.map((handle) => handle.close()));
  vi.unstubAllGlobals();
  await fixture.client!.close();
});

describe("reviewed bot privacy, creation policy and approval regressions (embedded PostgreSQL)", () => {
  it("copies and templates only the actor's private routines", async () => {
    await db.insert(s.routines).values([
      { ownerId: "owner", botId: "source", name: "Owner private", prompt: "Owner secret prompt", triggerType: "cron", cron: "0 9 * * *" },
      { ownerId: "copier", botId: "source", name: "Copier private", prompt: "Copier prompt", triggerType: "cron", cron: "0 9 * * *" },
    ]);
    const copy = await duplicateBot("source");
    expect((await db.select().from(s.routines).where(eq(s.routines.botId, copy.id))).map((r) => [r.ownerId, r.name, r.enabled]))
      .toEqual([["copier", "Copier private", false]]);
    await expect(createBotTemplate("source")).rejects.toMatchObject({ status: 403 });
    fixture.principal = (await loadPrincipal("owner"))!;
    await createBotTemplate("source");
    const [template] = await db.select().from(s.botTemplates).where(eq(s.botTemplates.botId, "source"));
    expect(template.snapshot.routines.map((routine) => routine.name)).toEqual(["Owner private"]);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("keeps an explicit approval verifiable after Always allow, while dispatch sees the new grant", async () => {
    await db.insert(s.mcpServers).values({ id: "connector", name: "Synthetic MCP", url: "https://unused.invalid/mcp", isPublic: true,
      status: "enabled", trust: "trusted", toolsSnapshot: [{ name: "write_note", description: "Write a fixture note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
    await db.insert(s.botTools).values({ botId: "source", toolKey: "mcp:connector", approval: "smart" });
    const [bot] = await db.select().from(s.bots).where(eq(s.bots.id, "source"));
    const [app] = await db.select().from(s.aiApps).where(eq(s.aiApps.id, "model"));
    const context: AgentCtx = { principal: fixture.principal!, bot, app, conversationId: "synthetic-chat", depth: 0, background: false, toolSettings: await getSetting("tools") };
    const initial = await buildToolset(context); handles.push(initial);
    expect(initial.entries).toHaveLength(1);
    const toolName = initial.entries[0].name;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = new MockLanguageModelV4({ doGenerate: [
      { content: [{ type: "tool-call", toolCallId: "synthetic-call", toolName, input: JSON.stringify({ text: "Synthetic note" }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] },
      { content: [{ type: "text", text: "Done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    ] });
    const first = await generateText({ model, prompt: "Write a synthetic note", tools: initial.tools, toolApproval: initial.approval,
      experimental_toolApprovalSecret: toolApprovalSecret(initial.approvalSigningBinding ?? initial.approvalBinding) });
    const request = first.content.find((part) => part.type === "tool-approval-request")!;
    expect(request).toBeDefined(); expect(fixture.call).not.toHaveBeenCalled();
    await db.insert(s.toolGrants).values({ userId: "copier", botId: "source", toolName });
    const resumed = await buildToolset(context); handles.push(resumed);
    expect(resumed.approvalBinding).not.toBe(initial.approvalBinding);
    const messages: ModelMessage[] = [...first.responseMessages, { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true }] }];
    await generateText({ model, messages, tools: resumed.tools, toolApproval: resumed.approval,
      experimental_toolApprovalSecret: toolApprovalSecret(resumed.approvalSigningBinding ?? resumed.approvalBinding) });
    expect(resumed.approvalSigningBinding).toBeDefined();
    expect(resumed.approvalSigningBinding).toBe(initial.approvalSigningBinding);
    expect(fixture.call).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies new-bot drafting under an admins-only policy but keeps existing-bot editors eligible", async () => {
    await db.insert(s.settings).values({ key: "tools", value: { botCreation: "admins" } });
    expect(await draftBotFromDescription("Synthetic description")).toEqual({ ok: false, error: "Only admins can create bots" });
    fixture.principal = (await loadPrincipal("owner"))!;
    expect(await draftBotFromDescription("Synthetic description", "source")).toEqual({ ok: false, error: NO_UTILITY_MODEL });
    fixture.principal = (await loadPrincipal("copier"))!;
    expect(await draftBotFromDescription("Synthetic description", "source")).toMatchObject({ ok: false });
    expect(fixture.connect).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
