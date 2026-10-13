import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Principal } from "@/lib/auth/groups";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({ requireAdminPage: async () => ({ user: { id: "admin", identityRealm: "directory" }, isAdmin: true }) }));
vi.mock("@/lib/auth/config", () => ({ localEnabled: () => false }));
vi.mock("@/components/admin/local-users", () => ({ CreateLocalUser: () => null, ResetLocalPassword: () => null }));
vi.mock("@/components/admin/row-actions", () => ({ UserRowActions: () => null }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from "@/db";
import { listAdminUsers } from "@/lib/admin/users";
import { listAdminActivity, readActivityFilters, formatAdminDiagnostic } from "@/lib/admin/activity";
import { adminListHref, requestedPage } from "@/lib/admin/listing";
import { formatAdminTimestamp } from "@/lib/admin/timestamp";
import AdminUsersPage from "@/app/admin/users/page";
import AdminActivityPage from "@/app/admin/activity/page";

const admin = { user: { id: "admin" }, isAdmin: true } as Principal;
const member = { user: { id: "other" }, isAdmin: false } as Principal;
const date = new Date("2026-10-13T03:10:00Z");
const user = (id: string, name: string) => ({ id, name, upn: `${id}@fixture.invalid`, authSource: "ldap" as const });
const call = (id: string, extra: Partial<typeof schema.toolCalls.$inferInsert> = {}) => ({
  id, userId: "admin", toolName: "fixture_tool", status: "done" as const, createdAt: date, ...extra,
});

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(file => file.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8")
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 60000);
beforeEach(async () => {
  await fixture.client!.exec("TRUNCATE users, ai_apps, audit_log CASCADE");
  await db.insert(schema.users).values([user("admin", "Admin"), user("other", "Other"), user("zero", "No chats")]);
});
afterAll(async () => { await fixture.client!.close(); });

describe("admin users on real SQL", () => {
  it("attributes 2, 1 and 0 conversations without multiplying directory group counts", async () => {
    await db.insert(schema.conversations).values([
      { id: "chat-a", userId: "admin" }, { id: "chat-b", userId: "admin" }, { id: "chat-c", userId: "other" },
    ]);
    await db.insert(schema.userExternalGroups).values([
      { userId: "admin", source: "ldap", externalId: "one" }, { userId: "admin", source: "ldap", externalId: "two" },
      { userId: "other", source: "entra", externalId: "three" },
    ]);
    const result = await listAdminUsers(admin, "");
    expect(result.rows.map(row => [row.user.id, row.chats, row.groupCount])).toEqual([
      ["admin", 2, 2], ["other", 1, 1], ["zero", 0, 0],
    ]);
  });

  it("pages beyond 200 users with stable ties, exact counts, bounded pages and preserved search", async () => {
    await db.insert(schema.users).values(Array.from({ length: 205 }, (_, i) => user(`member-${String(i).padStart(3, "0")}`, "Member")));
    const first = await listAdminUsers(admin, "Member", 1);
    const second = await listAdminUsers(admin, "Member", 2);
    const last = await listAdminUsers(admin, "Member", 999);
    expect(first.window).toMatchObject({ total: 205, page: 1, pages: 5, first: 1, last: 50 });
    expect(first.rows.map(row => row.user.id)).toEqual(Array.from({ length: 50 }, (_, i) => `member-${String(i).padStart(3, "0")}`));
    expect(second.rows[0].user.id).toBe("member-050");
    expect(last.window).toMatchObject({ page: 5, first: 201, last: 205 });
    expect(last.rows).toHaveLength(5);
    expect(adminListHref("/admin/users", { q: "Member & team" }, 2)).toBe("/admin/users?q=Member+%26+team&page=2");
  });

  it("searches literal names and UPNs and returns an explicit empty window", async () => {
    await db.insert(schema.users).values(user("literal", "100%_Team"));
    expect((await listAdminUsers(admin, "%_")).rows.map(row => row.user.id)).toEqual(["literal"]);
    expect((await listAdminUsers(admin, "OTHER@FIXTURE")).rows.map(row => row.user.id)).toEqual(["other"]);
    expect((await listAdminUsers(admin, "missing")).window).toMatchObject({ total: 0, page: 1, first: 0, last: 0 });
  });
});

describe("admin activity on real SQL", () => {
  it("pages beyond 300 records with deterministic timestamp ties", async () => {
    await db.insert(schema.toolCalls).values(Array.from({ length: 305 }, (_, i) => call(`call-${String(i).padStart(3, "0")}`)));
    const first = await listAdminActivity(admin, readActivityFilters({}));
    const second = await listAdminActivity(admin, readActivityFilters({ page: "2" }));
    const last = await listAdminActivity(admin, readActivityFilters({ page: "999" }));
    expect(first.window).toMatchObject({ total: 305, pages: 7, page: 1 });
    expect(first.rows[0].id).toBe("call-304");
    expect(second.rows[0].id).toBe("call-254");
    expect(new Set([...first.rows, ...second.rows].map(row => row.id)).size).toBe(100);
    expect(last.rows.map(row => row.id)).toEqual(["call-004", "call-003", "call-002", "call-001", "call-000"]);
    expect(last.window).toMatchObject({ page: 7, first: 301, last: 305 });
  });

  it("combines inclusive UTC day bounds, user, status and exact tool filters", async () => {
    await db.insert(schema.toolCalls).values([
      call("start", { createdAt: new Date("2026-10-12T00:00:00Z"), status: "error" }),
      call("end", { createdAt: new Date("2026-10-12T23:59:59.999Z"), status: "error" }),
      call("next", { createdAt: new Date("2026-10-13T00:00:00Z"), status: "error" }),
      call("before", { createdAt: new Date("2026-10-11T23:59:59.999Z"), status: "error" }),
      call("wrong-user", { userId: "other", createdAt: new Date("2026-10-12T12:00:00Z"), status: "error" }),
      call("wrong-tool", { toolName: "fixture_other", createdAt: new Date("2026-10-12T12:00:00Z"), status: "error" }),
      call("wrong-status", { createdAt: new Date("2026-10-12T12:00:00Z") }),
    ]);
    const filters = readActivityFilters({ from: "2026-10-12", to: "2026-10-12", user: "ADMIN@FIXTURE", tool: "fixture_tool", status: "error" });
    const result = await listAdminActivity(admin, filters);
    expect(result.rows.map(row => row.id)).toEqual(["end", "start"]);
    expect(result.window.total).toBe(2);
    const next = new URL(adminListHref("/admin/activity", filters.values, 2), "https://fixture.invalid");
    expect(next.searchParams.get("from")).toBe("2026-10-12");
    expect(next.searchParams.get("status")).toBe("error");
    expect(next.searchParams.get("user")).toBe("ADMIN@FIXTURE");
    expect(next.searchParams.get("page")).toBe("2");
  });

  it("keeps private Docker activity out of rows and counts; only links actual owned conversations", async () => {
    await db.insert(schema.aiApps).values({ id: "private-app", name: "Private", provider: "hermes", model: "fixture", baseUrl: "http://127.0.0.1:8642", providerConfig: { docker: {} } });
    await db.insert(schema.bots).values([
      { id: "own-bot", ownerId: "admin", name: "Own", appId: "private-app" },
      { id: "other-bot", ownerId: "other", name: "Other private", appId: "private-app" },
    ]);
    await db.insert(schema.conversations).values([{ id: "own-chat", userId: "admin" }, { id: "other-chat", userId: "other" }]);
    await db.insert(schema.toolCalls).values([
      call("own-private", { botId: "own-bot", conversationId: "own-chat" }),
      call("other-private", { botId: "other-bot", userId: "other", conversationId: "other-chat" }),
      call("visible-other-chat", { conversationId: "other-chat" }),
    ]);
    const result = await listAdminActivity(admin, readActivityFilters({}));
    expect(result.window.total).toBe(2);
    expect(result.rows.map(row => row.id)).not.toContain("other-private");
    expect(result.rows.find(row => row.id === "own-private")?.conversationId).toBe("own-chat");
    expect(result.rows.find(row => row.id === "visible-other-chat")?.conversationId).toBeNull();
  });

  it("retains full tool diagnostics while redacting keyed credentials and known token patterns", async () => {
    const longText = "diagnostic ".repeat(300);
    await db.insert(schema.toolCalls).values(call("details", {
      input: { nested: { api_key: "custom-secret", password: "private", authorization: "Basic abcd" }, query: "visible" },
      output: { body: longText, token: "custom-token", error: "Bearer synthetic-secret-token" },
      durationMs: 125,
    }));
    const result = await listAdminActivity(admin, readActivityFilters({}));
    expect(result.rows[0].details).toContain(longText);
    expect(result.rows[0].details).toContain('"durationMs": 125');
    expect(result.rows[0].details).toContain("visible");
    expect(result.rows[0].details).not.toMatch(/custom-secret|custom-token|synthetic-secret-token|Basic abcd|"private"/);
  });

  it("filters and pages routine runs with full errors and the same private scope", async () => {
    await db.insert(schema.aiApps).values({ id: "private-app", name: "Private", provider: "hermes", model: "fixture", baseUrl: "http://127.0.0.1:8642", providerConfig: { docker: {} } });
    await db.insert(schema.bots).values([{ id: "public-bot", ownerId: "admin", name: "Shared" }, { id: "other-bot", ownerId: "other", name: "Private", appId: "private-app" }]);
    await db.insert(schema.routines).values([
      { id: "routine", ownerId: "admin", botId: "public-bot", name: "Check", prompt: "Check", triggerType: "cron" },
      { id: "private-routine", ownerId: "other", botId: "other-bot", name: "Private", prompt: "Check", triggerType: "cron" },
    ]);
    await db.insert(schema.routineRuns).values([
      ...Array.from({ length: 51 }, (_, i) => ({ id: `run-${String(i).padStart(2, "0")}`, routineId: "routine", trigger: "manual" as const, status: "failed" as const, error: "full error ".repeat(100), createdAt: date })),
      { id: "hidden", routineId: "private-routine", trigger: "manual", status: "failed", createdAt: date },
      { id: "succeeded", routineId: "routine", trigger: "manual", status: "succeeded", createdAt: date },
    ]);
    const result = await listAdminActivity(admin, readActivityFilters({ tab: "runs", status: "failed", user: "Admin", from: "2026-10-13", to: "2026-10-13", page: "2" }));
    expect(result.window).toMatchObject({ total: 51, pages: 2 });
    expect(result.rows.map(row => row.id)).toEqual(["run-00"]);
    expect(result.rows[0].details).toContain("full error ".repeat(100));
    expect((await listAdminActivity(admin, readActivityFilters({ tab: "runs" }))).window.total).toBe(52);
  });

  it("filters and pages audit records by actor, action and dates, retaining long details", async () => {
    await db.insert(schema.auditLog).values([
      ...Array.from({ length: 51 }, (_, i) => ({ id: `audit-${String(i).padStart(2, "0")}`, actorId: "admin", action: "group.update", createdAt: date, details: { description: "detail ".repeat(200), clientSecret: "do-not-expose" } })),
      { id: "other-action", actorId: "admin", action: "app.delete", createdAt: date },
      { id: "other-user", actorId: "other", action: "group.update", createdAt: date },
    ]);
    const result = await listAdminActivity(admin, readActivityFilters({ tab: "audit", user: "admin", action: "group.", from: "2026-10-13", to: "2026-10-13", page: "2" }));
    expect(result.window).toMatchObject({ total: 51, pages: 2 });
    expect(result.rows[0].details).toContain("detail ".repeat(200));
    expect(result.rows[0].details).not.toContain("do-not-expose");
    expect(result.rows[0].conversationId).toBeNull();
  });

  it("rejects invalid filters without widening results and denies non-admins", async () => {
    await db.insert(schema.toolCalls).values(call("one"));
    for (const params of [{ from: "2026-02-30" }, { from: "2026-10-13", to: "2026-10-12" }, { status: "not-a-status" }]) {
      const filters = readActivityFilters(params);
      expect(filters.errors.length).toBeGreaterThan(0);
      expect((await listAdminActivity(admin, filters)).window.total).toBe(0);
    }
    expect((await listAdminActivity(admin, readActivityFilters({ user: "not-found" }))).window.total).toBe(0);
    await expect(listAdminUsers(member, "")).rejects.toMatchObject({ status: 403 });
    await expect(listAdminActivity(member, readActivityFilters({}))).rejects.toMatchObject({ status: 403 });
    expect(requestedPage("-3")).toBe(1);
    expect(requestedPage("Infinity")).toBe(1);
    expect(requestedPage("9007199254740992")).toBe(1);
  });
});

it("uses explicit UTC identically for ISO strings, Date objects and milliseconds around date changes", () => {
  const expected = "Oct 13, 2026, 3:10:00 AM UTC";
  expect(formatAdminTimestamp(date)).toBe(expected);
  expect(formatAdminTimestamp(date.toISOString())).toBe(expected);
  expect(formatAdminTimestamp(date.getTime())).toBe(expected);
  expect(formatAdminTimestamp("2026-10-12T23:10:00-04:00")).toBe(expected);
  expect(formatAdminTimestamp(null)).toBe("—");
  expect(formatAdminTimestamp("invalid")).toBe("—");
  expect(formatAdminDiagnostic({ private_key: "secret", nested: ["safe", "sk-proj-abcdefghijklmnopqrstuvwxyz"] })).not.toContain("abcdefghijklmnopqrstuvwxyz");
});

describe("admin listing page rendering", () => {
  it("shows labelled search, a clear link and an explicit empty Users result", async () => {
    const html = renderToStaticMarkup(await AdminUsersPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ q: "missing" }) }));
    expect(html).toContain('for="user-search"');
    expect(html).toContain("No users match");
    expect(html).toContain("0 users");
    expect(html).toContain('href="/admin/users"');
    expect(html).toContain("Clear search");
  });

  it("renders Users paging links that preserve search and timezone-labelled dates", async () => {
    await db.insert(schema.users).values(Array.from({ length: 51 }, (_, i) => ({ ...user(`member-${i}`, "Member"), lastLoginAt: date })));
    const html = renderToStaticMarkup(await AdminUsersPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ q: "Member" }) }));
    expect(html).toContain("1–50 of 51 users");
    expect(html).toContain('href="/admin/users?q=Member&amp;page=2"');
    expect(html).toContain('dateTime="2026-10-13T03:10:00.000Z"');
    expect(html).toContain("Oct 13, 2026, 3:10:00 AM UTC");
  });

  it("renders complete escaped Activity details, owned conversation links and resettable empty results", async () => {
    await db.insert(schema.conversations).values({ id: "own-chat", userId: "admin" });
    const full = `<script>alert('fixture')</script> ${"long detail ".repeat(120)}`;
    await db.insert(schema.toolCalls).values(call("render", { conversationId: "own-chat", input: { message: full, apiKey: "secret-fixture" } }));
    const html = renderToStaticMarkup(await AdminActivityPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ tool: "fixture_tool" }) }));
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("secret-fixture");
    expect(html).toContain("long detail ".repeat(120));
    expect(html).toContain('href="/c/own-chat"');
    expect(html).toContain("From date (UTC)");
    expect(html).toContain("1–1 of 1 records");
    const empty = renderToStaticMarkup(await AdminActivityPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ status: "error" }) }));
    expect(empty).toContain("No activity matches these filters");
    expect(empty).toContain("Clear filters");
    expect(empty).toContain('href="/admin/activity?tab=tools"');
  });
});

