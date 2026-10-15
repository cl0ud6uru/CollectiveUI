import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { nativeRunBudgetAttempts as attempts, nativeRunBudgets as budgets } from "@/db/schema";
import { newId } from "@/lib/ids";
import { nativeBudgetCost, nativeBudgetEnvelope, nativeBudgetRoute, nativeRunBudgetPolicy, NativeRunBudgetError, NativeRunBudgetPolicySchema, type NativeRunBudgetPolicy } from "./run-budget-policy";
import type { UsageContext } from "./usage";

export type NativeBudgetHandle = { rootMessageId: string; userId: string; policy: NativeRunBudgetPolicy };
export type NativeBudgetReceipt = { id: string; handle: NativeBudgetHandle };

export async function nativeBudgetHandle(ctx: UsageContext): Promise<NativeBudgetHandle | null> {
  const configured = nativeRunBudgetPolicy();
  if (!configured || !ctx.scope?.rootBudgetId) return null;
  if (!ctx.userId || ctx.billingSource !== "org" || !ctx.billingRoute?.startsWith("api:")) {
    throw new NativeRunBudgetError("This runtime has no supported company run-budget contract. No billing fallback was selected.");
  }
  const rootMessageId = ctx.scope.rootBudgetId;
  await db.insert(budgets).values({ rootMessageId, userId: ctx.userId, policy: configured }).onConflictDoNothing();
  const [row] = await db.select().from(budgets).where(eq(budgets.rootMessageId, rootMessageId));
  if (!row || row.userId !== ctx.userId) throw new NativeRunBudgetError("The native run budget does not belong to this requester.");
  const parsed = NativeRunBudgetPolicySchema.safeParse(row.policy);
  if (!parsed.success) throw new NativeRunBudgetError("The native run budget policy needs administrator review.");
  return { rootMessageId, userId: row.userId, policy: parsed.data };
}

/** Every provider attempt, including a retry, owns a distinct durable reservation. */
export async function reserveNativeBudget(handle: NativeBudgetHandle, ctx: UsageContext, input: unknown, outputTokens: number): Promise<NativeBudgetReceipt> {
  return db.transaction(async tx => {
    const [root] = await tx.select().from(budgets).where(eq(budgets.rootMessageId, handle.rootMessageId)).for("update");
    if (!root || root.userId !== ctx.userId || root.userId !== handle.userId) throw new NativeRunBudgetError("Native run budget ownership changed.");
    const route = nativeBudgetRoute(root.policy, ctx.providerKind, ctx.model);
    const quote = nativeBudgetEnvelope(root.policy, route, input, outputTokens);
    if (root.exhausted || (root.policy.maxTokens !== null && root.usedTokens + root.reservedTokens + quote.tokens > root.policy.maxTokens) ||
      (root.policy.maxCostMicros !== null && root.usedCostMicros + root.reservedCostMicros + quote.costMicros > root.policy.maxCostMicros)) {
      throw new NativeRunBudgetError("This native request tree reached its configured company model budget. No provider request was sent and no billing fallback was selected.");
    }
    const id = newId();
    await tx.insert(attempts).values({ id, rootMessageId: root.rootMessageId, runId: ctx.scope?.runId ?? null, appId: ctx.appId,
      provider: ctx.providerKind, model: ctx.model, purpose: ctx.purpose, inputReserved: quote.inputTokens, outputReserved: quote.outputTokens, costReservedMicros: quote.costMicros });
    await tx.update(budgets).set({ reservedTokens: root.reservedTokens + quote.tokens, reservedCostMicros: root.reservedCostMicros + quote.costMicros }).where(eq(budgets.rootMessageId, root.rootMessageId));
    return { id, handle: { ...handle, policy: root.policy } };
  });
}

export async function markNativeBudgetDispatched(receipt: NativeBudgetReceipt) {
  const [row] = await db.update(attempts).set({ state: "dispatched" }).where(and(eq(attempts.id, receipt.id), eq(attempts.rootMessageId, receipt.handle.rootMessageId), eq(attempts.state, "reserved"))).returning({ id: attempts.id });
  if (!row) throw new NativeRunBudgetError("The native model reservation was already dispatched or released.");
}

export async function retainNativeBudget(receipt: NativeBudgetReceipt) {
  await db.update(attempts).set({ state: "uncertain" }).where(and(eq(attempts.id, receipt.id), eq(attempts.state, "dispatched")));
}

