import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentRuns, aiApps, conversationBots, conversations, delegatedTasks, hermesRunContexts, messages, users } from "@/db/schema";
import { loadPrincipal } from "@/lib/auth/groups";
import { getUsableBot, HttpError } from "@/lib/authz";
import type { AgentCtx } from "@/lib/agent/types";
import { insertMessage, setCurrentLeaf } from "@/lib/chat/store";
import { sha256Hex } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { isManagedHermes } from "@/lib/hermes-provisioning/config";
import { lockUserRuns } from "@/lib/runs/lock";
import { snapshotHermesSettings } from "@/lib/runs/hermes-context";
import { runConfig } from "@/lib/runs/types";
import { canonicalJson } from "@/lib/mcp/snapshot";
import { checkAncestry, MAX_ROOT_ACTIVE_TASKS, MAX_ROOT_TASKS, MAX_USER_OPEN_ASYNC_TASKS } from "./policy";
import { assertDelegationEdge } from "./targets";
import { resolveAdmissionSource, resolveTaskSource, type DelegationSource } from "./source";

export type DelegatedTask = typeof delegatedTasks.$inferSelect;

async function authorizePath(userId: string, sessionVersion: number, path: DelegatedTask["ancestry"], source: DelegationSource, q: DbOrTx = db, nativeOnly = false) {
  const principal = await loadPrincipal(userId, q);
  if (!principal || principal.user.sessionVersion !== sessionVersion) throw new HttpError(403, "The account or session changed.");
  nativeOnly ||= path.some(edge => edge.mode === "coordinator");
  for (const [index, edge] of path.entries()) {
    if (edge.mode === "coordinator" && (index !== 0 || edge.from !== source.botId)) throw new HttpError(403, "Invalid coordinator task ancestry.");
    const from = await getUsableBot(principal, edge.from, q);
    const to = await getUsableBot(principal, edge.to, q);
    if (from.executionMode === "service" || to.executionMode === "service") throw new HttpError(403, "Service bots can only run in direct chats.");
    for (const bot of [from, to]) {
      const [app] = bot.appId ? await q.select().from(aiApps).where(eq(aiApps.id, bot.appId)) : [];
      if (!app?.enabled) throw new HttpError(403, "This delegation's connection is unavailable.");
      if (nativeOnly && app.provider === "hermes") throw new HttpError(403, "Asynchronous delegation supports native engines only.");
      if (isManagedHermes(app)) throw new HttpError(403, "Automatic Hermes profiles support direct bot chats only.");
    }
    await assertDelegationEdge(principal, edge, source, q, nativeOnly);
  }
  return principal;
}

/** Called before each model step/tool and before result delivery. Never grants the bot owner's authority. */
export async function assertTaskExecution(task: DelegatedTask, q: DbOrTx = db) {
  const [parentTask] = task.parentTaskId ? await q.select().from(delegatedTasks).where(and(eq(delegatedTasks.id, task.parentTaskId), eq(delegatedTasks.userId, task.userId))) : [];
  const source = await resolveTaskSource(task, q);
  const principal = await authorizePath(task.userId, task.sessionVersion, task.ancestry, source, q, task.mode === "async" || parentTask?.mode === "async");
  if (Date.now() >= task.deadlineAt.getTime()) throw new HttpError(409, "The delegated task deadline expired.");
  if (!task.originConversationId || !task.childConversationId || !task.childRunId) throw new HttpError(409, "This task's conversation was removed.");
  const rows = await q.select().from(conversations).where(and(eq(conversations.userId, task.userId), inArray(conversations.id, [task.originConversationId, task.childConversationId])));
  const origin = rows.find(c => c.id === task.originConversationId);
  const child = rows.find(c => c.id === task.childConversationId);
  if (!origin || !child || child.source !== "delegation" || child.isGroup || child.isBotHome || child.botId !== task.receiverBotId)
    throw new HttpError(403, "This task's ownership changed.");
  const receiver = await getUsableBot(principal, task.receiverBotId, q);
  const [childRun] = await q.select().from(agentRuns).where(eq(agentRuns.id, task.childRunId));
  if (!childRun || childRun.userId !== task.userId || childRun.botId !== receiver.id || childRun.appId !== receiver.appId || childRun.conversationId !== child.id || childRun.executionMode !== (task.mode === "async" ? "async_delegate" : "inline_delegate"))
    throw new HttpError(403, "This task's connection or ownership changed.");
  if (task.parentRunId) {
    const [parent] = await q.select().from(agentRuns).where(eq(agentRuns.id, task.parentRunId));
    if (!parent || parent.userId !== task.userId || parent.conversationId !== origin.id || parent.messageId !== task.originMessageId ||
      parent.botId !== task.assignerBotId || !(task.mode === "async" ? ["running", "waiting_tasks", "queued"] : ["running"]).includes(parent.status) || parent.cancelRequestedAt)
      throw new HttpError(409, "The assigning turn is no longer running.");
  } else if (!origin.isGroup) throw new HttpError(403, "The assigning turn is unavailable.");
  if (origin.isGroup) {
    const [member] = await q.select().from(conversationBots).where(and(eq(conversationBots.conversationId, origin.id), eq(conversationBots.botId, task.assignerBotId)));
    if (!member) throw new HttpError(403, "The assigning bot left this group.");
  }
  if (task.parentTaskId) {
    const parent = parentTask;
    if (!parent || parent.childRunId !== task.parentRunId || parent.childConversationId !== origin.id || parent.depth + 1 !== task.depth)
      throw new HttpError(403, "Invalid task ancestry.");
    await assertTaskExecution(parent, q);
  }
  return principal;
}

