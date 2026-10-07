import { readFileSync, readdirSync } from "node:fs";
import { eq, sql as schemaSql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null, enqueue: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The coordinator is disabled in this fixture. PGlite's single connection cannot perform the existing
// defaultCoordinator global-pool read while saveBotNavigation holds a transaction on that connection.
vi.mock("@/lib/coordinator/store", () => ({ defaultCoordinator: async () => null }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/jobs", () => ({ enqueueRun: fixture.enqueue, scheduleMemoryExtraction: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => fixture.principal,
  errorResponse: (error: Error) => Response.json({ error: error.message }, { status: 500 }) }));
vi.mock("@/lib/runs/tail", () => ({ tailRun: () => new ReadableStream({ start(controller) { controller.close(); } }) }));

import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { loadShell } from "@/lib/chat/shell";
import { saveBotNavigation } from "@/lib/bots/navigation-store";
import { loadBotLastSentAt, recordBotSendTx } from "@/lib/bots/recent-use";
import { orderBots } from "@/lib/bots/navigation";
import { newId } from "@/lib/ids";
import { POST } from "@/app/api/chat/route";
import { continueSharedConversation } from "@/app/(chat)/actions";

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45_000);
beforeEach(async () => {
  fixture.enqueue.mockReset(); fixture.enqueue.mockResolvedValue(undefined);
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values(["alice", "bob"].map(id => ({ id, name: id, upn: `${id}@test.invalid`, authSource: "local" as const, identityRealm: "local" as const, prefs: { botOrder: ["c", "b", "a"], customInstructions: "Keep this" } })));
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic model", provider: "openai-compatible", baseUrl: "https://model.test.invalid/v1", model: "fixture", isPublic: true });
  await db.insert(schema.bots).values(["a", "b", "c"].map(id => ({ id, name: id.toUpperCase(), ownerId: "alice", appId: "model", visibility: "org" as const })));
  fixture.principal = (await loadPrincipal("alice"))!;
});
afterAll(async () => { await fixture.client!.close(); });

async function roster(user = "alice") { return (await loadShell((await loadPrincipal(user))!)).bots; }
async function ids(user = "alice") { return (await roster(user)).map(b => b.id); }
async function history(botId: string, date: string, options: { userId?: string; source?: "chat" | "routine" | "delegation"; role?: "user" | "assistant"; isGroup?: boolean; archived?: boolean; copied?: boolean } = {}) {
  const [conv] = await db.insert(schema.conversations).values({ userId: options.userId ?? "alice", botId, source: options.source ?? "chat", isGroup: options.isGroup ?? false, archived: options.archived ?? false }).returning();
  await db.insert(schema.messages).values({ id: newId(), conversationId: conv.id, role: options.role ?? "user", parts: [{ type: "text", text: "Synthetic message" }], createdAt: new Date(date) });
  // Seed explicit accepted-send history; copies and assistant messages do not pass the admission recorder.
  if (!options.copied && (options.role ?? "user") === "user") {
    const principal = (await loadPrincipal(conv.userId))!;
    await db.transaction(tx => recordBotSendTx(tx, principal, conv, new Date(date)));
  }
  return conv;
}
async function send(botId: string, over: Record<string, unknown> = {}) {
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: newId(), botId, message: { id: newId(), role: "user", parts: [{ type: "text", text: "Synthetic send" }] }, ...over }) }));
  await response.text();
  return response;
}

