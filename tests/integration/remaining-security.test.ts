import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";

const fixture = vi.hoisted(() => ({ enqueue: vi.fn(), stop: vi.fn(), providerStop: vi.fn(), requirePrincipal: vi.fn<() => Promise<Principal>>(), principal: null as Principal | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/jobs", () => ({ enqueue: fixture.enqueue, QUEUES: { routineRun: "routine.run" } }));
vi.mock("@/lib/runs/store", async original => ({ ...await original<typeof import("@/lib/runs/store")>(), stopRuns: fixture.stop }));
vi.mock("@/lib/runs/provider-stop", () => ({ stopRunsBeforeDelete: fixture.providerStop }));
vi.mock("@/lib/session", () => ({ requirePrincipal: fixture.requirePrincipal,
  errorResponse: (error: Error & { status?: number }) => Response.json({ error: error.message }, { status: error.status ?? 500 }) }));

import { db, pool, schema } from "@/db";
import { runMigrations } from "@/db/migration-runner";
import { hmacSha256Hex } from "@/lib/crypto";
import { loadPrincipal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/http-error";
import { POST } from "@/app/api/routines/webhook/[id]/route";
import { DELETE, PATCH } from "@/app/api/mobile/v1/conversations/[id]/route";
import { deleteAllConversations, deleteConversation, deleteAllConversationsWithFeedback, deleteConversationWithFeedback } from "@/app/(chat)/actions";

const enabled = process.env.REMAINING_SECURITY_TEST === "1";
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_remaining_security_test" || url.username !== "review_fixture" ||
      url.password !== "synthetic-review-only" || !url.port || url.search || url.hash ||
      Object.keys(process.env).some(key => /^PG(HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|OPTIONS|SERVICE|SERVICEFILE)$/.test(key) && process.env[key]))
    throw new Error("Remaining security tests require the dedicated disposable loopback database and synthetic credentials.");
}
const suite = enabled ? describe : describe.skip;
const secret = "synthetic-webhook-only";
function webhook(id = "delivery-fixture-123", raw = '{"ticket":123}', timestamp = Math.floor(Date.now() / 1000)) {
  const headers = { "x-portal-timestamp": String(timestamp), "x-portal-delivery-id": id,
    "x-portal-signature": `sha256=${hmacSha256Hex(secret, `${timestamp}.${id}.${raw}`)}` };
  return POST(new Request("http://fixture.invalid/api/routines/webhook/hook", { method: "POST", headers, body: raw }), { params: Promise.resolve({ id: "hook" }) });
}
suite("remaining security regressions on real PostgreSQL", () => {
  beforeAll(async () => { await db.execute(sql`select 1`); });
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql`truncate users, ai_apps, settings cascade`);
    await db.insert(schema.users).values({ id: "owner", name: "Owner", upn: "owner@fixture.invalid", authSource: "local", identityRealm: "local" });
    fixture.principal = (await loadPrincipal("owner"))!;
    fixture.requirePrincipal.mockImplementation(async () => {
      if (!fixture.principal) throw new HttpError(401, "Unauthenticated");
      return fixture.principal;
    });
    await db.insert(schema.bots).values({ id: "bot", ownerId: "owner", name: "Fixture" });
    await db.insert(schema.routines).values({ id: "hook", ownerId: "owner", botId: "bot", name: "Hook", prompt: "Never execute", triggerType: "webhook", webhookSecret: secret });
  });
  afterAll(async () => { await pool.end(); });

  it.each([
    ["single", () => deleteConversation("retained")],
    ["bulk", () => deleteAllConversations()],
    ["single feedback", () => deleteConversationWithFeedback("retained")],
    ["bulk feedback", () => deleteAllConversationsWithFeedback()],
  ] as const)("authenticates the %s action once and propagates unauthenticated failures before side effects", async (_kind, action) => {
    await seedRetainedHistory();
    fixture.principal = null;
    await expect(action()).rejects.toMatchObject({ status: 401 });
    expect(fixture.requirePrincipal).toHaveBeenCalledTimes(1);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.providerStop).not.toHaveBeenCalled();
    expect(await db.select().from(schema.conversations)).toHaveLength(2);
    expect(await db.select().from(schema.agentRuns)).toHaveLength(1);
  });

  it("propagates ownership denial from the feedback action without disclosing retained history", async () => {
    await seedRetainedHistory();
    await db.insert(schema.users).values({ id: "other", upn: "other@fixture.invalid", name: "Other", authSource: "local", identityRealm: "local" });
    fixture.principal = (await loadPrincipal("other"))!;
    await expect(deleteConversationWithFeedback("retained")).rejects.toMatchObject({ status: 404 });
    expect(fixture.requirePrincipal).toHaveBeenCalledTimes(1);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.providerStop).not.toHaveBeenCalled();
    expect(await db.select().from(schema.conversations)).toHaveLength(2);
  });

  it("admits simultaneous signed deliveries once and returns the persisted receipt after pause and capacity exhaustion", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => webhook()));
    expect(responses.map(response => response.status)).toEqual(Array(8).fill(202));
    const bodies = await Promise.all(responses.map(response => response.json()));
    expect(new Set(bodies.map(body => body.runId)).size).toBe(1);
    expect(fixture.enqueue).toHaveBeenCalledTimes(1);
    await db.insert(schema.routineRuns).values(Array.from({ length: 2 }, () => ({ routineId: "hook", trigger: "manual" as const })));
    await db.update(schema.routines).set({ enabled: false }).where(eq(schema.routines.id, "hook"));
    // No process-local cache is involved: the persisted receipt is sufficient.
    const duplicate = await webhook();
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(bodies[0]);
    expect(fixture.enqueue).toHaveBeenCalledTimes(1);
    expect((await webhook("delivery-fixture-new")).status).toBe(409);
    expect((await webhook("delivery-fixture-123", '{"different":true}')).status).toBe(409);
    expect((await db.select().from(schema.routineRuns))).toHaveLength(3);
  });

  it("rejects stale signatures and preserves bearer-only compatibility without deduplicating distinct requests", async () => {
    expect((await webhook("delivery-fixture-old", "{}", Math.floor(Date.now() / 1000) - 301)).status).toBe(401);
    const send = () => POST(new Request("http://fixture.invalid/hook", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{}" }), { params: Promise.resolve({ id: "hook" }) });
    expect((await send()).status).toBe(202); expect((await send()).status).toBe(202);
    expect(await db.select().from(schema.routineRuns)).toHaveLength(2);
  });

  it("retains delivery identity after conversation deletion and rejects database-level duplicate receipts", async () => {
    const response = await webhook(); const { runId } = await response.json();
    await db.insert(schema.conversations).values({ id: "result", userId: "owner" });
    await db.update(schema.routineRuns).set({ conversationId: "result", status: "succeeded" }).where(eq(schema.routineRuns.id, runId));
    await db.delete(schema.conversations).where(eq(schema.conversations.id, "result"));
    expect((await webhook()).status).toBe(202);
    expect(await db.select().from(schema.routineRuns)).toHaveLength(1);
    const [receipt] = await db.select().from(schema.routineRuns);
    await expect(db.insert(schema.routineRuns).values({ routineId: "hook", trigger: "webhook", webhookDeliveryId: receipt.webhookDeliveryId, webhookPayloadHash: receipt.webhookPayloadHash })).rejects.toThrow();
  });

  it("blocks existing Team history before stopping work for single, bulk and mobile deletion; archive remains available", async () => {
    await seedRetainedHistory();
    await expect(deleteConversation("retained")).rejects.toMatchObject({ status: 409 });
    await expect(deleteAllConversations()).rejects.toMatchObject({ status: 409 });
    expect(await deleteConversationWithFeedback("retained")).toMatchObject({ ok: false, error: expect.stringContaining("Archive") });
    expect(await deleteAllConversationsWithFeedback()).toMatchObject({ ok: false, error: expect.stringContaining("Archive") });
    const response = await DELETE(new Request("http://fixture.invalid/c/retained", { method: "DELETE" }), { params: Promise.resolve({ id: "retained" }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: expect.stringContaining("Archive") });
    expect(fixture.stop).not.toHaveBeenCalled(); expect(fixture.providerStop).not.toHaveBeenCalled();
    expect(await db.select().from(schema.conversations)).toHaveLength(2);
    const archived = await PATCH(new Request("http://fixture.invalid/c/retained", { method: "PATCH", body: '{"archived":true}' }), { params: Promise.resolve({ id: "retained" }) });
    expect(archived.status).toBe(204);
    expect((await db.select().from(schema.conversations).where(eq(schema.conversations.id, "retained")))[0].archived).toBe(true);
    await deleteConversation("ordinary");
    expect(await db.select().from(schema.conversations)).toHaveLength(1);
  });

  it("blocks learning child history independently of the source context and still allows unrelated owners to delete", async () => {
    await seedRetainedHistory();
    await db.insert(schema.agentRuns).values({ id: "child", userId: "owner", conversationId: "ordinary", messageId: "child-message" });
    await db.execute(sql`insert into hermes_team_learning_handoffs
      (id,source_context_id,review_id,child_run_id,actor_id,bot_id,profile_id,session_version,definition_version,mode,binding_hash,route_hash,snapshot_hash,snapshot_bytes,payload_enc,expires_at)
      values ('handoff','context','00000000-0000-0000-0000-000000000000','child','owner','bot','profile',0,1,'member',repeat('a',64),repeat('a',64),repeat('a',64),1,'synthetic',now()+interval '5 minutes')`);
    await expect(deleteConversation("ordinary")).rejects.toMatchObject({ status: 409 });
    expect(fixture.stop).not.toHaveBeenCalled();
    await db.insert(schema.users).values({ id: "other", upn: "other@fixture.invalid", name: "Other", authSource: "local", identityRealm: "local" });
    await db.insert(schema.conversations).values({ id: "other-chat", userId: "other" });
    fixture.principal = (await loadPrincipal("other"))!;
    await deleteAllConversations();
    expect(await db.select().from(schema.conversations).where(eq(schema.conversations.userId, "owner"))).toHaveLength(2);
    expect(await db.select().from(schema.conversations).where(eq(schema.conversations.userId, "other"))).toHaveLength(0);
  });

  it("serializes journal inspection and bootstrap on the locked session, with a pool size of one", async () => {
    const folder = await migrationFixture("CREATE TABLE migration_lock_probe (id integer PRIMARY KEY);");
    const firstPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const secondPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: "remaining-migration-waiter" });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const order: number[] = [];
    const first = runMigrations(firstPool, { migrationsFolder: folder, migrationsSchema: "migration_lock_fixture" }, async lockedDb => {
      await lockedDb.execute(sql`insert into migration_lock_probe values (1)`);
      order.push(1); started(); await gate;
    });
    let second: Promise<void> | undefined;
    try {
      await entered;
      second = runMigrations(secondPool, { migrationsFolder: folder, migrationsSchema: "migration_lock_fixture" }, async lockedDb => {
        await lockedDb.execute(sql`insert into migration_lock_probe values (2)`); order.push(2);
      });
      await expect.poll(async () => (await pool.query("select count(*)::int as n from pg_stat_activity where application_name = 'remaining-migration-waiter' and wait_event = 'advisory'")).rows[0].n).toBe(1);
      expect(order).toEqual([1]); release(); await Promise.all([first, second]);
      expect(order).toEqual([1, 2]);
      expect((await pool.query('select count(*)::int as n from migration_lock_fixture.__drizzle_migrations')).rows[0].n).toBe(1);
    } finally {
      release(); await Promise.allSettled([first, second]); await firstPool.end(); await secondPool.end();
      await pool.query('drop table if exists migration_lock_probe; drop schema if exists migration_lock_fixture cascade'); await rm(folder, { recursive: true, force: true });
    }
  });

  it.each(["migration", "bootstrap"])("releases its advisory lock after a %s failure", async failure => {
    const folder = await migrationFixture(failure === "migration" ? "INVALID SQL;" : "SELECT 1;");
    const runnerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await expect(runMigrations(runnerPool, { migrationsFolder: folder, migrationsSchema: "migration_failure_fixture" }, async () => { throw new Error("synthetic bootstrap failure"); })).rejects.toThrow();
      const client = await pool.connect();
      try {
        expect((await client.query("select pg_try_advisory_lock($1,$2) as acquired", [0x435549, 0x4d4947])).rows[0].acquired).toBe(true);
      } finally { await client.query("select pg_advisory_unlock($1,$2)", [0x435549, 0x4d4947]); client.release(); }
      await runnerPool.query("select 1");
    } finally { await runnerPool.end(); await pool.query("drop schema if exists migration_failure_fixture cascade"); await rm(folder, { recursive: true, force: true }); }
  });
});