/** Only pre-dispatch proof releases an entire reservation. Unknown/aborted dispatches are never refunded. */
export async function releaseNativeBudget(receipt: NativeBudgetReceipt) {
  await db.transaction(async tx => {
    const [root] = await tx.select().from(budgets).where(eq(budgets.rootMessageId, receipt.handle.rootMessageId)).for("update");
    const [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, receipt.id), eq(attempts.rootMessageId, receipt.handle.rootMessageId))).for("update");
    if (!root || !attempt || attempt.state !== "reserved") return;
    await tx.update(budgets).set({ reservedTokens: root.reservedTokens - attempt.inputReserved - attempt.outputReserved, reservedCostMicros: root.reservedCostMicros - attempt.costReservedMicros }).where(eq(budgets.rootMessageId, root.rootMessageId));
    await tx.update(attempts).set({ state: "released", settledAt: new Date() }).where(eq(attempts.id, attempt.id));
  });
}

const counter = (value: number | null | undefined) => Number.isSafeInteger(value) && value! >= 0 && value! <= 1_000_000_000_000;
/** Complete authoritative counters settle once. Overage is charged fully and permanently stops later admission. */
export async function settleNativeBudget(receipt: NativeBudgetReceipt, input: number | null | undefined, output: number | null | undefined, options: { complete?: boolean } = {}) {
  if (options.complete === false || !counter(input) || !counter(output)) {
    await db.transaction(async tx => {
      const [root] = await tx.select().from(budgets).where(eq(budgets.rootMessageId, receipt.handle.rootMessageId)).for("update");
      const [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, receipt.id), eq(attempts.rootMessageId, receipt.handle.rootMessageId))).for("update");
      if (!root || !attempt || !["dispatched", "uncertain"].includes(attempt.state)) return;
      const invalidReport = (input != null && !counter(input)) || (output != null && !counter(output));
      if (invalidReport || (counter(input) && input! > attempt.inputReserved) || (counter(output) && output! > attempt.outputReserved))
        await tx.update(budgets).set({ exhausted: true }).where(eq(budgets.rootMessageId, root.rootMessageId));
      await tx.update(attempts).set({ state: "uncertain", ...(counter(input) ? { inputTokens: input! } : {}), ...(counter(output) ? { outputTokens: output! } : {}) }).where(eq(attempts.id, attempt.id));
    });
    return;
  }
  await db.transaction(async tx => {
    const [root] = await tx.select().from(budgets).where(eq(budgets.rootMessageId, receipt.handle.rootMessageId)).for("update");
    const [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, receipt.id), eq(attempts.rootMessageId, receipt.handle.rootMessageId))).for("update");
    if (!root || !attempt || !["dispatched", "uncertain"].includes(attempt.state)) return;
    const route = nativeBudgetRoute(root.policy, attempt.provider, attempt.model);
    let costMicros: number;
    try { costMicros = nativeBudgetCost(input!, output!, route); }
    catch {
      // An implausibly large report cannot fit the supported numeric cost envelope. Preserve all known
      // counters and outstanding capacity, and stop further dispatches rather than refunding or rounding it.
      await tx.update(budgets).set({ exhausted: true }).where(eq(budgets.rootMessageId, root.rootMessageId));
      await tx.update(attempts).set({ state: "uncertain", inputTokens: input!, outputTokens: output! }).where(eq(attempts.id, attempt.id));
      return;
    }
    const usedTokens = root.usedTokens + input! + output!;
    const usedCostMicros = root.usedCostMicros + costMicros;
    if (!Number.isSafeInteger(usedTokens) || !Number.isSafeInteger(usedCostMicros)) {
      await tx.update(budgets).set({ exhausted: true }).where(eq(budgets.rootMessageId, root.rootMessageId));
      await tx.update(attempts).set({ state: "uncertain", inputTokens: input!, outputTokens: output! }).where(eq(attempts.id, attempt.id));
      return;
    }
    const reservedTokens = root.reservedTokens - attempt.inputReserved - attempt.outputReserved;
    const reservedCostMicros = root.reservedCostMicros - attempt.costReservedMicros;
    const exceeded = input! > attempt.inputReserved || output! > attempt.outputReserved ||
      (root.policy.maxTokens !== null && usedTokens + reservedTokens > root.policy.maxTokens) || (root.policy.maxCostMicros !== null && usedCostMicros + reservedCostMicros > root.policy.maxCostMicros);
    await tx.update(budgets).set({ usedTokens, usedCostMicros, reservedTokens, reservedCostMicros, exhausted: root.exhausted || exceeded }).where(eq(budgets.rootMessageId, root.rootMessageId));
    await tx.update(attempts).set({ state: "settled", inputTokens: input!, outputTokens: output!, costMicros, settledAt: new Date() }).where(eq(attempts.id, attempt.id));
  });
}
