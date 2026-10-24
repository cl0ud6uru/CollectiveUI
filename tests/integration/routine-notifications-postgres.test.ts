import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { routineFixtureURL } from "../fixtures/routines/disposable-database";
import { db, pool, schema } from "@/db";
import { newId } from "@/lib/ids";
import { afterRunTransition } from "@/lib/runs/hooks";
import { reconcileRoutines } from "@/lib/runs/sweeper";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/entra", () => ({ graphFetch: vi.fn(() => { throw new Error("No email in the lock fixture"); }) }));

const enabled = process.env.ROUTINE_ADMISSION_TEST === "1";
if (enabled) routineFixtureURL("admission");

describe.skipIf(!enabled)("routine notification parent locks on disposable PostgreSQL", () => {
  let userId: string, appId: string, conversationId: string, routineId: string, routineRunId: string;
  let agent: typeof schema.agentRuns.$inferSelect;

  beforeEach(async () => {
    userId = newId();
    await db.insert(schema.users).values({ id: userId, upn: `${userId}@fixture.invalid`, name: "Synthetic notification owner", authSource: "local", identityRealm: "local" });
    const [app] = await db.insert(schema.aiApps).values({ name: "Synthetic notification model", model: "never-execute", baseUrl: "http://127.0.0.1:1/v1" }).returning();
    appId = app.id;
    const [bot] = await db.insert(schema.bots).values({ ownerId: userId, appId, name: "Synthetic notification bot" }).returning();
    const [routine] = await db.insert(schema.routines).values({ ownerId: userId, botId: bot.id, name: "Synthetic routine", prompt: "Never execute", triggerType: "cron", cron: "0 * * * *", notifyEmail: false }).returning();
    routineId = routine.id;
    const [conversation] = await db.insert(schema.conversations).values({ userId, botId: bot.id, source: "routine" }).returning();
    conversationId = conversation.id;
    const [run] = await db.insert(schema.routineRuns).values({ routineId, conversationId, status: "running", trigger: "manual", createdAt: new Date(Date.now() - 300_000) }).returning();
    routineRunId = run.id;
    const messageId = newId();
    await db.insert(schema.messages).values({ id: messageId, conversationId, role: "assistant", parts: [{ type: "text", text: "Synthetic result" }] });
    [agent] = await db.insert(schema.agentRuns).values({ userId, conversationId, messageId, appId, botId: bot.id, routineRunId, background: true, status: "succeeded" }).returning();
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
  });
  afterAll(async () => { await pool.end(); });

  it.each(["user", "conversation", "routine"] as const)("does not deadlock with %s cascade deletion", async parent => {
    // A second process holds the parent first, as deletion does. The hook must wait here without
    // holding an agent lock needed by the cascade. This also exercises application pool size one.
    const otherProcess = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const holder = await otherProcess.connect();
    let notification: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '1500ms'");
      const table = parent === "user" ? "users" : parent === "conversation" ? "conversations" : "routine_runs";
      const id = parent === "user" ? userId : parent === "conversation" ? conversationId : routineRunId;
      await holder.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      notification = afterRunTransition(agent, "succeeded", null);
      // Attach a rejection handler immediately; the assertion after releasing locks still checks it.
      void notification.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await holder.query("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'");
        expect(waiting.rows.some(row => typeof row.query === "string" && (row.query.includes(table) || row.query.includes("inbox_items")))).toBe(true);
      });
      const deletedTable = parent === "routine" ? "routines" : table;
      await holder.query(`DELETE FROM ${deletedTable} WHERE id = $1`, [parent === "routine" ? routineId : id]);
      await holder.query("COMMIT");
      await expect(notification).resolves.toBeUndefined();
      expect(await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.userId, userId))).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await notification?.catch(() => {});
      await otherProcess.end();
    }
  });

  it("does not hold the routine row while waiting for a missing-run conversation deletion", async () => {
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, agent.id));
    const otherProcess = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const holder = await otherProcess.connect();
    let recovery: Promise<number> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '1500ms'");
      await holder.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
      recovery = reconcileRoutines();
      void recovery.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await holder.query("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'");
        expect(waiting.rows.some(row => typeof row.query === "string" && (row.query.includes("conversations") || row.query.includes("inbox_items")))).toBe(true);
      });
      await holder.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
      await holder.query("COMMIT");
      await recovery;
      const [settled] = await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, routineRunId));
      expect(settled).toMatchObject({ status: "failed", conversationId: null });
      const notices = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.routineRunId, routineRunId));
      expect(notices).toMatchObject([{ kind: "routine_error", conversationId: null, body: "Its conversation was deleted." }]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await recovery?.catch(() => {});
      await otherProcess.end();
    }
  });
});
