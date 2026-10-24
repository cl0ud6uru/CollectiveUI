import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
import type { ReplyContext } from "@/lib/chat/reply";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/jobs", () => ({ enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => fixture.principal,
  errorResponse: (error: Error & { status?: number }) => Response.json({ error: error.message }, { status: error.status ?? 500 }) }));
vi.mock("@/lib/runs/tail", () => ({ tailRun: () => new ReadableStream({ start(controller) { controller.close(); } }) }));

import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { newId } from "@/lib/ids";
import { POST } from "@/app/api/chat/route";
import { GET } from "@/app/api/chat/[id]/route";
import { continueSharedConversation } from "@/app/(chat)/actions";
import { resolveReplyReference } from "@/lib/chat/reply-server";

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45_000);
beforeEach(async () => {
  vi.stubEnv("AUTH_URL", "http://localhost");
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values(["alice", "bob"].map(id => ({ id, name: id, upn: `${id}@test.invalid`, authSource: "local" as const, identityRealm: "local" as const })));
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic model", provider: "openai-compatible", baseUrl: "https://model.test.invalid/v1", model: "fixture", isPublic: true });
  fixture.principal = (await loadPrincipal("alice"))!;
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

async function sharedChat(group = false) {
  const [conversation] = await db.insert(schema.conversations).values({ userId: "bob", appId: "model", isGroup: group }).returning();
  const questionId = newId(), answerId = newId(), quoteId = newId(), token = newId();
  await db.insert(schema.messages).values([
    { id: questionId, conversationId: conversation.id, role: "user", parts: [{ type: "text", text: "Original question" }] },
    { id: answerId, conversationId: conversation.id, parentId: questionId, role: "assistant", parts: [{ type: "text", text: "Original answer" }] },
    { id: quoteId, conversationId: conversation.id, parentId: answerId, role: "user", parts: [{ type: "text", text: "Follow-up" }],
      metadata: { model: "fixture", replayKey: "private-account-key", replyTo: { messageId: answerId, author: "Synthetic model", excerpt: "Original answer" } } },
  ]);
  await db.insert(schema.sharedLinks).values({ id: token, conversationId: conversation.id, createdBy: "bob", cutoffMessageId: quoteId });
  return { conversation, questionId, answerId, quoteId, token };
}

describe("shared conversation reply copies through production actions and routes", () => {
  it("remaps quoted replies, exposes the new reference in snapshots, and accepts an edited reply", async () => {
    const source = await sharedChat();
    const copyId = await continueSharedConversation(source.token);
    const copies = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, copyId));
    const quote = copies.find(row => !!row.metadata?.replyTo)!;
    const reply = quote.metadata!.replyTo as ReplyContext;
    expect(reply.messageId).toBe(quote.parentId);
    expect(reply.messageId).not.toBe(source.answerId);
    expect(quote.metadata).toMatchObject({ model: "fixture", replyTo: { excerpt: "Original answer" } });
    expect(quote.metadata).not.toHaveProperty("replayKey");
    expect(resolveReplyReference(copies, copyId, quote.parentId, reply, "Synthetic model")).toMatchObject(reply);

    // Both web reloads and native clients use this snapshot route.
    const snapshot = await GET(new Request(`http://localhost/api/chat/${copyId}`), { params: Promise.resolve({ id: copyId }) });
    expect(snapshot.status).toBe(200);
    const serialized = JSON.stringify(await snapshot.json());
    expect(serialized).toContain(reply.messageId);
    expect(serialized).not.toContain(source.answerId);

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: copyId, parentId: quote.parentId, replyTo: { messageId: reply.messageId },
        message: { id: newId(), role: "user", parts: [{ type: "text", text: "Edited follow-up" }] } }),
    }));
    await response.text();
    expect(response.status).toBe(200);
    const [original] = await db.select().from(schema.messages).where(eq(schema.messages.id, source.quoteId));
    expect(original.metadata).toHaveProperty("replyTo.messageId", source.answerId);
    expect(original.metadata).toHaveProperty("replayKey", "private-account-key");
  });

  it("keeps the selected repeated group speaker when private file parts are removed", async () => {
    const source = await sharedChat(true);
    const attachmentId = newId();
    await db.insert(schema.attachments).values({ id: attachmentId, userId: "bob", filename: "private.txt", mediaType: "text/plain", size: 1, storageKey: `bob/${attachmentId}` });
    await db.update(schema.messages).set({ parts: [
      { type: "file", url: `/api/files/${attachmentId}`, mediaType: "text/plain" },
      { type: "data-speaker", data: { botId: "research", name: "Research" } },
      { type: "text", text: "First answer" },
      { type: "file", url: `/api/files/${attachmentId}`, mediaType: "text/plain" },
      { type: "data-speaker", data: { botId: "research", name: "Research" } },
      { type: "text", text: "Revised answer" },
    ] }).where(eq(schema.messages.id, source.answerId));
    await db.update(schema.messages).set({ metadata: { replyTo: { messageId: source.answerId, speakerIndex: 4, author: "Research", excerpt: "Revised answer", botId: "research" } } }).where(eq(schema.messages.id, source.quoteId));
    const copyId = await continueSharedConversation(source.token);
    const copies = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, copyId));
    const quote = copies.find(row => !!row.metadata?.replyTo)!;
    const reply = quote.metadata!.replyTo as ReplyContext;
    expect(reply).toMatchObject({ messageId: quote.parentId, speakerIndex: 2, botId: "research", excerpt: "Revised answer" });
    expect(resolveReplyReference(copies, copyId, quote.parentId, reply, "Group")).toMatchObject({ messageId: quote.parentId, speakerIndex: 2, author: "Research" });
    expect(JSON.stringify(copies)).not.toContain(`/api/files/${attachmentId}`);
  });

  it.each(["sibling", "self", "future", "malformed-speaker"])("drops a %s reply reference instead of preserving a broken target", async kind => {
    const source = await sharedChat();
    const sibling = newId(), future = newId();
    await db.insert(schema.messages).values([
      { id: sibling, conversationId: source.conversation.id, parentId: source.questionId, role: "assistant", parts: [{ type: "text", text: "Other branch" }] },
      { id: future, conversationId: source.conversation.id, parentId: source.quoteId, role: "assistant", parts: [{ type: "text", text: "Beyond shared cutoff" }] },
    ]);
    const messageId = kind === "self" ? source.quoteId : kind === "future" ? future : kind === "sibling" ? sibling : source.answerId;
    await db.update(schema.messages).set({ metadata: { model: "fixture", replyTo: { messageId, author: "Assistant", excerpt: "Invalid quote", ...(kind === "malformed-speaker" ? { speakerIndex: -1 } : {}) } } }).where(eq(schema.messages.id, source.quoteId));
    const copyId = await continueSharedConversation(source.token);
    const copies = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, copyId));
    const quote = copies.find(row => row.parentId && row.role === "user")!;
    expect(quote.metadata).toEqual({ model: "fixture" });
  });
});
