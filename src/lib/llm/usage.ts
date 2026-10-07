import { db, type DbOrTx } from "@/db";
import { usageEvents, type UsageEvent } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { BillingSource, ModelPurpose, ProviderKind } from "./kinds";

/**
 * Collects the ledger writes of one turn so the turn can await them before reporting that it's done,
 * and links every call made during the turn (including delegates) to the assistant message.
 */
export type UsageScope = { pending: Promise<unknown>[]; messageId?: string; runId?: string; writer?: UsageWriter; replayAfterRollback?: () => Promise<void> };
export function newUsageScope(init: Omit<UsageScope, "pending" | "replayAfterRollback"> = {}, q?: DbOrTx): UsageScope {
  const scope: UsageScope = { pending: [], ...init };
  if (!q) return scope;
  const rows = new Map<string, UsageEvent>();
  scope.writer = async row => {
    const id = row.id ?? newId();
    // Utility jobs are bounded to a handful of calls. Bound failure accounting too.
    if (rows.size >= 1024 && !rows.has(id)) throw new Error("Utility usage scope exceeded its call bound");
    const stable = { ...row, id };
    rows.set(id, stable);
    // A failed ledger insert must not abort the admission transaction.
    return q.transaction(tx => tx.insert(usageEvents).values(stable).onConflictDoNothing());
  };
  scope.replayAfterRollback = async () => {
    await Promise.allSettled(scope.pending);
    // Called only after the outer transaction ends; never check out a second pool connection while locked.
    // Stable IDs make retries harmless even if the transaction outcome was uncertain.
    for (const row of rows.values()) {
      try { await writer(row); } catch (err) { console.error("[usage] failed to restore rolled-back usage", err); }
    }
  };
  return scope;
}

export async function restoreUsageAfterRollback(scope?: UsageScope) {
  await scope?.replayAfterRollback?.();
}

/** Who and what a model call is attributed to. */
export type UsageContext = {
  purpose: ModelPurpose;
  billingSource: BillingSource;
  providerKind: ProviderKind;
  model: string;
  appId: string | null;
  userId?: string | null;
  conversationId?: string | null;
  botId?: string | null;
  toolCallId?: string | null;
  credentialId?: string | null;
  scope?: UsageScope;
};

/** Provider-level usage (LanguageModelV4Usage), typed structurally to avoid depending on @ai-sdk/provider. */
export type ProviderUsage = {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number; reasoning?: number };
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

export function mapUsage(u: ProviderUsage | undefined) {
  return {
    inputTokens: num(u?.inputTokens?.total), // includes cached tokens
    outputTokens: num(u?.outputTokens?.total),
    cacheReadTokens: num(u?.inputTokens?.cacheRead),
    cacheWriteTokens: num(u?.inputTokens?.cacheWrite),
    reasoningTokens: num(u?.outputTokens?.reasoning),
  };
}

export type UsageWriter = (row: UsageEvent) => Promise<unknown>;
const dbWriter: UsageWriter = (row) => db.insert(usageEvents).values(row).onConflictDoNothing();
let writer: UsageWriter = dbWriter;

/** Test hook: capture ledger rows instead of writing them. */
export function setUsageWriter(w: UsageWriter | null) {
  writer = w ?? dbWriter;
}

/** Writes one ledger row. Never throws: accounting must not break a chat. */
export function recordUsage(ctx: UsageContext, tokens: ReturnType<typeof mapUsage>, search: Pick<UsageEvent, "id" | "toolCallId" | "hostedSearchCalls" | "searchToolCostEstimateMicros"> = {}): Promise<void> {
  const row: UsageEvent = {
    userId: ctx.userId ?? null,
    conversationId: ctx.conversationId ?? null,
    messageId: ctx.scope?.messageId ?? null,
    runId: ctx.scope?.runId ?? null,
    toolCallId: ctx.toolCallId ?? null,
    botId: ctx.botId ?? null,
    appId: ctx.appId,
    providerKind: ctx.providerKind,
    model: ctx.model,
    purpose: ctx.purpose,
    billingSource: ctx.billingSource,
    credentialId: ctx.credentialId ?? null,
    ...tokens,
    ...search,
  };
  const p = Promise.resolve()
    .then(() => (ctx.scope?.writer ?? writer)(row))
    .then(
      () => undefined,
      (err) => console.error("[usage] failed to record usage", err),
    );
  ctx.scope?.pending.push(p);
  return p;
}
