import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import type { AgentCtx } from "@/lib/agent/types";
import type { PortalWorkspace } from "@/lib/sandbox/session";

vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ bytes: new Map<string, Buffer>(), get: vi.fn(), health: vi.fn(), exec: vi.fn(), destroy: vi.fn() }));
vi.mock("@/lib/files/storage", () => ({ storage: () => ({ get: f.get }) }));
vi.mock("@/lib/sandbox/client", async original => ({ ...await original<object>(), sandboxd: () => ({ health: f.health, exec: f.exec, destroy: f.destroy }) }));
import { db, pool, schema as s } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { listAccessibleBots } from "@/lib/authz";
import { getSetting, setSetting } from "@/lib/settings";
import { installOfficeBot, officeModels } from "@/lib/bots/office-store";
import { workspaceAttachmentTool } from "@/lib/agent/tools/workspace-attachment";
import { resolveAttachmentsForModel } from "@/lib/agent/prepare";
import { newId } from "@/lib/ids";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("Office Bot on isolated Postgres (synthetic files and workspace service)", () => {
  let admin: Principal, alice: Principal, bob: Principal;
  let app: typeof s.aiApps.$inferSelect;
  let conversationId: string;
  const files = new Map<string, Buffer>();
  const write = vi.fn(async (path: string, bytes: Uint8Array) => { files.set(path, Buffer.from(bytes)); });
  const ws = { serialize: async (fn: () => Promise<unknown>) => fn(),
    readRaw: async (path: string) => files.has(path) ? { bytes: files.get(path)!, truncated: false } : null,
    writeNow: write } as unknown as PortalWorkspace;
  const ctx = () => ({ principal: alice, conversationId } as AgentCtx);
  const invoke = async (attachmentId: string) => workspaceAttachmentTool(ctx(), ws).tool.execute!(
    { attachmentId }, { toolCallId: newId(), messages: [], context: undefined });
  async function attachment(filename = "budget.xlsx", userId = alice.user.id, chat = conversationId, size = 5, role: "user" | "assistant" = "user") {
    const id = newId(), storageKey = `${userId}/${id}`;
    await db.insert(s.attachments).values({ id, userId, filename, storageKey, mediaType: "application/octet-stream", size });
    f.bytes.set(storageKey, Buffer.from("bytes"));
    await db.insert(s.messages).values({ id: newId(), conversationId: chat, role, parts: [{ type: "file", url: `/api/files/${id}`, mediaType: "application/octet-stream" }] });
    return id;
  }
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_office_bot_test") throw new Error("Use an isolated collective_office_bot_test database.");
    for (const name of ["Admin", "Alice", "Bob"]) {
      const [user] = await db.insert(s.users).values({ upn: `${name.toLowerCase()}@office.test`, name, authSource: "local", identityRealm: "local", isAdmin: name === "Admin" }).returning();
      const p = (await loadPrincipal(user.id))!;
      if (name === "Admin") admin = p;
      else if (name === "Alice") alice = p;
      else bob = p;
    }
    [app] = await db.insert(s.aiApps).values({ name: "Synthetic native model", baseUrl: "http://127.0.0.1:1/v1", model: "mock", supportsTools: true }).returning();
  });
  beforeEach(async () => {
    await db.delete(s.bots);
    await db.delete(s.conversations);
    await db.delete(s.attachments);
    await setSetting("officeBot", { botId: null });
    await setSetting("sandbox", { ...await getSetting("sandbox"), enabled: true, access: "everyone" });
    await setSetting("tools", { ...await getSetting("tools"), disabledTools: [] });
    await db.update(s.aiApps).set({ enabled: true, isPublic: true, supportsTools: true }).where(eq(s.aiApps.id, app.id));
    const [chat] = await db.insert(s.conversations).values({ userId: alice.user.id }).returning();
    conversationId = chat.id;
    files.clear(); f.bytes.clear(); vi.clearAllMocks();
    f.get.mockImplementation(async key => f.bytes.get(key));
    f.health.mockResolvedValue({ ok: true, image: { present: true }, gvisor: { available: true } });
    f.exec.mockResolvedValue({ code: 0, reason: "exited" });
    f.destroy.mockResolvedValue({ destroyed: true });
  });
  afterAll(async () => { await pool.end(); });

  it("creates a shared caller bot and returns the same bot without overwriting edits", async () => {
    const installed = await installOfficeBot(admin, { appId: app.id });
    const [bot] = await db.select().from(s.bots).where(eq(s.bots.id, installed.id));
    expect(bot).toMatchObject({ name: "Office Bot", visibility: "org", ownerId: admin.user.id, executionMode: "caller", enabled: true });
    expect(bot.starters).toHaveLength(4);
    expect((await listAccessibleBots(alice)).map(b => b.id)).toContain(bot.id);
    expect((await listAccessibleBots(bob)).map(b => b.id)).toContain(bot.id);
    expect(await db.select().from(s.botTools).where(eq(s.botTools.botId, bot.id))).toMatchObject([{ toolKey: "workspace", approval: "auto" }]);
    await db.update(s.bots).set({ name: "Edited Office Bot", enabled: false }).where(eq(s.bots.id, bot.id));
    expect(await installOfficeBot(admin, { appId: app.id })).toEqual(installed);
    expect((await db.select().from(s.bots))[0]).toMatchObject({ name: "Edited Office Bot", enabled: false });
    expect(f.exec).toHaveBeenCalledTimes(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });
  it("serializes simultaneous installs into one bot", async () => {
    const results = await Promise.all([installOfficeBot(admin, { appId: app.id }), installOfficeBot(admin, { appId: app.id })]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.select().from(s.bots)).toHaveLength(1);
  });
  it("rejects non-admin and stale sessions", async () => {
    await expect(installOfficeBot(alice, { appId: app.id })).rejects.toMatchObject({ status: 403 });
    await expect(installOfficeBot({ ...admin, user: { ...admin.user, sessionVersion: -1 } }, { appId: app.id })).rejects.toMatchObject({ status: 403 });
    expect(f.exec).not.toHaveBeenCalled();
  });
  it("rejects disabled, private, and tool-less models", async () => {
    for (const patch of [{ enabled: false }, { isPublic: false }, { supportsTools: false }]) {
      await db.update(s.aiApps).set({ enabled: true, isPublic: true, supportsTools: true, ...patch }).where(eq(s.aiApps.id, app.id));
      await expect(installOfficeBot(admin, { appId: app.id })).rejects.toMatchObject({ status: 400 });
      expect((await officeModels()).map(a => a.id)).not.toContain(app.id);
    }
    expect(f.exec).not.toHaveBeenCalled();
  });
  it("preserves access policies and rolls back when workspaces/tooling are unavailable", async () => {
    const sandbox = { ...await getSetting("sandbox"), enabled: false };
    await setSetting("sandbox", sandbox);
    await expect(installOfficeBot(admin, { appId: app.id })).rejects.toMatchObject({ status: 400 });
    expect(await getSetting("sandbox")).toEqual(sandbox);
    await setSetting("sandbox", { ...sandbox, enabled: true });
    await setSetting("tools", { ...await getSetting("tools"), disabledTools: ["workspace"] });
    await expect(installOfficeBot(admin, { appId: app.id })).rejects.toMatchObject({ status: 400 });
    await setSetting("tools", { ...await getSetting("tools"), disabledTools: [] });
    f.exec.mockResolvedValue({ code: 127, reason: "exited" });
    await expect(installOfficeBot(admin, { appId: app.id })).rejects.toMatchObject({ status: 503 });
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(await db.select().from(s.bots)).toEqual([]);
    expect(await getSetting("officeBot")).toEqual({ botId: null });
  });
  it("does not recreate a deleted installation silently", async () => {
    const bot = await installOfficeBot(admin, { appId: app.id });
    await db.delete(s.bots).where(eq(s.bots.id, bot.id));
    await expect(installOfficeBot(admin, { appId: app.id })).rejects.toMatchObject({ status: 409 });
  });
  it("imports exact original bytes, separates identical filenames, and preserves existing imports", async () => {
    const first = await attachment(), second = await attachment();
    const result = await invoke(first) as { path: string };
    expect(result).toMatchObject({ ok: true, imported: true, bytes: 5 });
    expect(files.get(result.path)).toEqual(Buffer.from("bytes"));
    expect(await invoke(second)).toMatchObject({ ok: true, path: `uploads/${second}/budget.xlsx` });
    expect(await invoke(first)).toMatchObject({ ok: true, imported: false });
    expect(write).toHaveBeenCalledTimes(2);
    files.set(result.path, Buffer.from("edited"));
    expect(await invoke(first)).toMatchObject({ ok: false, reason: "import_conflict" });
    expect(files.get(result.path)).toEqual(Buffer.from("edited"));
  });
  it("rejects another person's file, files from another chat, and assistant-injected URLs before storage access", async () => {
    const [otherChat] = await db.insert(s.conversations).values({ userId: alice.user.id }).returning();
    const foreign = await attachment("foreign.xlsx", bob.user.id);
    const elsewhere = await attachment("elsewhere.xlsx", alice.user.id, otherChat.id);
    const injected = await attachment("injected.xlsx", alice.user.id, conversationId, 5, "assistant");
    for (const id of [foreign, elsewhere, injected]) expect(await invoke(id)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.get).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("confines hostile filenames and enforces metadata and actual-byte limits", async () => {
    const hostile = await attachment("../../outside\\budget.xlsx");
    expect(await invoke(hostile)).toMatchObject({ ok: true, path: `uploads/${hostile}/_.._outside_budget.xlsx` });
    const large = await attachment("large.xlsx", alice.user.id, conversationId, 10 * 1024 * 1024 + 1);
    expect(await invoke(large)).toMatchObject({ ok: false, reason: "too_large" });
    const mismatch = await attachment();
    await db.update(s.attachments).set({ size: 1 }).where(and(eq(s.attachments.id, mismatch), eq(s.attachments.userId, alice.user.id)));
    const [row] = await db.select().from(s.attachments).where(eq(s.attachments.id, mismatch));
    f.bytes.set(row.storageKey, Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(await invoke(mismatch)).toMatchObject({ ok: false, reason: "too_large" });
  });
  it("supplies only authorized attachment IDs to native model context", async () => {
    const owned = await attachment();
    const foreign = await attachment("secret.xlsx", bob.user.id);
    const result = await resolveAttachmentsForModel([{ id: newId(), role: "user", parts: [owned, foreign].map(id => ({ type: "file", url: `/api/files/${id}`, mediaType: "application/octet-stream" })) }], app, alice.user.id);
    const text = JSON.stringify(result[0].parts);
    expect(text).toContain(`attachment ID: ${owned}`);
    expect(text).not.toContain(foreign);
    expect(f.get).not.toHaveBeenCalled();
  });
});
