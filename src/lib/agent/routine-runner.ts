import { and, eq, lte, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { aiApps, conversations, inboxItems, routineRuns, routines, users, type RoutineRunStatus } from "@/db/schema";
import { loadPrincipal } from "@/lib/auth/groups";
import { graphFetch } from "@/lib/auth/entra";
import { getUsableBot } from "@/lib/authz";
import { insertMessage, partsToText, setCurrentLeaf, type PortalUIMessage } from "@/lib/chat/store";
import { newId } from "@/lib/ids";
import { enqueue, enqueueRun, QUEUES } from "@/lib/jobs";
import { nextCronRun } from "@/lib/routines";
import { insertRunTx } from "@/lib/runs/state";

async function finishRun(runId: string, status: RoutineRunStatus, error?: string, q: DbOrTx = db) {
  await q
    .update(routineRuns)
    .set({ status, error: error ?? null, finishedAt: status === "awaiting_approval" ? null : new Date() })
    .where(eq(routineRuns.id, runId));
}

/**
 * Starts one routine run (called by the worker): in one transaction, claims it (queued → running), checks the owner
 * may still use the bot and its app, and creates the conversation, the prompt message and a background agent run for
 * the reply. The reply itself is a durable run like any chat turn (src/lib/runs/execute.ts, enqueued after commit);
 * its transitions report back through afterRoutineTurn (src/lib/runs/hooks.ts). A failed check fails the routine run
 * and leaves an error in the owner's Inbox.
 */
export async function executeRoutineRun(runId: string) {
  const agentRun = await db.transaction(async (tx) => {
    const [run] = await tx
      .update(routineRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "queued")))
      .returning();
    if (!run) return null;
    const [routine] = await tx.select().from(routines).where(eq(routines.id, run.routineId));
    if (!routine) {
      await finishRun(runId, "failed", "Routine deleted", tx);
      return null;
    }
    await tx.update(routines).set({ lastRunAt: new Date() }).where(eq(routines.id, routine.id));

    let target;
    try {
      const principal = await loadPrincipal(routine.ownerId, tx);
      if (!principal) throw new Error("Routine owner is disabled or missing");
      const bot = await getUsableBot(principal, routine.botId, tx);
      if (bot.executionMode === "service") throw new Error("Service bots can only run in direct chats, not routines.");
      const [app] = bot.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
      if (!app?.enabled) throw new Error(`${bot.name} has no enabled model endpoint`);
      const stamp = new Date().toLocaleString("en-GB", { timeZone: routine.timezone, dateStyle: "medium", timeStyle: "short" });
      target = { bot, app, stamp };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishRun(runId, "failed", message, tx);
      await tx.insert(inboxItems).values({
        userId: routine.ownerId,
        kind: "routine_error",
        title: `${routine.name} failed`,
        body: message,
        routineRunId: runId,
      });
      return null;
    }
    const { bot, app, stamp } = target;
    const [conv] = await tx
      .insert(conversations)
      .values({ userId: routine.ownerId, botId: bot.id, title: `${routine.name} · ${stamp}`, source: "routine" })
      .returning();
    let text = routine.prompt;
    if (run.payload != null) text += `\n\nTrigger payload:\n\`\`\`json\n${JSON.stringify(run.payload, null, 2).slice(0, 20_000)}\n\`\`\``;
    const userMsg: PortalUIMessage = { id: newId(), role: "user", parts: [{ type: "text", text }], metadata: { createdAt: Date.now() } };
    await insertMessage(conv.id, userMsg, null, {}, tx);
    await setCurrentLeaf(conv.id, userMsg.id, {}, tx);
    const created = await insertRunTx(tx, {
      userId: routine.ownerId,
      conversationId: conv.id,
      messageId: newId(),
      parentMessageId: userMsg.id,
      appId: app.id,
      botId: bot.id,
      routineRunId: runId,
      background: true,
    });
    await tx.update(routineRuns).set({ conversationId: conv.id }).where(eq(routineRuns.id, runId));
    return created;
  });
  if (!agentRun) return;
  // A lost job leaves the run queued; the worker's sweeper enqueues it again (claiming is idempotent).
  await enqueueRun(agentRun).catch((err) => console.error(`[routines] couldn't enqueue run ${agentRun.id}; the sweeper will retry`, err));
}

