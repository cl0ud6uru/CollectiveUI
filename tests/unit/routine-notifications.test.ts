import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, mail: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/entra", () => ({ graphFetch: fixture.mail }));
vi.mock("@/lib/jobs", () => ({ enqueue: vi.fn(), enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn(), QUEUES: {} }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

import { db, schema } from "@/db";
import { afterRunTransition } from "@/lib/runs/hooks";
import { reconcileRoutines } from "@/lib/runs/sweeper";
import type { PortalUIMessage } from "@/lib/chat/store";
import type { AgentRunStatus } from "@/lib/runs/types";

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45_000);
beforeEach(async () => {
  fixture.mail.mockReset(); fixture.mail.mockResolvedValue({});
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values({ id: "owner", name: "Owner", upn: "owner@fixture.invalid", email: "owner@fixture.invalid", authSource: "local", identityRealm: "local" });
  await db.insert(schema.aiApps).values({ id: "model", name: "Synthetic model", provider: "openai-compatible", baseUrl: "https://model.fixture.invalid", model: "fixture" });
  await db.insert(schema.bots).values({ id: "bot", name: "Digest bot", ownerId: "owner", appId: "model" });
  await db.insert(schema.routines).values({ id: "routine", ownerId: "owner", botId: "bot", name: "Daily digest", prompt: "Synthetic digest", triggerType: "cron", cron: "0 9 * * *", notifyEmail: true });
  await db.insert(schema.conversations).values({ id: "chat", userId: "owner", botId: "bot", source: "routine" });
  await db.insert(schema.routineRuns).values({ id: "routine-run", routineId: "routine", trigger: "manual", status: "running", conversationId: "chat", createdAt: new Date(Date.now() - 300_000) });
  await db.insert(schema.messages).values({ id: "reply", conversationId: "chat", role: "assistant", parts: [{ type: "text", text: "Saved digest result" }] });
  await db.insert(schema.agentRuns).values({ id: "agent-run", userId: "owner", conversationId: "chat", messageId: "reply", botId: "bot", appId: "model", routineRunId: "routine-run", background: true, status: "succeeded" });
});
afterAll(async () => { await fixture.client!.close(); });

const message: PortalUIMessage = { id: "reply", role: "assistant", parts: [{ type: "text", text: "Saved digest result" }] };
async function agent() { return (await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, "agent-run")))[0]; }
async function routine() { return (await db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, "routine-run")))[0]; }
async function inbox() { return db.select().from(schema.inboxItems); }
async function transition(status: AgentRunStatus, segment: number) {
  await db.transaction(async tx => {
    await tx.update(schema.agentRuns).set({ status, segment }).where(eq(schema.agentRuns.id, "agent-run"));
    await tx.update(schema.routineRuns).set({ status: "running", finishedAt: null }).where(eq(schema.routineRuns.id, "routine-run"));
  });
  return agent();
}
async function rejectInbox(work: () => Promise<unknown>) {
  await fixture.client!.exec("ALTER TABLE inbox_items ADD CONSTRAINT reject_notification CHECK (false) NOT VALID");
  try { await work(); }
  finally { await fixture.client!.exec("ALTER TABLE inbox_items DROP CONSTRAINT reject_notification"); }
}

