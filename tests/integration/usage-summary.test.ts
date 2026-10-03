import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("usage reporting (integration)", () => {
  const userId = `it-usage-${process.pid}-${Date.now()}`;
  let before: { input: number; output: number };

  beforeAll(async () => {
    const { usageSummary } = await import("@/lib/usage");
    const { totals } = await usageSummary(30);
    before = { input: Number(totals.input_tokens), output: Number(totals.output_tokens) };

    const { db } = await import("@/db");
    const { conversations, messages, usageEvents, users } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    await db.insert(users).values({ id: userId, upn: `${userId}@corp.local`, name: "Usage Test", authSource: "ldap" });
    const [conv] = await db.insert(conversations).values({ id: newId(), userId, title: "=cmd|' /C calc'!A0" }).returning();
    // Legacy reply (before the ledger): counted from the message row.
    await db.insert(messages).values({ id: newId(), conversationId: conv.id, role: "assistant", parts: [], inputTokens: 100, outputTokens: 10 });
    // New reply: its tokens live in usage_events, so the message row must not be counted again.
    const msgId = newId();
    await db
      .insert(messages)
      .values({ id: msgId, conversationId: conv.id, role: "assistant", parts: [], inputTokens: 999, outputTokens: 999, billingSource: "org" });
    await db.insert(usageEvents).values([
      { userId, conversationId: conv.id, messageId: msgId, providerKind: "anthropic", model: "m", purpose: "chat", billingSource: "org", inputTokens: 40, outputTokens: 4, cacheReadTokens: 30 },
      { userId, conversationId: conv.id, messageId: msgId, providerKind: "anthropic", model: "m", purpose: "chat", billingSource: "org", inputTokens: 50, outputTokens: 5 },
      { userId, conversationId: conv.id, providerKind: "openai", model: "t", purpose: "title", billingSource: "org", inputTokens: 7, outputTokens: 1 },
    ]);
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { usageEvents, users } = await import("@/db/schema");
    await db.delete(usageEvents).where(eq(usageEvents.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it("adds ledger tokens to legacy message tokens without double counting", async () => {
    const { usageSummary } = await import("@/lib/usage");
    const { totals, byUser } = await usageSummary(30);
    expect(Number(totals.input_tokens) - before.input).toBeGreaterThanOrEqual(100 + 40 + 50 + 7);
    expect(Number(totals.cache_read_tokens)).toBeGreaterThanOrEqual(30);
    const me = byUser.find((u) => u.upn === `${userId}@corp.local`);
    expect(me).toMatchObject({ messages: 2 });
    expect(Number(me!.tokens)).toBe(110 + 99 + 8);
  });

  it("exports per-purpose rows with background work bucketed", async () => {
    const { usageExportRows, toCsv, USAGE_EXPORT_COLUMNS } = await import("@/lib/usage");
    const rows = (await usageExportRows(90)).filter((r) => r.upn === `${userId}@corp.local`);
    const background = rows.find((r) => r.purpose === "title");
    expect(background).toMatchObject({ target: "Background", replies: 0, billing_source: "org" });
    const csv = toCsv(rows, USAGE_EXPORT_COLUMNS);
    expect(csv.split("\n")[0]).toBe("day,upn,target,replies,input_tokens,output_tokens,purpose,cache_read_tokens,cache_write_tokens,reasoning_tokens,billing_source");
  });
});