describe("per-user sidebar recent sends (production queries and admission, synthetic queue)", () => {
  it("promotes an accepted direct send, reloads from storage and leaves the other user and preferences intact", async () => {
    expect(await ids()).toEqual(["c", "b", "a"]);
    expect((await send("a")).status).toBe(200);
    expect(await ids()).toEqual(["a", "c", "b"]);
    expect((await roster())[0].lastSentAt).toBeTruthy();
    expect(await ids("bob")).toEqual(["c", "b", "a"]);
    const [alice] = await db.select().from(schema.users).where(eq(schema.users.id, "alice"));
    expect(alice.prefs).toMatchObject({ botOrder: ["c", "b", "a"], customInstructions: "Keep this" });
    expect(Object.keys(alice.prefs.botLastSentAt!)).toEqual(["a"]);
    expect(await db.select().from(schema.userBotPrefs)).toEqual([]);
  });
  it("keeps chosen pin order on sends, appends pins and places an unpinned bot at its own recency", async () => {
    await history("a", "2026-01-01T00:00:00Z");
    await history("b", "2026-01-02T00:00:00Z");
    await saveBotNavigation(fixture.principal!, { kind: "preference", botId: "c", pinned: true });
    await saveBotNavigation(fixture.principal!, { kind: "preference", botId: "a", pinned: true });
    expect(await ids()).toEqual(["c", "a", "b"]);
    await send("b"); expect(await ids()).toEqual(["c", "a", "b"]);
    await send("a"); expect(await ids()).toEqual(["c", "a", "b"]);
    await saveBotNavigation(fixture.principal!, { kind: "move", botId: "a", targetId: "c", placement: "before" });
    expect(await ids()).toEqual(["a", "c", "b"]);
    await saveBotNavigation(fixture.principal!, { kind: "preference", botId: "a", pinned: false });
    expect(await ids()).toEqual(["c", "a", "b"]);
    await saveBotNavigation(fixture.principal!, { kind: "preference", botId: "c", pinned: false });
    expect(await ids()).toEqual(["a", "b", "c"]);
  });
  it("ignores opening, background user prompts, group messages, assistant replies and another user's sends", async () => {
    await history("b", "2026-01-01T00:00:00Z");
    await db.insert(schema.conversations).values({ userId: "alice", botId: "a", isBotHome: true });
    for (const source of ["routine", "delegation"] as const) await history("a", "2026-02-01T00:00:00Z", { source });
    await history("a", "2026-03-01T00:00:00Z", { role: "assistant" });
    await history("a", "2026-04-01T00:00:00Z", { isGroup: true });
    await history("a", "2026-05-01T00:00:00Z", { userId: "bob" });
    expect(await ids()).toEqual(["b", "c", "a"]);
    expect(await ids("bob")).toEqual(["a", "c", "b"]);
  });
  it("uses side and archived chat sends and breaks equal timestamps by saved order, with new bots last", async () => {
    await history("a", "2026-01-01T00:00:00Z", { archived: true });
    await history("b", "2026-01-01T00:00:00Z");
    expect(await ids()).toEqual(["b", "a", "c"]);
    await saveBotNavigation(fixture.principal!, { kind: "move", botId: "a", targetId: "b", placement: "before" });
    await db.insert(schema.bots).values({ id: "d", name: "AAA new", ownerId: "alice", appId: "model", visibility: "org" });
    expect(await ids()).toEqual(["a", "b", "c", "d"]);
    await expect(saveBotNavigation(fixture.principal!, { kind: "move", botId: "c", targetId: "a", placement: "before" })).rejects.toMatchObject({ status: 400 });
  });
  it("never promotes unsaved invalid, inaccessible, busy or duplicate sends, or regeneration", async () => {
    await history("b", "2026-01-01T00:00:00Z");
    expect((await send("a", { message: { id: newId(), role: "user", parts: [] } })).status).toBe(400);
    await db.update(schema.bots).set({ visibility: "private", ownerId: "bob" }).where(eq(schema.bots.id, "a"));
    expect((await send("a")).status).toBe(403);
    await db.update(schema.bots).set({ visibility: "org" }).where(eq(schema.bots.id, "a"));
    const conv = await history("a", "2025-01-01T00:00:00Z");
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id));
    expect((await send("a", { conversationId: conv.id, message: { id: message.id, role: "user", parts: [{ type: "text", text: "duplicate" }] } })).status).toBe(409);
    expect((await send("a", { conversationId: conv.id, message: undefined, regenerate: true, parentId: message.id })).status).toBe(200);
    expect((await send("a", { conversationId: conv.id })).status).toBe(409);
    expect(await ids()).toEqual(["b", "a", "c"]);
  });
  it("keeps recency for a durably saved prompt even when the queue later fails", async () => {
    fixture.enqueue.mockRejectedValue(new Error("Synthetic queue unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await send("a")).status).toBe(503); } finally { log.mockRestore(); }
    expect(await ids()).toEqual(["a", "c", "b"]);
    expect(await db.select().from(schema.messages)).toHaveLength(1);
  });
  it("ignores copied history until the viewer actually sends, and retains recency after deleting history", async () => {
    await history("b", "2026-01-01T00:00:00Z");
    const shared = await history("a", "2026-10-07T00:00:00Z", { userId: "bob" });
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, shared.id));
    const token = newId();
    await db.insert(schema.sharedLinks).values({ id: token, conversationId: shared.id, createdBy: "bob", cutoffMessageId: message.id });
    const copyId = await continueSharedConversation(token);
    expect(await ids()).toEqual(["b", "c", "a"]);
    expect((await send("a", { conversationId: copyId })).status).toBe(200);
    expect(await ids()).toEqual(["a", "b", "c"]);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, copyId));
    expect(await ids()).toEqual(["a", "b", "c"]);
  });
  it("rolls back message, run and recency together if the preference write fails", async () => {
    await db.execute(schemaSql`ALTER TABLE users ADD CONSTRAINT reject_recency CHECK (id <> 'alice') NOT VALID`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await send("a")).status).toBe(500); }
    finally { log.mockRestore(); await db.execute(schemaSql`ALTER TABLE users DROP CONSTRAINT reject_recency`); }
    expect(await ids()).toEqual(["c", "b", "a"]);
    expect(await db.select().from(schema.messages)).toEqual([]);
    expect(await db.select().from(schema.agentRuns)).toEqual([]);
  });
  it("recovers legacy accepted sends from durable admission receipts while excluding copied prompts and their regeneration", async () => {
    await send("b");
    await db.update(schema.users).set({ prefs: { botOrder: ["c", "b", "a"] } }).where(eq(schema.users.id, "alice"));
    expect(await ids()).toEqual(["b", "c", "a"]);
    const copy = await history("a", "2026-10-07T00:00:00Z", { copied: true });
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, copy.id));
    expect((await send("a", { conversationId: copy.id, message: undefined, regenerate: true, parentId: message.id })).status).toBe(200);
    expect(await ids()).toEqual(["b", "c", "a"]);
  });
  it("filters revoked bots on reads and rejects another user's conversation without changing either list", async () => {
    const conv = await history("a", "2026-01-01T00:00:00Z", { userId: "bob" });
    expect((await send("a", { conversationId: conv.id })).status).toBe(404);
    expect(await ids()).toEqual(["c", "b", "a"]);
    await db.update(schema.bots).set({ visibility: "private", ownerId: "bob" }).where(eq(schema.bots.id, "a"));
    expect(await ids()).toEqual(["c", "b"]);
    expect(await loadBotLastSentAt("alice", [])).toEqual(new Map());
    expect(await ids("bob")).toEqual(["a", "c", "b"]);
  });
  it("has deterministic unsaved ties independent of roster input, and pins always stay above recency", () => {
    const bots = [{ id: "z", name: "Same" }, { id: "a", name: "Same" }, { id: "p", name: "Pin", pinned: true }, { id: "used", name: "Used", lastSentAt: "2026-01-01T00:00:00Z" }];
    expect(orderBots(bots).map(b => b.id)).toEqual(["p", "used", "a", "z"]);
    expect(orderBots(bots.toReversed()).map(b => b.id)).toEqual(["p", "used", "a", "z"]);
  });
});