/**
 * Routine bookkeeping for a reply that paused or ended: the routine run's status and an Inbox item (plus the optional
 * email for a result). Called once per run transition by afterRunTransition (src/lib/runs/hooks.ts).
 */
export async function afterRoutineTurn(opts: {
  runId: string;
  routineName: string;
  botName: string;
  userId: string;
  conversationId: string;
  responseMessage: PortalUIMessage;
  pendingApproval: boolean;
  error?: string;
  notifyEmail?: boolean;
  /** The Inbox item's text instead of the default (e.g. an approval with a deadline). */
  body?: string;
}) {
  const summary = partsToText(opts.responseMessage.parts).slice(0, 1500);
  if (opts.error) {
    await finishRun(opts.runId, "failed", opts.error);
    await db.insert(inboxItems).values({
      userId: opts.userId,
      kind: "routine_error",
      title: `${opts.routineName} failed`,
      body: opts.body ?? opts.error,
      conversationId: opts.conversationId,
      routineRunId: opts.runId,
    });
  } else if (opts.pendingApproval) {
    await finishRun(opts.runId, "awaiting_approval");
    await db.insert(inboxItems).values({
      userId: opts.userId,
      kind: "approval",
      title: `${opts.botName} needs your approval`,
      body: opts.body ?? `Routine "${opts.routineName}" paused before a sensitive action. Open the conversation to allow or deny it.`,
      conversationId: opts.conversationId,
      routineRunId: opts.runId,
    });
  } else {
    await finishRun(opts.runId, "succeeded");
    await db.insert(inboxItems).values({
      userId: opts.userId,
      kind: "routine_result",
      title: `${opts.routineName} finished`,
      body: opts.body ?? (summary || "(no text output)"),
      conversationId: opts.conversationId,
      routineRunId: opts.runId,
    });
    const [owner] = opts.notifyEmail ? await db.select({ email: users.email }).from(users).where(eq(users.id, opts.userId)) : [];
    if (opts.notifyEmail && owner?.email) {
      await graphFetch(opts.userId, "/me/sendMail", {
        method: "POST",
        body: JSON.stringify({
          message: {
            subject: `[${opts.botName}] ${opts.routineName}`,
            body: { contentType: "Text", content: summary },
            toRecipients: [{ emailAddress: { address: owner.email } }],
          },
          saveToSentItems: false,
        }),
      }).catch((e) => console.warn("[routines] email notification failed:", e.message));
    }
  }
}

/** Scheduler tick: claim due cron routines atomically and enqueue runs. */
export async function scheduleDueRoutines(now = new Date()) {
  const due = await db
    .select()
    .from(routines)
    .where(and(eq(routines.enabled, true), eq(routines.triggerType, "cron"), lte(routines.nextRunAt, now)));
  let queued = 0;
  for (const r of due) {
    let next: Date | null = null;
    try {
      next = nextCronRun(r.cron ?? "", r.timezone, now);
    } catch {
      next = null;
    }
    // The queued row is a durable outbox. Advancing the schedule and recording the work must
    // commit together; a lost/failed send is retried by the sweeper using this same run ID.
    const run = await db.transaction(async (tx) => {
      const claimed = await tx.update(routines).set({ nextRunAt: next }).where(and(
        eq(routines.id, r.id), eq(routines.enabled, true), eq(routines.triggerType, "cron"),
        sql`${routines.nextRunAt} = ${r.nextRunAt}`,
      )).returning({ id: routines.id });
      if (!claimed.length) return null;
      const [created] = await tx.insert(routineRuns).values({ routineId: r.id, trigger: "schedule", lastEnqueueAt: new Date() }).returning();
      return created;
    });
    if (run && await enqueue(QUEUES.routineRun, { runId: run.id }, { singletonKey: run.id })) queued++;
  }
  return queued;
}
