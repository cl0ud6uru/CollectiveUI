import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null, enqueue: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/jobs", () => ({ enqueueRun: fixture.enqueue, scheduleMemoryExtraction: vi.fn() }));
import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { commitVoiceBatch, type VoiceBatch } from "@/lib/voice/turn";
import { prepareVoiceConversation } from "@/lib/voice/conversation";
import { resolveTurnTarget } from "@/lib/agent/target";

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45000);
beforeEach(async () => {
  fixture.enqueue.mockReset(); fixture.enqueue.mockResolvedValue(undefined);
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values(["alice", "bob"].map(id => ({ id, name: id, upn: `${id}@test.invalid`, authSource: "local" as const, identityRealm: "local" as const })));
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic", provider: "openai-compatible", baseUrl: "https://model.test.invalid/v1", model: "fixture", isPublic: true });
  await db.insert(schema.bots).values({ id: "bot", name: "Bot", ownerId: "alice", appId: "model", visibility: "org" });
  await db.insert(schema.conversations).values({ id: "conversation01", userId: "alice", botId: "bot" });
  fixture.principal = (await loadPrincipal("alice"))!;
});
afterAll(async () => { await fixture.client!.close(); });
const batch = (delegate = true): VoiceBatch => ({ conversationId: "conversation01", sessionId: "live01", batchId: "batch0000001", delegate,
  fragments: [{ id: "u1", role: "user", text: "Find my saved notes", startMs: 0, endMs: 200 }, { id: "a1", role: "assistant", text: "Let me check", startMs: 150, endMs: 300 }] });

describe("voice transcript and durable bot admission", () => {
  it("preserves the whole user request across overlapping assistant acknowledgments", async () => {
    const input = batch(false);
    input.fragments[0].text = "Find my";
    input.fragments.push({ id: "u2", role: "user", text: " saved notes", startMs: 250, endMs: 450 });
    await commitVoiceBatch(fixture.principal!, input);
    const rows = await db.select().from(schema.messages);
    expect(rows.filter(row => row.role === "user").map(row => row.parts)).toEqual([[{ type: "text", text: "Find my saved notes" }]]);
  });

  it("admits a Hermes bot through its existing durable runtime", async () => {
    await db.update(schema.aiApps).set({ provider: "hermes", kind: "runtime" }).where(eq(schema.aiApps.id, "model"));
    const result = await commitVoiceBatch(fixture.principal!, batch());
    const [run] = await db.select().from(schema.agentRuns);
    expect(run.messageId).toBe(result.messageId);
    expect(run.botId).toBe("bot"); expect(run.appId).toBe("model");
    expect(await db.select().from(schema.hermesRunContexts)).toHaveLength(1);
  });
  it("saves speech once and admits one run on repeated and concurrent requests", async () => {
    const first = await commitVoiceBatch(fixture.principal!, batch());
    const retries = await Promise.all([commitVoiceBatch(fixture.principal!, batch()), commitVoiceBatch(fixture.principal!, batch())]);
    expect(retries.every(r => r.messageId === first.messageId)).toBe(true);
    expect(await db.select().from(schema.messages)).toHaveLength(2);
    expect(await db.select().from(schema.agentRuns)).toHaveLength(1);
    expect(fixture.enqueue).toHaveBeenCalledTimes(1);
    const [run] = await db.select().from(schema.agentRuns);
    expect(run.botId).toBe("bot"); expect(run.appId).toBe("model");
  });

  it("ending an unknown request saves speech without starting a bot", async () => {
    await commitVoiceBatch(fixture.principal!, batch(false));
    await commitVoiceBatch(fixture.principal!, batch(false));
    expect(await db.select().from(schema.messages)).toHaveLength(2);
    expect(await db.select().from(schema.agentRuns)).toHaveLength(0);
  });

  it("rejects changed retry content and preserves the original transcript", async () => {
    await commitVoiceBatch(fixture.principal!, batch(false));
    const changed = batch(false); changed.fragments[0].text = "Different request";
    await expect(commitVoiceBatch(fixture.principal!, changed)).rejects.toMatchObject({ status: 409 });
    const rows = await db.select().from(schema.messages);
    expect(rows[0].parts).toEqual([{ type: "text", text: "Find my saved notes" }]);
  });

  it("does not overwrite the active run's leaf with later transcript fragments", async () => {
    await commitVoiceBatch(fixture.principal!, batch());
    const [before] = await db.select().from(schema.conversations);
    await expect(commitVoiceBatch(fixture.principal!, { ...batch(false), batchId: "batch0000002" })).rejects.toMatchObject({ status: 409 });
    const [after] = await db.select().from(schema.conversations);
    expect(after.currentLeafId).toBe(before.currentLeafId);
    expect(await db.select().from(schema.messages)).toHaveLength(2);
  });

  it("refuses another owner's chat and refuses creating over an existing private id", async () => {
    const bob = (await loadPrincipal("bob"))!;
    await expect(commitVoiceBatch(bob, batch())).rejects.toMatchObject({ status: 404 });
    const target = await resolveTurnTarget(bob, { appId: null, botId: "bot" });
    await expect(prepareVoiceConversation(bob, target, "conversation01")).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(schema.agentRuns)).toHaveLength(0);
  });

  it("restores the saved branch when voice is restarted", async () => {
    await commitVoiceBatch(fixture.principal!, batch(false));
    const target = await resolveTurnTarget(fixture.principal!, { appId: null, botId: "bot" });
    const context = await prepareVoiceConversation(fixture.principal!, target, "conversation01", "conversation01");
    expect(context.context).toContain("user: Find my saved notes"); expect(context.context).toContain("assistant: Let me check");
    await db.update(schema.conversations).set({ isGroup: true }).where(eq(schema.conversations.id, "conversation01"));
    await expect(commitVoiceBatch(fixture.principal!, batch())).rejects.toMatchObject({ status: 400 });
  });
});