describe("durable routine Inbox notifications (production hooks with migrated PGlite)", () => {
  it("rolls back a result when Inbox insertion fails, then recovers the saved text and sends email once", async () => {
    const run = await agent();
    await rejectInbox(() => expect(afterRunTransition(run, "succeeded", message)).rejects.toThrow());
    expect((await routine()).status).toBe("running");
    expect(await inbox()).toEqual([]);
    expect(fixture.mail).not.toHaveBeenCalled();
    await reconcileRoutines();
    expect((await routine()).status).toBe("succeeded");
    expect(await inbox()).toMatchObject([{ kind: "routine_result", title: "Daily digest finished", body: "Saved digest result" }]);
    expect(fixture.mail).toHaveBeenCalledTimes(1);
    await afterRunTransition(run, "succeeded", message);
    await reconcileRoutines();
    expect(await inbox()).toHaveLength(1);
    expect(fixture.mail).toHaveBeenCalledTimes(1);
  });

  it("deduplicates competing hook/recovery calls and does not resend a failed best-effort email", async () => {
    fixture.mail.mockRejectedValue(new Error("Synthetic mail failure"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await agent();
      await Promise.all([afterRunTransition(run, "succeeded", message), reconcileRoutines(), afterRunTransition(run, "succeeded", message)]);
      await afterRunTransition(run, "succeeded", message);
    } finally { warning.mockRestore(); }
    expect((await routine()).status).toBe("succeeded");
    expect(await inbox()).toHaveLength(1);
    expect(fixture.mail).toHaveBeenCalledTimes(1);
  });

  it("rolls back the Inbox receipt if the routine status write fails", async () => {
    const run = await agent();
    await fixture.client!.exec("ALTER TABLE routine_runs ADD CONSTRAINT reject_settlement CHECK (status <> 'succeeded') NOT VALID");
    try { await expect(afterRunTransition(run, "succeeded", message)).rejects.toThrow(); }
    finally { await fixture.client!.exec("ALTER TABLE routine_runs DROP CONSTRAINT reject_settlement"); }
    expect((await routine()).status).toBe("running");
    expect(await inbox()).toEqual([]);
    expect(fixture.mail).not.toHaveBeenCalled();
    await reconcileRoutines();
    expect((await routine()).status).toBe("succeeded");
    expect(await inbox()).toHaveLength(1);
  });

  it("recovers a lost approval notice, keeps distinct approval phases, and ignores stale hooks after resume", async () => {
    const first = await transition("waiting", 0);
    await rejectInbox(() => expect(afterRunTransition(first, "waiting", message)).rejects.toThrow());
    expect((await routine()).status).toBe("running");
    await reconcileRoutines();
    expect((await routine()).status).toBe("awaiting_approval");
    expect(await inbox()).toMatchObject([{ kind: "approval" }]);
    await transition("running", 1);
    await afterRunTransition(first, "waiting", message);
    expect((await routine()).status).toBe("running");
    const second = await transition("waiting", 1);
    await afterRunTransition(second, "waiting", message);
    await afterRunTransition(second, "waiting", message);
    expect(await inbox()).toHaveLength(2);
    const final = await transition("succeeded", 2);
    await afterRunTransition(final, "succeeded", message);
    await afterRunTransition(second, "waiting", message);
    expect((await routine()).status).toBe("succeeded");
    expect((await inbox()).map(item => item.kind).sort()).toEqual(["approval", "approval", "routine_result"]);
    expect(fixture.mail).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled", "interrupted"] as const)("recovers a %s outcome atomically without duplicate errors", async status => {
    const run = await transition(status, 0);
    await db.update(schema.agentRuns).set({ error: "Synthetic run error" }).where(eq(schema.agentRuns.id, run.id));
    await rejectInbox(() => expect(afterRunTransition(run, status, message, "Synthetic run error")).rejects.toThrow());
    expect((await routine()).status).toBe("running");
    await Promise.all([reconcileRoutines(), reconcileRoutines()]);
    expect(await inbox()).toMatchObject([{ kind: "routine_error", title: "Daily digest failed", body: "Synthetic run error" }]);
    expect((await routine()).status).toBe("failed");
    expect(fixture.mail).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles a missing run atomically (conversation deleted: %s)", async deleted => {
    if (deleted) await db.delete(schema.conversations);
    else await db.delete(schema.agentRuns);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await rejectInbox(() => reconcileRoutines()); }
    finally { log.mockRestore(); }
    expect((await routine()).status).toBe("running");
    expect(await inbox()).toEqual([]);
    await Promise.all([reconcileRoutines(), reconcileRoutines()]);
    expect((await routine()).status).toBe("failed");
    expect(await inbox()).toMatchObject([{ kind: "routine_error", title: "Daily digest failed", body: deleted ? "Its conversation was deleted." : "The run was lost. Run the routine again." }]);
  });

  it("leaves a legacy approval without an agent run answerable", async () => {
    await db.delete(schema.agentRuns);
    await db.update(schema.routineRuns).set({ status: "awaiting_approval" });
    await reconcileRoutines();
    expect((await routine()).status).toBe("awaiting_approval");
    expect(await inbox()).toEqual([]);
  });
});
