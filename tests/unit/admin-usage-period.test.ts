import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, admin: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({ requireAdminPage: fixture.admin, requireAdmin: fixture.admin,
  errorResponse: () => Response.json({ error: "Admin only" }, { status: 403 }) }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from "@/db";
import { ADMIN_USAGE_DAYS, usageSummary, usageExportRows } from "@/lib/usage";
import AdminUsagePage from "@/app/admin/page";
import { GET } from "@/app/api/admin/usage.csv/route";

let now: number;
const ago = (days: number) => new Date(now - days * 86_400_000);

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(file => file.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8")
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 60000);
beforeEach(async () => {
  fixture.admin.mockReset().mockResolvedValue({ isAdmin: true });
  // PostgreSQL now() stays fixed inside this transaction, including the exact cutoff.
  await fixture.client!.exec("BEGIN");
  const result = await fixture.client!.query<{ now: Date }>("select now() as now");
  now = new Date(result.rows[0].now).getTime();
  await db.insert(schema.users).values({ id: "fixture", upn: "fixture@fixture.invalid", name: "Fixture", authSource: "ldap" });
  await db.insert(schema.conversations).values({ id: "chat", userId: "fixture" });
  await db.insert(schema.messages).values([29, 30, 31, 89].map(days => ({
    id: `reply-${days}`, conversationId: "chat", role: "assistant" as const, parts: [],
    inputTokens: 10, outputTokens: 2, createdAt: ago(days),
  })));
  await db.insert(schema.usageEvents).values([29, 30, 31, 89].map(days => ({
    id: `event-${days}`, userId: "fixture", conversationId: "chat", providerKind: "openai" as const,
    model: "fixture", purpose: "title" as const, billingSource: "org" as const,
    inputTokens: 5, outputTokens: 1, createdAt: ago(days),
  })));
});
afterEach(async () => { await fixture.client!.exec("ROLLBACK"); });
afterAll(async () => { await fixture.client!.close(); });

describe("admin Usage period on isolated SQL", () => {
  it("keeps the default summary and export on the same rolling 30-day cutoff for legacy replies and ledger tokens", async () => {
    expect(ADMIN_USAGE_DAYS).toBe(30);
    const { totals } = await usageSummary();
    const rows = await usageExportRows();
    expect(Number(totals.messages)).toBe(1);
    expect(Number(totals.input_tokens)).toBe(15);
    expect(Number(totals.output_tokens)).toBe(3);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + Number(row.replies), 0)).toBe(Number(totals.messages));
    expect(rows.reduce((sum, row) => sum + Number(row.input_tokens) + Number(row.output_tokens), 0)).toBe(18);
    expect(rows.map(row => row.day)).toEqual([ago(29).toISOString().slice(0, 10), ago(29).toISOString().slice(0, 10)]);
    // The old 90-day range includes the excluded cutoff, 31-day and 89-day rows.
    expect((await usageExportRows(90)).reduce((sum, row) => sum + Number(row.replies), 0)).toBe(4);
  });

  it("labels the rendered download and downloaded filename with the range actually exported", async () => {
    const html = renderToStaticMarkup(await AdminUsagePage());
    expect(html).toContain("Last 30 days");
    expect(html).toContain('href="/api/admin/usage.csv"');
    expect(html).toContain("Export CSV · last 30 days");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="usage-last-30-days.csv"');
    const csv = await response.text();
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain(ago(29).toISOString().slice(0, 10));
    for (const days of [30, 31, 89]) expect(csv).not.toContain(ago(days).toISOString().slice(0, 10));
  });

  it("keeps the CSV behind admin authorization", async () => {
    fixture.admin.mockRejectedValue(new Error("Admin only"));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).not.toContain("fixture@fixture.invalid");
  });
});