async function migrationFixture(statement: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "collective-migration-lock-"));
  await mkdir(path.join(folder, "meta"));
  await writeFile(path.join(folder, "0000_fixture.sql"), statement);
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1, tag: "0000_fixture", breakpoints: true }] }));
  return folder;
}
async function seedRetainedHistory() {
  await db.insert(schema.conversations).values([{ id: "retained", userId: "owner" }, { id: "ordinary", userId: "owner" }]);
  await db.insert(schema.agentRuns).values({ id: "run", userId: "owner", conversationId: "retained", messageId: "message" });
  await db.insert(schema.hermesTeamDefinitions).values({ botId: "bot", modelPolicy: { mode: "personal_required" }, updatedBy: "owner" });
  await db.insert(schema.hermesTeamProfiles).values({ id: "profile", botId: "bot", userId: "owner", mode: "member", ownerKey: "owner", requestId: "request" });
  await db.execute(sql`insert into hermes_team_candidate_contexts
    (id,run_id,bot_id,profile_id,actor_id,session_version,definition_version,mode,model_route,binding_hash,model_tokens,tool_token_hash,expires_at,revoked_at)
    values ('context','run','bot','profile','owner',0,1,'member','{}',repeat('a',64),'{}',repeat('a',64),now(),now())`);
}
