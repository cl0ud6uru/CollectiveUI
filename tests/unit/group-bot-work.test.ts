import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { beginGroupBotWork, GROUP_WORK_HEARTBEAT_MS } from "@/lib/chat/group-bot-work";
import { botStatusSnapshot } from "@/lib/chat/bot-statuses";
import { configureTeam } from "@/lib/hermes-team/store";
import { openTeamConversation } from "@/lib/hermes-team/conversations";
let alice: Principal, bob: Principal, admin: Principal;
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45000);
beforeEach(async () => {
  vi.stubEnv("HERMES_TEAM_BOTS_ENABLED", "1");
  await fixture.client!.exec("TRUNCATE users,ai_apps,settings CASCADE");
  await db.insert(schema.users).values(["alice", "bob", "admin"].map(id => ({ id, upn: `${id}@test.invalid`, name: id, isAdmin: id === "admin", authSource: "local" as const, identityRealm: "local" as const })));
  alice = (await loadPrincipal("alice"))!; bob = (await loadPrincipal("bob"))!; admin = (await loadPrincipal("admin"))!;
  await db.insert(schema.aiApps).values({ id: "app", name: "Synthetic model", model: "mock", baseUrl: "https://synthetic.test.invalid/v1" });
  await db.insert(schema.bots).values([
    { id: "research", name: "Researcher", ownerId: "admin", appId: "app", visibility: "org" },
    { id: "writer", name: "Writer", ownerId: "admin", appId: "app", visibility: "org" },
    { id: "private", name: "Inaccessible", ownerId: "bob", appId: "app", visibility: "private" },
  ]);
  await db.insert(schema.conversations).values([
    { id: "group-a", userId: "alice", isGroup: true }, { id: "group-b", userId: "alice", isGroup: true },
    { id: "bob-group", userId: "bob", isGroup: true }, { id: "direct", userId: "alice", botId: "research" },
  ]);
});
afterAll(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await fixture.client!.close(); });
const working = () => botStatusSnapshot(alice);

describe("group work in the real roster (synthetic PostgreSQL)", () => {
  it("marks only executing speakers and retains the other invocation when one completes", async () => {
    const first = await beginGroupBotWork({ userId: "alice", conversationId: "group-a", botId: "research" });
    const second = await beginGroupBotWork({ userId: "alice", conversationId: "group-b", botId: "research" });
    expect(await working()).toMatchObject({ research: "working", writer: null });
    await first(); await first();
    expect(await working()).toMatchObject({ research: "working", writer: null });
    await second();
    const handoff = await beginGroupBotWork({ userId: "alice", conversationId: "group-a", botId: "writer" });
    expect(await working()).toMatchObject({ research: null, writer: "working" });
    await handoff();
    expect(await working()).toEqual({ research: null, writer: null });
  });
  it("combines direct/delegated work and approval with group work without clearing unrelated runs", async () => {
    const done = await beginGroupBotWork({ userId: "alice", conversationId: "group-a", botId: "research" });
    await db.insert(schema.agentRuns).values({ id: "direct-run", userId: "alice", conversationId: "direct", botId: "research", messageId: "reply", status: "waiting" });
    expect((await working()).research).toBe("waiting");
    await done(); expect((await working()).research).toBe("waiting");
    await db.update(schema.agentRuns).set({ status: "waiting_tasks" }).where(eq(schema.agentRuns.id, "direct-run"));
    expect((await working()).research).toBe("working");
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      await db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, "direct-run"));
      expect((await working()).research).toBeNull();
    }
  });
  it("does not expose other users, inaccessible bots or mismatched conversation ownership", async () => {
    const stops = await Promise.all([
      beginGroupBotWork({ userId: "bob", conversationId: "bob-group", botId: "research" }),
      beginGroupBotWork({ userId: "alice", conversationId: "bob-group", botId: "writer" }),
      beginGroupBotWork({ userId: "alice", conversationId: "group-a", botId: "private" }),
    ]);
    try {
      expect(await working()).toEqual({ research: null, writer: null });
      expect((await botStatusSnapshot(bob)).research).toBe("working");
    } finally { await Promise.all(stops.map(stop => stop())); }
  });
  it("expires lost leases, renews running ones, and cannot resurrect finished work", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const done = await beginGroupBotWork({ userId: "alice", conversationId: "group-a", botId: "research" });
      await db.update(schema.groupBotWork).set({ expiresAt: new Date(0) });
      expect((await working()).research).toBeNull();
      await vi.advanceTimersByTimeAsync(GROUP_WORK_HEARTBEAT_MS);
      await vi.waitFor(async () => expect((await working()).research).toBe("working"));
      await done(); await vi.advanceTimersByTimeAsync(GROUP_WORK_HEARTBEAT_MS * 2);
      expect(await db.select().from(schema.groupBotWork)).toHaveLength(0);
      expect((await working()).research).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("hides revoked private Team Admin work even when the bot stays accessible", async () => {
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, "alice"));
    alice = (await loadPrincipal("alice"))!;
    await db.insert(schema.bots).values({ id: "team", name: "Team", ownerId: "admin", appId: "app", visibility: "groups" });
    await db.insert(schema.botUserAccess).values({ botId: "team", userId: "alice" });
    await configureTeam(admin, "team", { enabled: true, expectedVersion: 0, maintainerIds: ["alice", "admin"], modelPolicy: { mode: "personal_required" } });
    const opened = await openTeamConversation(alice, "team", "admin");
    await db.insert(schema.agentRuns).values({ userId: "alice", conversationId: opened.conversationId, botId: "team", messageId: "admin-reply", status: "running" });
    expect((await working()).team).toBe("working");
    await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId, "alice"));
    expect((await working()).team).toBeNull();
  });
});
