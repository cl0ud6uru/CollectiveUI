import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { aiApps, bots, conversations, providerConnections, users } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { auditVia } from "@/lib/audit";
import { HttpError } from "@/lib/authz";
import { architectCallDenial, architectModelEligible } from "@/lib/bots/architect-policy";
import { getSetting } from "@/lib/settings";
import type { AgentCtx } from "../types";

/** Re-check the live actor, session, installation, model and owning direct conversation at dispatch. */
export async function authorizeArchitectCall(ctx: AgentCtx, q: DbOrTx = db): Promise<Principal> {
  const [fresh, receipt, bot, conversation] = await Promise.all([
    loadPrincipal(ctx.principal.user.id, q), getSetting("architectBot", q),
    ctx.bot ? q.select().from(bots).where(eq(bots.id, ctx.bot.id)).then(([row]) => row ?? null) : null,
    q.select().from(conversations).where(eq(conversations.id, ctx.conversationId)).then(([row]) => row),
  ]);
  const denial = architectCallDenial({ fresh, sessionVersion: ctx.principal.user.sessionVersion, receiptBotId: receipt.botId, bot, ctx });
  if (denial) throw new HttpError(403, denial);
  if (!conversation || conversation.userId !== fresh!.user.id || conversation.botId !== bot!.id || conversation.isGroup || conversation.source !== "chat")
    throw new HttpError(403, "Admin tools require your direct conversation with The Architect.");
  const [app] = bot!.appId ? await q.select().from(aiApps).where(eq(aiApps.id, bot!.appId)) : [];
  if (!app || ctx.app?.id !== app.id || !architectModelEligible(app))
    throw new HttpError(403, "The Architect's model changed or is unavailable. Start a new request.");
  if (app.providerConnectionId) {
    const [connection] = await q.select({ enabled: providerConnections.enabled }).from(providerConnections).where(eq(providerConnections.id, app.providerConnectionId));
    if (!connection?.enabled) throw new HttpError(403, "The Architect's provider connection is unavailable.");
  }
  return fresh!;
}

/** No inputs, outputs or upstream exception text enter the audit log or returned failures. */
export async function runArchitectCall<T>(ctx: AgentCtx, tool: string, toolCallId: string, run: (p: Principal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const via = { agent: "architect", botId: ctx.bot?.id ?? "" } as const;
  const record = (outcome: "ok" | "denied" | "error") =>
    auditVia(ctx.principal.user.id, via, "architect.tool", tool, { conversationId: ctx.conversationId, toolCallId, outcome });
  let p: Principal;
  try { signal?.throwIfAborted(); p = await authorizeArchitectCall(ctx); }
  catch {
    // A deleted actor cannot satisfy the audit FK. Never expose diagnostics from the audit sink.
    await record("denied").catch(() => undefined);
    throw new HttpError(403, "Admin tool access changed or the request was cancelled. Start a new request.");
  }
  try {
    const result = await run(p);
    signal?.throwIfAborted();
    await record("ok");
    return result;
  } catch {
    await record("error").catch(() => undefined);
    throw new HttpError(409, "The admin operation could not be verified. Inspect Admin before retrying; do not assume a change succeeded.");
  }
}

/** Shared lock used by write APIs before their second authorization check. */
export async function lockArchitectActor(ctx: AgentCtx, q: DbOrTx) {
  await q.select({ id: users.id }).from(users).where(eq(users.id, ctx.principal.user.id)).for("share");
  if (ctx.bot) await q.select({ id: bots.id }).from(bots).where(eq(bots.id, ctx.bot.id)).for("share");
}