/** The user advisory lock serializes duplicate calls, root budgets and conversation deletion. */
export async function admitDelegation(ctx: AgentCtx, receiverId: string, prompt: string, toolCallId: string, holder: string, mode: "sync" | "async" = "sync", authorizationMode: "manual" | "coordinator" = "manual", continuedFromTaskId?: string) {
  if (!ctx.bot || !ctx.usage?.messageId || !toolCallId || prompt.length > 200_000) throw new HttpError(400, "Invalid delegated task.");
  if (mode === "async" && (!ctx.awaitTask || !ctx.usage.runId || ctx.inGroup || ctx.app.provider === "hermes"))
    throw new HttpError(400, "Asynchronous delegation requires a durable native turn.");
  if (continuedFromTaskId !== undefined && (!continuedFromTaskId || mode !== "async"))
    throw new HttpError(400, "Task follow-ups require an explicit task ID and durable native execution.");
  const source = ctx.bot.id, userId = ctx.principal.user.id, messageId = ctx.usage.messageId;
  if (authorizationMode !== "manual" && (authorizationMode !== "coordinator" || ctx.depth !== 0)) throw new HttpError(403, "Invalid delegation authority.");
  const inputHash = sha256Hex(JSON.stringify({ source, receiverId, prompt, ...(mode === "async" ? { mode } : {}), ...(authorizationMode === "coordinator" ? { authorizationMode } : {}), ...(continuedFromTaskId ? { continuedFromTaskId } : {}) }));
  return db.transaction(async tx => {
    await lockUserRuns(tx, userId);
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("share");
    if (!user || user.disabled || user.sessionVersion !== ctx.principal.user.sessionVersion) throw new HttpError(403, "The account or session changed.");
    const [existing] = await tx.select().from(delegatedTasks).where(and(eq(delegatedTasks.userId, userId), eq(delegatedTasks.originMessageId, messageId), eq(delegatedTasks.originToolCallId, toolCallId)));
    if (existing) {
      if (existing.inputHash !== inputHash || existing.originConversationId !== ctx.conversationId) throw new HttpError(409, "This delegation call already has a different assignment.");
      await assertTaskExecution(existing, tx);
      return { task: existing, created: false };
    }
    const path = ctx.delegationPath ?? [];
    checkAncestry(path, source, receiverId, ctx.depth);
    const ancestry = [...path, { from: source, to: receiverId, ...(authorizationMode === "coordinator" ? { mode: authorizationMode } : {}) }];
    const [parentTaskRow] = ctx.taskId ? await tx.select().from(delegatedTasks).where(and(eq(delegatedTasks.id, ctx.taskId), eq(delegatedTasks.userId, userId))) : [];
    const rootSource = await resolveAdmissionSource(ctx, parentTaskRow, toolCallId, inputHash, tx);
    const principal = await authorizePath(userId, user.sessionVersion, ancestry, rootSource, tx, mode === "async" || parentTaskRow?.mode === "async");
    const receiver = await getUsableBot(principal, receiverId, tx);
    const [app] = receiver.appId ? await tx.select().from(aiApps).where(eq(aiApps.id, receiver.appId)) : [];
    if (!app?.enabled) throw new HttpError(403, "The receiving bot has no enabled connection.");
    if (isManagedHermes(app)) throw new HttpError(403, "Automatic Hermes profiles support direct bot chats only.");
    const [origin] = await tx.select().from(conversations).where(and(eq(conversations.id, ctx.conversationId), eq(conversations.userId, userId))).for("share");
    if (!origin) throw new HttpError(404, "Origin conversation not found.");
    let parentTask: DelegatedTask | undefined;
    if (ctx.taskId) {
      parentTask = parentTaskRow;
      if (!parentTask || parentTask.childConversationId !== origin.id || parentTask.childRunId !== ctx.usage!.runId || parentTask.receiverBotId !== source ||
        parentTask.depth !== ctx.depth || JSON.stringify(parentTask.ancestry) !== JSON.stringify(path)) throw new HttpError(403, "Invalid task ancestry.");
      await assertTaskExecution(parentTask, tx);
    } else if (ctx.depth || origin.source === "delegation") throw new HttpError(403, "A delegated task requires its original execution context.");
    if (ctx.usage!.runId) {
      const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, ctx.usage!.runId)).for("update");
      if (!run || run.userId !== userId || run.conversationId !== origin.id || run.messageId !== messageId || run.botId !== source ||
        run.status !== "running" || run.cancelRequestedAt || run.holder !== ctx.execution?.holder) throw new HttpError(409, "The assigning turn is no longer running.");
      if (mode === "async" && (run.executionMode === "inline_delegate" || run.segment !== (ctx.execution?.segment ?? 0)))
        throw new HttpError(409, "Asynchronous delegation requires the current durable parent segment.");
    } else {
      const [member] = await tx.select().from(conversationBots).where(and(eq(conversationBots.conversationId, origin.id), eq(conversationBots.botId, source)));
      if (!origin.isGroup || !ctx.inGroup || !member) throw new HttpError(403, "Only a live group turn can delegate without a parent run.");
    }
    const rootMessageId = parentTask?.rootMessageId ?? messageId;
    const rootTasks = await tx.select({ id: delegatedTasks.id, status: agentRuns.status }).from(delegatedTasks)
      .leftJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
      .where(and(eq(delegatedTasks.userId, userId), eq(delegatedTasks.rootMessageId, rootMessageId)));
    if (rootTasks.length >= MAX_ROOT_TASKS || (mode === "sync" && rootTasks.filter(t => t.status === "running").length >= MAX_ROOT_ACTIVE_TASKS))
      throw new HttpError(429, "This turn reached its delegated task budget.");
    if (mode === "async") {
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(agentRuns)
        .where(and(eq(agentRuns.userId, userId), eq(agentRuns.executionMode, "async_delegate"), inArray(agentRuns.status, ["queued", "running", "waiting", "waiting_tasks"])));
      if (count >= MAX_USER_OPEN_ASYNC_TASKS) throw new HttpError(429, "You have too many asynchronous tasks in progress.");
      const [previous] = await tx.select({ id: delegatedTasks.id }).from(delegatedTasks)
        .where(and(eq(delegatedTasks.userId, userId), eq(delegatedTasks.rootMessageId, rootMessageId), eq(delegatedTasks.inputHash, inputHash), eq(delegatedTasks.mode, "async")));
      if (previous) throw new HttpError(409, "This assignment was already started in this turn. Request another attempt in a new user message; earlier actions may have run.");
    }
    const deadlineAt = new Date(Math.min(ctx.execution?.deadlineAt ?? Date.now() + runConfig().runTimeoutMs, parentTask?.deadlineAt.getTime() ?? Infinity));
    if (deadlineAt.getTime() <= Date.now()) throw new HttpError(409, "The assigning turn deadline expired.");
    const id = newId(), runId = newId(), promptId = newId();
    let conversationId = newId(), turn = 1;
    if (continuedFromTaskId) {
      // An old invocation selects history only. Its expired deadline/completed parent must not
      // become the new invocation's authority, and a task ID alone never grants access.
      const [previous] = await tx.select().from(delegatedTasks).where(and(eq(delegatedTasks.id, continuedFromTaskId), eq(delegatedTasks.userId, userId)));
      if (!previous?.childConversationId || !previous.childRunId || previous.originConversationId !== origin.id ||
          previous.assignerBotId !== source || previous.receiverBotId !== receiverId || canonicalJson(previous.ancestry) !== canonicalJson(ancestry))
        throw new HttpError(404, "Related task not found in this chat for this specialist.");
      const previousSource = await resolveTaskSource(previous, tx);
      if (previousSource.conversationId !== rootSource.conversationId || previousSource.botId !== rootSource.botId)
        throw new HttpError(403, "This task belongs to a different originating request.");
      const [child] = await tx.select().from(conversations).where(and(eq(conversations.id, previous.childConversationId), eq(conversations.userId, userId))).for("update");
      const [previousRun] = await tx.select().from(agentRuns).where(eq(agentRuns.id, previous.childRunId));
      if (!child || child.source !== "delegation" || child.isGroup || child.isBotHome || child.archived || child.botId !== receiverId ||
          !previousRun || previousRun.userId !== userId || previousRun.conversationId !== child.id || previousRun.botId !== receiverId || previousRun.appId !== app.id)
        throw new HttpError(403, "This task's history or connection is no longer available for continuation.");
      const [latest] = await tx.select({ turn: delegatedTasks.turn }).from(delegatedTasks)
        .where(and(eq(delegatedTasks.childConversationId, child.id), eq(delegatedTasks.userId, userId))).orderBy(desc(delegatedTasks.turn)).limit(1);
      conversationId = child.id; turn = latest.turn + 1;
      // Different historical task IDs can identify the same child. Keep the exact reference
      // in call idempotency, but deduplicate instructions against the resolved conversation.
      const [duplicate] = await tx.select({ id: delegatedTasks.id }).from(delegatedTasks)
        .innerJoin(agentRuns, eq(agentRuns.id, delegatedTasks.childRunId))
        .innerJoin(messages, and(eq(messages.id, agentRuns.parentMessageId), eq(messages.conversationId, child.id)))
        .where(and(eq(delegatedTasks.userId, userId), eq(delegatedTasks.rootMessageId, rootMessageId),
          eq(delegatedTasks.childConversationId, child.id), eq(delegatedTasks.assignerBotId, source), eq(delegatedTasks.receiverBotId, receiverId),
          sql`${messages.parts} = ${JSON.stringify([{ type: "text", text: prompt }])}::jsonb`)).limit(1);
      if (duplicate) throw new HttpError(409, "This assignment was already started in this turn. Request another attempt in a new user message; earlier actions may have run.");
      await tx.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, child.id));
    } else {
      await tx.insert(conversations).values({ id: conversationId, userId, botId: receiverId, source: "delegation", title: prompt.trim().replace(/\s+/g, " ").slice(0, 100) || "Delegated task" });
    }
    await insertMessage(conversationId, { id: promptId, role: "user", parts: [{ type: "text", text: prompt }], metadata: { assignment: { botId: source, name: ctx.bot!.name } } }, null, {}, tx);
    // Queued follow-ups attach to committed history on their first claim; admission must not
    // displace a running predecessor's leaf or insert a future prompt into its model context.
    if (!continuedFromTaskId) await setCurrentLeaf(conversationId, promptId, {}, tx);
    const hermes = app.provider === "hermes" ? await snapshotHermesSettings(tx, app, conversationId) : null;
    await tx.insert(agentRuns).values({ id: runId, userId, conversationId, messageId: newId(), parentMessageId: promptId, botId: receiverId, appId: app.id,
      ...(mode === "async" ? { background: true, executionMode: "async_delegate" as const, status: "queued" as const }
        : { background: ctx.background, executionMode: "inline_delegate" as const, status: "running" as const, holder, heartbeatAt: sql`now()`, startedAt: sql`now()` }) });
    if (hermes) await tx.insert(hermesRunContexts).values({ runId, ...hermes });
    const [task] = await tx.insert(delegatedTasks).values({ id, userId, originConversationId: origin.id, originMessageId: messageId, originToolCallId: toolCallId,
      parentRunId: ctx.usage!.runId ?? null, parentTaskId: parentTask?.id ?? null, rootTaskId: parentTask?.rootTaskId ?? id, rootMessageId,
      assignerBotId: source, receiverBotId: receiverId, assignerName: ctx.bot!.name, receiverName: receiver.name,
      childConversationId: conversationId, childRunId: runId, turn, continuedFromTaskId, inputHash, mode, parentSegment: ctx.execution?.segment ?? 0, ancestry, depth: ctx.depth + 1, sessionVersion: user.sessionVersion, deadlineAt }).returning();
    return { task, created: true };
  });
}
