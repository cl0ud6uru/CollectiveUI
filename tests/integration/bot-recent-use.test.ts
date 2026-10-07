import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";

// This concurrency fixture is restricted to an explicitly named disposable local database.
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const run = url?.hostname === "127.0.0.1" && url.pathname === "/collective_recent_test" ? describe : describe.skip;
vi.mock("@/lib/jobs", () => ({ enqueueRun: vi.fn(async () => {}), scheduleMemoryExtraction: vi.fn() }));

run("real PostgreSQL recent-send lock ordering", () => {
  let principal: Principal;
  let botId: string, appId: string, conversationId: string;
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const id = newId();
    await db.insert(schema.users).values({ id, upn: `${id}@test.invalid`, name: "Synthetic recent-use owner", authSource: "local", identityRealm: "local", prefs: { customInstructions: "Retain this" } });
    principal = (await loadPrincipal(id))!;
    const [app] = await db.insert(schema.aiApps).values({ name: "Synthetic recent-use model", provider: "openai-compatible", baseUrl: "https://model.test.invalid/v1", model: "synthetic", isPublic: true }).returning();
    appId = app.id;
    const [bot] = await db.insert(schema.bots).values({ ownerId: id, name: "Synthetic recent-use bot", appId }).returning();
    botId = bot.id;
    const [conversation] = await db.insert(schema.conversations).values({ userId: id, botId, isBotHome: true }).returning();
    conversationId = conversation.id;
  });
  afterAll(async () => {
    const { db, schema, pool } = await import("@/db");
    if (principal) await db.delete(schema.users).where(eq(schema.users.id, principal.user.id));
    if (appId) await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await pool.end();
  });
  it("lets a concurrent home opener finish before the blocked send writes its conversation", async () => {
    const { db, schema, pool } = await import("@/db");
    const { startRun } = await import("@/lib/runs/store");
    const { newId } = await import("@/lib/ids");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, botId));
    const [app] = await db.select().from(schema.aiApps).where(eq(schema.aiApps.id, appId));
    const opener = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await opener.query("BEGIN");
      await opener.query("SET LOCAL statement_timeout = '5s'");
      // Hold the same user/bot share locks as openBotHome, at its pre-upsert boundary.
      await opener.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [principal.user.id]);
      await opener.query("SELECT id FROM bots WHERE id=$1 FOR SHARE", [botId]);
      pending = startRun({ principal, conversation, bot, app, parentId: null, userMessage: { id: newId(), role: "user", parts: [{ type: "text", text: "Synthetic accepted send" }] } }).then(run => ({ run }), error => ({ error }));
      await expect.poll(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%\"users\"%' AND pid <> pg_backend_pid()" )).rows[0].n).toBeGreaterThan(0);
      // Before the fix this update deadlocked with the send's already-locked conversation row.
      await opener.query("UPDATE conversations SET is_bot_home=true WHERE id=$1", [conversationId]);
      await opener.query("COMMIT");
      await expect(pending).resolves.toMatchObject({ run: { status: "queued" } });
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, principal.user.id));
      expect(user.prefs).toMatchObject({ customInstructions: "Retain this", botLastSentAt: { [botId]: expect.any(String) } });
    } finally {
      await opener.query("ROLLBACK"); opener.release();
      if (pending) await pending;
    }
  }, 15_000);
});
