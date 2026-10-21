import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Principal } from "@/lib/auth/groups";
import type { StorageAdapter } from "@/lib/files/storage";

const enabled = process.env.ATTACHMENT_POSTGRES_PROOF === "1";
const fixtureURL = process.env.ATTACHMENT_POSTGRES_URL;
if (enabled) {
  const url = new URL(fixtureURL ?? "invalid:");
  if (url.protocol !== "postgres:" || url.hostname !== "127.0.0.1" || url.port !== "55445" ||
      url.pathname !== "/collective_attachments_test" || url.search || url.hash ||
      Object.keys(process.env).some(key => key.startsWith("PG") && process.env[key])) {
    throw new Error("Requires the explicit dedicated loopback attachment fixture with no PG overrides");
  }
}
const fixture = vi.hoisted(() => ({
  principal: null as Principal | null,
  blobs: new Map<string, Buffer>(),
  put: vi.fn<StorageAdapter["put"]>(), get: vi.fn<StorageAdapter["get"]>(), delete: vi.fn<StorageAdapter["delete"]>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({
  requirePrincipal: async () => fixture.principal!,
  errorResponse: (error: { status?: number; message: string }) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/runs/store", () => ({ stopRuns: vi.fn() }));
vi.mock("@/lib/runs/provider-stop", () => ({ stopRunsBeforeDelete: vi.fn() }));
vi.mock("@/lib/files/storage", () => ({ storage: () => fixture }));

let q: typeof import("@/db");
let lifecycle: typeof import("@/lib/files/lifecycle");
let actions: typeof import("@/app/(chat)/actions");
let owner: Principal, other: Principal;
const filePart = (id: string) => ({ type: "file" as const, url: `/api/files/${id}`, filename: `${id}.txt`, mediaType: "text/plain" });
const adapter = (): StorageAdapter => fixture;
const row = async (id: string) => (await q.db.select().from(q.schema.attachments).where(eq(q.schema.attachments.id, id)))[0];
async function attachment(id: string, over: Partial<typeof q.schema.attachments.$inferInsert> = {}) {
  const values = { id, userId: "attachment-owner", filename: `${id}.txt`, mediaType: "text/plain", size: 5, storageKey: `attachment-owner/${id}`, extractedText: "private extracted text", ...over };
  await q.db.insert(q.schema.attachments).values(values);
  fixture.blobs.set(values.storageKey, Buffer.from("hello"));
}
async function chat(id: string, userId = "attachment-owner", files: string[] = []) {
  await q.db.insert(q.schema.conversations).values({ id, userId });
  if (files.length) await q.db.insert(q.schema.messages).values({ id: `${id}Message`, conversationId: id, role: "user", parts: files.map(filePart) });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe.skipIf(!enabled)("attachment retirement on disposable PostgreSQL with synthetic storage", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = fixtureURL!;
    process.env.AUTH_URL = "http://fixture.invalid";
    q = await import("@/db");
    lifecycle = await import("@/lib/files/lifecycle");
    actions = await import("@/app/(chat)/actions");
    await q.db.insert(q.schema.users).values([
      { id: "attachment-owner", name: "Owner", upn: "attachment-owner@fixture.invalid", isAdmin: true, authSource: "ldap" },
      { id: "attachment-other", name: "Other", upn: "attachment-other@fixture.invalid", authSource: "ldap" },
    ]);
    const { loadPrincipal } = await import("@/lib/auth/groups");
    owner = (await loadPrincipal("attachment-owner"))!;
    other = (await loadPrincipal("attachment-other"))!;
    await q.db.insert(q.schema.aiApps).values({ id: "attachment-app", name: "Synthetic model", model: "synthetic", provider: "openai-compatible", baseUrl: "https://fixture.invalid", supportsTools: true });
    await q.db.insert(q.schema.bots).values({ id: "attachment-bot", ownerId: owner.user.id, appId: "attachment-app", name: "Synthetic bot" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External requests prohibited in this proof"); }));
  });
  beforeEach(async () => {
    await q.db.delete(q.schema.conversations);
    await q.db.delete(q.schema.knowledgeChunks);
    await q.db.delete(q.schema.attachments);
    fixture.principal = owner;
    fixture.blobs.clear();
    fixture.put.mockReset().mockImplementation(async (key, bytes) => { fixture.blobs.set(key, bytes); });
    fixture.get.mockReset().mockImplementation(async key => { const blob = fixture.blobs.get(key); if (!blob) throw new Error("Missing fixture blob"); return blob; });
    fixture.delete.mockReset().mockImplementation(async key => { fixture.blobs.delete(key); });
  });
  afterAll(async () => { vi.unstubAllGlobals(); await q?.pool.end(); });

  it("single-chat deletion removes only unreferenced owned files, preserving other branches, owners and knowledge", async () => {
    for (const id of ["only", "shared", "knowledge"]) await attachment(id);
    await attachment("foreign", { userId: other.user.id, storageKey: "attachment-other/foreign" });
    await chat("delete-chat", owner.user.id, ["only", "shared", "knowledge", "foreign"]);
    await chat("keep-chat", other.user.id, ["shared"]); // even another owner's reference protects the file
    await q.db.insert(q.schema.knowledgeChunks).values({ botId: "attachment-bot", attachmentId: "knowledge", chunkIndex: 0, content: "keep" });
    await actions.deleteConversation("delete-chat");
    expect(await row("only")).toBeUndefined();
    expect(fixture.delete.mock.calls).toEqual([["attachment-owner/only"]]);
    for (const id of ["shared", "knowledge", "foreign"]) expect(await row(id)).toBeDefined();
    expect(await q.db.select().from(q.schema.knowledgeChunks)).toHaveLength(1);
  });
  it("delete-all removes all actor chats and files while preserving other users and fresh drafts", async () => {
    await attachment("one"); await attachment("two"); await attachment("draft");
    await attachment("other", { userId: other.user.id });
    await chat("chat-one", owner.user.id, ["one"]); await chat("chat-two", owner.user.id, ["two"]);
    await chat("chat-other", other.user.id, ["other"]);
    await actions.deleteAllConversations();
    expect(await q.db.select({ id: q.schema.conversations.id }).from(q.schema.conversations)).toEqual([{ id: "chat-other" }]);
    expect((await q.db.select().from(q.schema.attachments)).map(a => a.id).sort()).toEqual(["draft", "other"]);
  });
  it("mobile deletion reaches the same cleanup; cross-owner deletion is denied without touching storage", async () => {
    await attachment("mobile"); await chat("mobile-chat", owner.user.id, ["mobile"]);
    const { DELETE } = await import("@/app/api/mobile/v1/conversations/[id]/route");
    fixture.principal = other;
    const request = new Request("http://fixture.invalid/api/mobile/v1/conversations/mobile-chat", { method: "DELETE" });
    const params = { params: Promise.resolve({ id: "mobile-chat" }) };
    expect((await DELETE(request, params)).status).toBe(404);
    expect(fixture.delete).not.toHaveBeenCalled();
    fixture.principal = owner;
    expect((await DELETE(request, params)).status).toBe(204);
    expect(await row("mobile")).toBeUndefined();
  });
  it("retains failed deletion metadata and clears extracted text, then resumes after process restart", async () => {
    await attachment("retry"); await chat("retry-chat", owner.user.id, ["retry"]);
    fixture.delete.mockRejectedValueOnce(new Error("Synthetic storage unavailable"));
    await actions.deleteConversation("retry-chat");
    expect(await row("retry")).toMatchObject({ storageKey: "attachment-owner/retry", extractedText: null, deletedAt: expect.any(Date) });
    expect(fixture.blobs.has("attachment-owner/retry")).toBe(true);
    expect(await lifecycle.sweepAttachments(new Date(), adapter())).toEqual({ deleted: 1, failed: 0 });
    expect(await row("retry")).toBeUndefined();
  });
  it("sweeps abandoned uploads after 24h while retaining fresh drafts and old referenced uploads", async () => {
    const now = new Date("2030-01-03T00:00:00Z"), old = new Date("2030-01-01T00:00:00Z");
    await attachment("orphan", { createdAt: old });
    await attachment("interrupted", { createdAt: old, uploadComplete: false });
    await attachment("fresh", { createdAt: new Date(now.getTime() - lifecycle.ATTACHMENT_DRAFT_GRACE_MS + 1) });
    await attachment("referenced", { createdAt: old }); await chat("reference-chat", owner.user.id, ["referenced"]);
    expect(await lifecycle.sweepAttachments(now, adapter())).toEqual({ deleted: 2, failed: 0 });
    expect((await q.db.select().from(q.schema.attachments)).map(a => a.id).sort()).toEqual(["fresh", "referenced"]);
  });
  it.each(["message", "knowledge"])("a %s writer's row lock protects an attachment before its transaction commits", async kind => {
    await attachment("racing"); await chat("race-chat");
    const client = await q.pool.connect();
    try {
      await client.query("BEGIN");
      if (kind === "message") await client.query("INSERT INTO messages (id,conversation_id,role,parts) VALUES ($1,$2,'user',$3)", ["race-message", "race-chat", JSON.stringify([filePart("racing")])]);
      else await client.query("INSERT INTO knowledge_chunks (id,bot_id,attachment_id,chunk_index,content) VALUES ('race-knowledge','attachment-bot','racing',0,'keep')");
      expect(await lifecycle.retireAttachments({ userId: owner.user.id, ids: ["racing"] }, adapter())).toEqual({ deleted: 0, failed: 0 });
      await client.query("COMMIT");
      expect(await lifecycle.retireAttachments({ ids: ["racing"] }, adapter())).toEqual({ deleted: 0, failed: 0 });
      expect(fixture.delete).not.toHaveBeenCalled();
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("a committed tombstone refuses new message and knowledge references while slow deletion holds no DB/user lock", async () => {
    await attachment("retired"); await chat("retired-chat");
    const entered = deferred(), finish = deferred();
    fixture.delete.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
    const retiring = lifecycle.retireAttachments({ ids: ["retired"] }, adapter());
    await entered.promise;
    try {
      const client = await q.pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout = '500ms'");
        // Both lock types are free during storage I/O; tombstone is durable before any deletion starts.
        await client.query("SELECT id FROM attachments WHERE id='retired' FOR UPDATE NOWAIT");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('runs:attachment-owner',0))");
        await client.query("COMMIT");
      } finally { client.release(); }
      await expect(q.db.insert(q.schema.messages).values({ id: "too-late", conversationId: "retired-chat", role: "user", parts: [filePart("retired")] })).rejects.toMatchObject({ cause: { code: "23514" } });
      await q.db.insert(q.schema.messages).values({ id: "empty-message", conversationId: "retired-chat", role: "user", parts: [] });
      await expect(q.db.update(q.schema.messages).set({ parts: [filePart("retired")] }).where(eq(q.schema.messages.id, "empty-message"))).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(q.db.insert(q.schema.knowledgeChunks).values({ botId: "attachment-bot", attachmentId: "retired", chunkIndex: 0, content: "too late" })).rejects.toMatchObject({ cause: { code: "23514" } });
    } finally { finish.resolve(); await retiring; }
  });
  it("deleting a conversation releases its user admission lock before slow storage removal", async () => {
    await attachment("slow"); await chat("slow-chat", owner.user.id, ["slow"]);
    const entered = deferred(), finish = deferred();
    fixture.delete.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; });
    const deleting = actions.deleteConversation("slow-chat");
    await entered.promise;
    try {
      const client = await q.pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout = '500ms'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('runs:attachment-owner',0))");
        await client.query("COMMIT");
      } finally { client.release(); }
      expect(await row("slow")).toMatchObject({ deletedAt: expect.any(Date) });
    } finally { finish.resolve(); await deleting; }
  });
  it.each(["deleted", "incomplete"])("all original-byte/extracted-text readers refuse %s files, including admin download", async kind => {
    await attachment("hidden", kind === "deleted" ? { deletedAt: new Date() } : { uploadComplete: false });
    await attachment("hiddenForeign", { userId: other.user.id, ...(kind === "deleted" ? { deletedAt: new Date() } : { uploadComplete: false }) });
    const { GET } = await import("@/app/api/files/[id]/route");
    expect((await GET(new Request("http://fixture.invalid"), { params: Promise.resolve({ id: "hiddenForeign" }) })).status).toBe(404);
    expect((await GET(new Request("http://fixture.invalid"), { params: Promise.resolve({ id: "hidden" }) })).status).toBe(404);
    const { resolveAttachmentsForModel } = await import("@/lib/agent/prepare");
    const [app] = await q.db.select().from(q.schema.aiApps).where(eq(q.schema.aiApps.id, "attachment-app"));
    const output = await resolveAttachmentsForModel([{ id: "hidden-msg", role: "user", parts: [filePart("hidden")] }], app, owner.user.id);
    expect(JSON.stringify(output)).toContain("unavailable"); expect(JSON.stringify(output)).not.toContain("private extracted text");
    const { workspaceAttachmentTool } = await import("@/lib/agent/tools/workspace-attachment");
    const entry = workspaceAttachmentTool({ principal: owner, conversationId: "missing-chat" } as never, {} as never);
    expect(await entry.tool.execute!({ attachmentId: "hidden" }, { toolCallId: "fixture", messages: [] } as never)).toMatchObject({ ok: false, reason: "unavailable" });
    const { addKnowledgeFile } = await import("@/app/(chat)/bots/actions");
    await expect(addKnowledgeFile("attachment-bot", "hidden")).rejects.toMatchObject({ status: 404 });
    expect(fixture.get).not.toHaveBeenCalled();
  });
  it("upload failure retains an inaccessible cleanup record rather than losing the storage key", async () => {
    fixture.put.mockImplementationOnce(async (key, bytes) => { fixture.blobs.set(key, bytes); throw new Error("Synthetic interrupted write"); });
    const { POST } = await import("@/app/api/files/route");
    const form = new FormData(); form.set("file", new File(["fixture bytes"], "test.png", { type: "image/png" }));
    expect((await POST(new Request("http://fixture.invalid/api/files", { method: "POST", headers: { Origin: "http://fixture.invalid" }, body: form }))).status).toBe(500);
    const [pending] = await q.db.select().from(q.schema.attachments);
    expect(pending).toMatchObject({ uploadComplete: false, userId: owner.user.id });
    expect(fixture.blobs.has(pending.storageKey)).toBe(true);
    await q.db.update(q.schema.attachments).set({ createdAt: new Date(0) }).where(eq(q.schema.attachments.id, pending.id));
    expect(await lifecycle.sweepAttachments(new Date(), adapter())).toEqual({ deleted: 1, failed: 0 });
  });
  it("active upload I/O holds only its attachment lock and cannot be retired even after the grace expires", async () => {
    const entered = deferred(), finish = deferred();
    fixture.put.mockImplementationOnce(async (key, bytes) => { fixture.blobs.set(key, bytes); entered.resolve(); await finish.promise; });
    const { POST } = await import("@/app/api/files/route");
    const form = new FormData(); form.set("file", new File(["fixture bytes"], "test.png", { type: "image/png" }));
    const uploading = POST(new Request("http://fixture.invalid/api/files", { method: "POST", headers: { Origin: "http://fixture.invalid" }, body: form }));
    await entered.promise;
    try {
      expect(await lifecycle.sweepAttachments(new Date(Date.now() + 7 * lifecycle.ATTACHMENT_DRAFT_GRACE_MS), adapter())).toEqual({ deleted: 0, failed: 0 });
      expect(fixture.delete).not.toHaveBeenCalled();
    } finally { finish.resolve(); }
    expect((await uploading).status).toBe(200);
    expect((await q.db.select().from(q.schema.attachments))[0].uploadComplete).toBe(true);
  });
  it("handles more than one bounded batch in explicit chat cleanup", async () => {
    const ids = Array.from({ length: 102 }, (_, index) => `batch${index}`);
    await q.db.insert(q.schema.attachments).values(ids.map(id => ({ id, userId: owner.user.id, filename: id, mediaType: "text/plain", size: 0, storageKey: `attachment-owner/${id}` })));
    expect(await lifecycle.retireAttachments({ userId: owner.user.id, ids }, adapter())).toEqual({ deleted: 102, failed: 0 });
    expect(await q.db.select().from(q.schema.attachments).where(inArray(q.schema.attachments.id, ids))).toHaveLength(0);
  });
  it("rotates failed tombstones so a full failing batch cannot starve older unattempted orphans", async () => {
    const ids = Array.from({ length: 102 }, (_, index) => `orphan${String(index).padStart(3, "0")}`);
    await q.db.insert(q.schema.attachments).values(ids.map(id => ({ id, userId: owner.user.id, filename: id, mediaType: "text/plain", size: 0, storageKey: `attachment-owner/${id}`, createdAt: new Date(0) })));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fixture.delete.mockRejectedValue(new Error("Synthetic per-key failure"));
      expect(await lifecycle.sweepAttachments(new Date(), adapter())).toEqual({ deleted: 0, failed: 100 });
      fixture.delete.mockImplementation(async key => { if (!key.endsWith("100") && !key.endsWith("101")) throw new Error("Still unavailable"); });
      expect(await lifecycle.sweepAttachments(new Date(), adapter())).toEqual({ deleted: 2, failed: 98 });
      expect(await row("orphan100")).toBeUndefined(); expect(await row("orphan101")).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});
