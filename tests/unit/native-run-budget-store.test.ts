import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite"); const { drizzle } = await import("drizzle-orm/pglite"); const schema = await import("@/db/schema");
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from "@/db";
import { newUsageScope, type UsageContext } from "@/lib/llm/usage";
import { nativeBudgetEnvelope, type NativeRunBudgetPolicy } from "@/lib/llm/run-budget-policy";
import { nativeBudgetApplies, nativeBudgetHandle, markNativeBudgetDispatched, releaseNativeBudget, reserveNativeBudget, retainNativeBudget, settleNativeBudget } from "@/lib/llm/run-budget-store";

const input = { prompt: [{ role: "user", content: [{ type: "text", text: "Fixture" }] }] };
const policy: NativeRunBudgetPolicy = { enabled: true, maxTokens: 100_000, maxCostMicros: 100_000, maxInputTokensPerCall: 50_000, maxOutputTokensPerCall: 1_000,
  routes: [{ provider: "openai", model: "fixture", inputContract: "conservative-text-v1", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 }] };
const context = (runId = "root-run", rootBudgetId = "root-reply"): UsageContext => ({ purpose: "chat", billingSource: "org", providerKind: "openai", model: "fixture", appId: "app", userId: "actor", billingRoute: "api:openai", scope: newUsageScope({ messageId: `${runId}-reply`, runId, rootBudgetId }) });
const root = async () => (await db.select().from(schema.nativeRunBudgets))[0];
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(file => file.endsWith(".sql")).sort()) await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 60000);
beforeEach(async () => {
  await fixture.client!.exec("TRUNCATE users CASCADE");
  await db.insert(schema.users).values([{ id: "actor", upn: "actor@fixture.invalid", name: "Actor", authSource: "ldap" }, { id: "other", upn: "other@fixture.invalid", name: "Other", authSource: "ldap" }]);
  vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify(policy));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await fixture.client!.close(); });

