import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";
import type { AgentRunStatus } from "@/db/schema";

vi.mock("@/lib/jobs", () => ({ enqueueRun: vi.fn(), enqueue: vi.fn(), getBoss: vi.fn() }));
const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("recent tasks and persisted terminal read receipts", () => {
  let owner: Principal, other: Principal, botId: string;
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const people = await db.insert(schema.users).values(["owner", "other"].map(name => ({ upn: `recent-${name}-${crypto.randomUUID()}`, name, authSource: "ldap" as const }))).returning();
    owner = (await loadPrincipal(people[0].id))!; other = (await loadPrincipal(people[1].id))!;
    const [bot] = await db.insert(schema.bots).values({ ownerId: owner.user.id, name: "Private specialist" }).returning(); botId = bot.id;
  });
  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    await db.delete(schema.users).where(inArray(schema.users.id, [owner.user.id, other.user.id]));
    await pool.end();
  });
  async function fixture(status: AgentRunStatus = "queued", mode: "async" | "sync" = "async") {
    const { db, schema } = await import("@/db");
    const [parent, child] = await db.insert(schema.conversations).values([
      { userId: owner.user.id, botId, title: "Parent", source: "chat" as const },
      { userId: owner.user.id, botId, title: `Task ${crypto.randomUUID()}`, source: "delegation" as const },
    ]).returning();
    const [run] = await db.insert(schema.agentRuns).values({ userId: owner.user.id, conversationId: child.id, botId,
      status, executionMode: mode === "async" ? "async_delegate" : "inline_delegate", background: true, messageId: crypto.randomUUID(), lastSeq: 5 }).returning();
    const id = crypto.randomUUID();
    const [task] = await db.insert(schema.delegatedTasks).values({ id, userId: owner.user.id, originConversationId: parent.id,
      originMessageId: crypto.randomUUID(), originToolCallId: crypto.randomUUID(), rootMessageId: crypto.randomUUID(), rootTaskId: id,
      assignerBotId: botId, receiverBotId: botId, assignerName: "Assigner", receiverName: "Private specialist",
      childConversationId: child.id, childRunId: run.id, inputHash: "private-hash", mode, depth: 1, ancestry: [],
      sessionVersion: owner.user.sessionVersion, deadlineAt: new Date(Date.now() + 60_000) }).returning();
    return { parent, child, run, task, observed: { runId: run.id, status: run.status, lastSeq: run.lastSeq } };
  }
  it("lists admitted concurrent children once, scoped to their owner, without internal task metadata", async () => {
    const { loadRecentTasks } = await import("@/lib/chat/recent-tasks");
    const a = await fixture(), b = await fixture("running");
    const tasks = await loadRecentTasks(owner);
    expect(tasks.filter(c => c.id === a.child.id)).toHaveLength(1);
    expect(tasks.find(c => c.id === a.child.id)?.taskActivity).toEqual({ status: "queued", unread: false });
    expect(tasks.find(c => c.id === b.child.id)?.taskActivity).toEqual({ status: "running", unread: false });
    expect(JSON.stringify(tasks)).not.toMatch(/private-hash|ancestry|sessionVersion|deadlineAt|receiverName|runId/);
    expect(await loadRecentTasks(other)).toEqual([]);
    const { db, schema } = await import("@/db");
    await db.update(schema.conversations).set({ archived: true }).where(eq(schema.conversations.id, a.child.id));
    expect((await loadRecentTasks(owner)).some(c => c.id === a.child.id)).toBe(false);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, b.child.id));
    expect((await loadRecentTasks(owner)).some(c => c.id === b.child.id)).toBe(false);
  });
  it("an early open cannot acknowledge later completion; parent and other-user reads cannot clear it", async () => {
    const { db, schema } = await import("@/db");
    const { markTaskRead } = await import("@/lib/delegation/read");
    const { loadRecentTasks } = await import("@/lib/chat/recent-tasks");
    const f = await fixture("running");
    await expect(markTaskRead(owner, f.child.id, f.observed)).rejects.toMatchObject({ status: 409 });
    await db.update(schema.agentRuns).set({ status: "succeeded", lastSeq: 6 }).where(eq(schema.agentRuns.id, f.run.id));
    await expect(markTaskRead(owner, f.child.id, f.observed)).rejects.toMatchObject({ status: 409 });
    await expect(markTaskRead(owner, f.child.id, { ...f.observed, status: "succeeded" })).rejects.toMatchObject({ status: 409 });
    const observed = { ...f.observed, status: "succeeded", lastSeq: 6 };
    await expect(markTaskRead(owner, f.parent.id, observed)).rejects.toMatchObject({ status: 404 });
    await expect(markTaskRead(other, f.child.id, observed)).rejects.toMatchObject({ status: 404 });
    expect((await loadRecentTasks(owner)).find(c => c.id === f.child.id)?.taskActivity).toEqual({ status: "succeeded", unread: true });
    await markTaskRead(owner, f.child.id, observed);
    expect((await loadRecentTasks(owner)).find(c => c.id === f.child.id)?.taskActivity?.unread).toBe(false);
  });
  it.each(["before", "after", "concurrent"])("read and notifier share one persisted marker when notification is %s the read", async order => {
    const { db, schema } = await import("@/db");
    const { markTaskRead } = await import("@/lib/delegation/read");
    const { reconcileAsyncTasks } = await import("@/lib/delegation/async");
    const { loadRecentTasks } = await import("@/lib/chat/recent-tasks");
    const f = await fixture("succeeded");
    if (order === "before") await reconcileAsyncTasks();
    if (order === "concurrent") await Promise.all([markTaskRead(owner, f.child.id, f.observed), reconcileAsyncTasks()]);
    else await markTaskRead(owner, f.child.id, f.observed);
    await reconcileAsyncTasks();
    const rows = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, `task_${f.task.id}`));
    expect(rows).toHaveLength(1); expect(rows[0].readAt).not.toBeNull();
    await Promise.all([markTaskRead(owner, f.child.id, f.observed), markTaskRead(owner, f.child.id, f.observed)]);
    expect((await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, `task_${f.task.id}`)))[0].readAt).toEqual(rows[0].readAt);
    expect((await loadRecentTasks(owner)).find(c => c.id === f.child.id)?.taskActivity?.unread).toBe(false);
  });
  it.each(["failed", "cancelled", "interrupted", "succeeded"] as const)("preserves %s and its read state for synchronous tasks too", async status => {
    const { markTaskRead } = await import("@/lib/delegation/read");
    const { loadRecentTasks } = await import("@/lib/chat/recent-tasks");
    const f = await fixture(status, "sync");
    expect((await loadRecentTasks(owner)).find(c => c.id === f.child.id)?.taskActivity).toEqual({ status, unread: true });
    await markTaskRead(owner, f.child.id, f.observed);
    expect((await loadRecentTasks(owner)).find(c => c.id === f.child.id)?.taskActivity).toEqual({ status, unread: false });
  });
});
