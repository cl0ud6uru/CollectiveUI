import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiApp, Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";
import type { PortalUIMessage } from "@/lib/chat/store";
import { startMockLlm } from "./helpers/mock-llm";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("group images through the real resolver and model turn", () => {
  const stamp = `group-images-${process.pid}-${Date.now()}`;
  let mock: Awaited<ReturnType<typeof startMockLlm>>, owner: Principal, other: Principal, app: AiApp;
  let bots: Bot[], ownedFile: string, foreignFile: string;
  const ids: string[] = [];
  const keys: string[] = [];
  beforeAll(async () => {
    mock = await startMockLlm();
    const { db, schema } = await import("@/db");
    const { storage } = await import("@/lib/files/storage");
    for (const name of ["owner", "other"]) {
      const [user] = await db.insert(schema.users).values({ id: `${stamp}-${name}`, upn: `${stamp}-${name}@test.invalid`, name, authSource: "ldap", prefs: { memoryEnabled: false } }).returning();
      ids.push(user.id);
      const principal = { user, groupIds: [], isAdmin: false, canCreateBots: true };
      if (name === "owner") owner = principal; else other = principal;
    }
    [app] = await db.insert(schema.aiApps).values({ name: stamp, model: "mock", baseUrl: `${mock.url}/v1`, supportsVision: true, supportsTools: false }).returning();
    bots = await db.insert(schema.bots).values(["Vision", "Text", "Third", "Fourth", "Fifth", "Sixth"].map(name => ({ ownerId: owner.user.id, appId: app.id, name, visibility: "org" as const }))).returning();
    for (const principal of [owner, other]) {
      const key = `${stamp}/${principal.user.id}.png`;
      keys.push(key);
      await storage().put(key, Buffer.from(`${principal.user.name} synthetic image bytes`));
      const [att] = await db.insert(schema.attachments).values({ userId: principal.user.id, filename: `${principal.user.name}.png`, mediaType: "image/png", size: 27, storageKey: key }).returning();
      if (principal === owner) ownedFile = att.id; else foreignFile = att.id;
    }
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    const { storage } = await import("@/lib/files/storage");
    await db.delete(schema.usageEvents).where(inArray(schema.usageEvents.userId, ids));
    await db.delete(schema.users).where(inArray(schema.users.id, ids));
    if (app) await db.delete(schema.aiApps).where(eq(schema.aiApps.id, app.id));
    await Promise.all(keys.map(key => storage().delete(key)));
    await pool.end();
    mock?.stop();
  });
  const history = (text = "@everyone look at these images"): PortalUIMessage[] => [{
    id: `${stamp}-question`, role: "user", parts: [
      { type: "text", text },
      { type: "file", url: `/api/files/${ownedFile}`, mediaType: "image/png", filename: "owner.png" },
      { type: "file", url: `/api/files/${foreignFile}`, mediaType: "image/png", filename: "other.png" },
    ],
  }];
  it("retains only this user's authorized images and provides model-specific text fallbacks", async () => {
    const { resolveAttachmentsForModel } = await import("@/lib/agent/prepare");
    const { groupTranscript } = await import("@/lib/agent/group");
    const resolved = await resolveAttachmentsForModel(history(), app, owner.user.id);
    const transcript = JSON.stringify(groupTranscript(resolved, bots[0].id));
    expect(transcript).toContain(Buffer.from("owner synthetic image bytes").toString("base64"));
    expect(transcript).not.toContain(Buffer.from("other synthetic image bytes").toString("base64"));
    expect(transcript).toContain("unavailable");
    const foreignView = JSON.stringify(groupTranscript(await resolveAttachmentsForModel(history(), app, other.user.id), bots[0].id));
    expect(foreignView).not.toContain(Buffer.from("owner synthetic image bytes").toString("base64"));
    expect(foreignView).toContain(Buffer.from("other synthetic image bytes").toString("base64"));
    const fallback = JSON.stringify(groupTranscript(await resolveAttachmentsForModel(history(), { ...app, supportsVision: false }, owner.user.id), bots[0].id));
    expect(fallback).toContain("cannot view images");
    expect(fallback).not.toContain("base64");
  });
  async function turn(input: PortalUIMessage[], members = bots.slice(0, 2).map((bot, i) => ({ bot, app: { ...app, supportsVision: i !== 1 } }))) {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { insertMessage } = await import("@/lib/chat/store");
    const { runGroupTurn } = await import("@/lib/agent/group");
    const [conversation] = await db.insert(schema.conversations).values({ userId: owner.user.id, isGroup: true }).returning();
    const messages = input.map(m => ({ ...m, id: newId() }));
    for (const m of messages) await insertMessage(conversation.id, m, null);
    const stream = await runGroupTurn({ principal: owner, conversation, members, history: messages });
    const chunks = [];
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  }
  it("sends image parts to a vision model and preserves them when a teammate turn is appended", async () => {
    const chunks = await turn(history());
    const output = chunks.filter(c => c.type === "text-delta").map(c => c.delta).join("");
    // The mock echoes @everyone, which legitimately hands back once to each bot.
    expect(chunks.filter(c => c.type === "data-speaker")).toHaveLength(4);
    expect(output).toContain("I can see the image");
    expect(chunks.filter(c => c.type === "data-bot-error")).toHaveLength(0);
    expect(chunks.at(-1)?.type).toBe("finish");
  });
  it("hands an image to another vision bot and keeps the six-reply cap", async () => {
    const chunks = await turn(history("@everyone [handoff:Vision] keep discussing"), bots.map(bot => ({ bot, app })));
    expect(chunks.filter(c => c.type === "data-speaker")).toHaveLength(6);
    expect(chunks.filter(c => c.type === "data-bot-error")).toHaveLength(0);
    expect(chunks.at(-1)?.type).toBe("finish");
  });
  it("reports an unreadable image for the vision bot but still lets a text-only teammate finish", async () => {
    const { storage } = await import("@/lib/files/storage");
    await storage().delete(keys[0]);
    const chunks = await turn(history());
    expect(chunks.filter(c => c.type === "data-bot-error")).toHaveLength(1);
    expect(chunks.filter(c => c.type === "data-speaker")).toHaveLength(2);
    expect(chunks.at(-1)?.type).toBe("finish");
  });
});