describe("durable shared native budget admission", () => {
  it("is disabled by default and leaves independent utility scopes outside a run-tree policy", async () => {
    vi.stubEnv("NATIVE_RUN_BUDGET", ""); expect(await nativeBudgetHandle(context())).toBeNull();
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify(policy)); expect(await nativeBudgetHandle({ ...context(), scope: newUsageScope() })).toBeNull();
    expect(await db.select().from(schema.nativeRunBudgets)).toHaveLength(0);
  });
  it("keeps an existing root authoritative when a continuation worker has configuration disabled", async () => {
    const quote = nativeBudgetEnvelope(policy, policy.routes[0], input, 100);
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, maxTokens: quote.tokens, maxCostMicros: null }));
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const first = await reserveNativeBudget(handle, ctx, input, 100); await markNativeBudgetDispatched(first);
    vi.stubEnv("NATIVE_RUN_BUDGET", "");
    const child = context("child"); const existing = (await nativeBudgetHandle(child))!;
    expect(existing.policy).toEqual(handle.policy);
    expect(await nativeBudgetApplies(ctx.scope!.rootBudgetId)).toBe(true);
    expect(await nativeBudgetApplies("new-root")).toBe(false);
    await expect(reserveNativeBudget(existing, child, input, 100)).rejects.toThrow("configured company model budget");
    expect(await nativeBudgetHandle(context("new", "new-root"))).toBeNull();
    expect(await db.select().from(schema.nativeRunBudgetAttempts)).toHaveLength(1);
  });
  it("atomically shares exhaustion across concurrent root, delegate and continuation attempts", async () => {
    const quote = nativeBudgetEnvelope(policy, policy.routes[0], input, 100);
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, maxTokens: quote.tokens * 2, maxCostMicros: null }));
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => reserveNativeBudget(handle, { ...context(i % 2 ? `child-${i}` : "root-run"), purpose: i % 2 ? "delegate" : "chat" }, input, 100)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(6);
    expect(await root()).toMatchObject({ reservedTokens: quote.tokens * 2, usedTokens: 0 });
    expect(await db.select().from(schema.nativeRunBudgetAttempts)).toHaveLength(2);
  });
  it("uses monetary outstanding reservations as well as reported cost when admitting competitors", async () => {
    const quote = nativeBudgetEnvelope(policy, policy.routes[0], input, 100);
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, maxTokens: null, maxCostMicros: quote.costMicros }));
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const [first, second] = await Promise.allSettled([reserveNativeBudget(handle, ctx, input, 100), reserveNativeBudget(handle, context("child"), input, 100)]);
    expect([first, second].filter(result => result.status === "fulfilled")).toHaveLength(1);
    const receipt = ([first, second].find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveNativeBudget>>>).value;
    await markNativeBudgetDispatched(receipt); await settleNativeBudget(receipt, 10, 2);
    expect(await root()).toMatchObject({ usedTokens: 12, usedCostMicros: 14, reservedTokens: 0, reservedCostMicros: 0 });
    await expect(reserveNativeBudget(handle, ctx, input, 100)).rejects.toThrow("configured company model budget");
  });
  it("releases unused capacity on complete usage once, with a separate durable receipt for every retry", async () => {
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const first = await reserveNativeBudget(handle, ctx, input, 100);
    await markNativeBudgetDispatched(first); await settleNativeBudget(first, 10, 3); await settleNativeBudget(first, 10, 3);
    expect(await root()).toMatchObject({ usedTokens: 13, usedCostMicros: 16, reservedTokens: 0, reservedCostMicros: 0 });
    const retry = await reserveNativeBudget(handle, ctx, input, 100);
    expect(retry.id).not.toBe(first.id);
    await markNativeBudgetDispatched(retry); await settleNativeBudget(retry, 20, 2);
    expect(await root()).toMatchObject({ usedTokens: 35, usedCostMicros: 40, reservedTokens: 0 });
  });
  it("retains the whole reservation for ambiguous errors, missing counters and cancellation", async () => {
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const receipt = await reserveNativeBudget(handle, ctx, input, 100);
    const reserved = (await root()).reservedTokens;
    await markNativeBudgetDispatched(receipt); await retainNativeBudget(receipt); await settleNativeBudget(receipt, 10, null); await releaseNativeBudget(receipt);
    expect(await root()).toMatchObject({ reservedTokens: reserved, usedTokens: 0 });
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: "uncertain", inputTokens: 10, outputTokens: null });
  });
  it("closes admission on a known partial overage even if the other counter is unreported", async () => {
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const receipt = await reserveNativeBudget(handle, ctx, input, 100);
    await markNativeBudgetDispatched(receipt); await settleNativeBudget(receipt, null, 101);
    expect(await root()).toMatchObject({ exhausted: true, usedTokens: 0 });
    expect((await root()).reservedTokens).toBeGreaterThan(0);
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: "uncertain", inputTokens: null, outputTokens: 101 });
    await expect(reserveNativeBudget(handle, ctx, input, 1)).rejects.toThrow("configured company model budget");
  });
  it("releases only a proven pre-dispatch reservation, idempotently", async () => {
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const receipt = await reserveNativeBudget(handle, ctx, input, 100);
    await releaseNativeBudget(receipt); await releaseNativeBudget(receipt);
    expect(await root()).toMatchObject({ reservedTokens: 0, usedTokens: 0, reservedCostMicros: 0 });
    await expect(markNativeBudgetDispatched(receipt)).rejects.toThrow("already dispatched or released");
  });
  it("charges reported overage fully and permanently closes later admission", async () => {
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const receipt = await reserveNativeBudget(handle, ctx, input, 100);
    await markNativeBudgetDispatched(receipt); await settleNativeBudget(receipt, 20, 101);
    expect(await root()).toMatchObject({ usedTokens: 121, usedCostMicros: 222, reservedTokens: 0, exhausted: true });
    await expect(reserveNativeBudget(handle, ctx, input, 1)).rejects.toThrow("configured company model budget");
  });
  it("retains numeric-overflow reports and closes admission instead of refunding or rounding them", async () => {
    const highRate = { ...policy, routes: [{ ...policy.routes[0], inputMicrosPerMillion: 100_000_000 }] };
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...highRate, maxCostMicros: 1_000_000_000_000 }));
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    const receipt = await reserveNativeBudget(handle, ctx, input, 100);
    await markNativeBudgetDispatched(receipt); await settleNativeBudget(receipt, 1_000_000_000_000, 1);
    expect(await root()).toMatchObject({ exhausted: true, usedTokens: 0 });
    expect((await root()).reservedTokens).toBeGreaterThan(0);
    expect((await db.select().from(schema.nativeRunBudgetAttempts))[0]).toMatchObject({ state: "uncertain", inputTokens: 1_000_000_000_000, outputTokens: 1, costMicros: null });
    await expect(reserveNativeBudget(handle, ctx, input, 1)).rejects.toThrow("configured company model budget");
  });
  it("freezes model rates/caps in the root policy and separates independent roots and owners", async () => {
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, maxTokens: 1, routes: [{ ...policy.routes[0], inputMicrosPerMillion: 99 }] }));
    expect((await nativeBudgetHandle(context("continuation")))?.policy).toEqual(policy);
    const receipt = await reserveNativeBudget(handle, ctx, input, 100); await markNativeBudgetDispatched(receipt); await settleNativeBudget(receipt, 1, 1);
    expect(await root()).toMatchObject({ usedCostMicros: 3 });
    await expect(nativeBudgetHandle({ ...ctx, userId: "other" })).rejects.toThrow("does not belong");
    expect((await nativeBudgetHandle(context("another", "another-root")))?.policy.maxTokens).toBe(1);
  });
  it("rejects unknown prices and unverified billing routes without creating an attempt", async () => {
    vi.stubEnv("NATIVE_RUN_BUDGET", JSON.stringify({ ...policy, routes: [{ ...policy.routes[0], inputMicrosPerMillion: undefined }] }));
    const ctx = context(); const handle = (await nativeBudgetHandle(ctx))!;
    await expect(reserveNativeBudget(handle, ctx, input, 100)).rejects.toThrow("price is unknown");
    await expect(nativeBudgetHandle({ ...context("remote", "remote-root"), billingRoute: "unknown:hermes", billingSource: "hermes", providerKind: "hermes" })).rejects.toThrow("no supported company");
    expect(await db.select().from(schema.nativeRunBudgetAttempts)).toHaveLength(0);
  });
});
