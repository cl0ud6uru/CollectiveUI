import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, attachments, bots, botTools, conversations, inboxItems, messages, routineRuns, routines } from "@/db/schema";
import { sandboxd } from "@/lib/sandbox/client";
import { userMayUseWorkspace } from "@/lib/sandbox/policy";
import { findSandbox } from "@/lib/sandbox/store";
import { getSetting } from "@/lib/settings";
import type { Principal } from "@/lib/auth/groups";

export type BotOutput = { id: string; title: string; href: string; kind: "file"; createdAt: string };

/** User/bot-scoped work and returned files. Ordinary completed replies remain in the transcript. */
export async function loadBotActivity(p: Principal, botId: string) {
  const [bot] = await db.select({ team: bots.hermesTeam }).from(bots).where(eq(bots.id, botId));
  if (bot?.team) return { state: { working: false, awaitingApproval: false }, activity: [], outputs: [] };
  const scope = and(eq(agentRuns.userId, p.user.id), eq(agentRuns.botId, botId), eq(conversations.userId, p.user.id), eq(conversations.botId, botId));
  const open = inArray(agentRuns.status, ["queued", "running", "waiting", "waiting_tasks"]);
  const latestFailure = and(inArray(agentRuns.status, ["failed", "interrupted"]), sql`not exists (
    select 1 from agent_runs newer where newer.conversation_id = ${agentRuns.conversationId}
    and newer.user_id = ${p.user.id} and (newer.created_at, newer.id) > (${agentRuns.createdAt}, ${agentRuns.id})
  )`);
  const completedWork = and(inArray(agentRuns.status, ["succeeded", "cancelled"]), or(eq(agentRuns.background, true), isNotNull(agentRuns.routineRunId), inArray(agentRuns.executionMode, ["inline_delegate", "async_delegate"])));
  const activityQuery = db.select({
    id: agentRuns.id, conversationId: agentRuns.conversationId, status: agentRuns.status,
    title: conversations.title, prompt: messages.searchText, updatedAt: agentRuns.updatedAt,
    executionMode: agentRuns.executionMode, routineRunId: agentRuns.routineRunId, background: agentRuns.background, routineName: routines.name,
    unread: sql<boolean>`exists (select 1 from ${inboxItems} where ${inboxItems.userId} = ${p.user.id} and ${inboxItems.readAt} is null and ${inboxItems.conversationId} = ${agentRuns.conversationId} and ((${inboxItems.routineRunId} is null and ${agentRuns.status} = 'waiting') or ${inboxItems.routineRunId} = ${agentRuns.routineRunId}))`,
  }).from(agentRuns)
    .innerJoin(conversations, eq(conversations.id, agentRuns.conversationId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.parentMessageId), eq(messages.conversationId, agentRuns.conversationId)))
    .leftJoin(routineRuns, eq(routineRuns.id, agentRuns.routineRunId))
    .leftJoin(routines, and(eq(routines.id, routineRuns.routineId), eq(routines.ownerId, p.user.id), eq(routines.botId, botId)))
    .where(and(scope, or(open, latestFailure, completedWork)))
    .orderBy(sql`case when ${agentRuns.status} = 'waiting' then 0 when ${agentRuns.status} in ('queued', 'running') then 1 when ${agentRuns.status} in ('failed', 'interrupted') then 2 else 3 end`, desc(agentRuns.updatedAt), desc(agentRuns.id)).limit(10);

  // Status does not depend on the panel's page size or displayed rows.
  const stateQuery = db.select({
    working: sql<boolean>`coalesce(bool_or(${agentRuns.status} in ('queued', 'running', 'waiting_tasks')), false)`,
    awaitingApproval: sql<boolean>`coalesce(bool_or(${agentRuns.status} = 'waiting'), false)`,
  }).from(agentRuns).innerJoin(conversations, eq(conversations.id, agentRuns.conversationId)).where(and(scope, open));

  // Join owned files before limiting, so newer text replies cannot displace older file results.
  // Exclude prompt uploads even when echoed by the assistant. There is no general artifact registry.
  const filesQuery = db.select({ id: attachments.id, title: attachments.filename, createdAt: sql<string>`max(${messages.createdAt})::text` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(agentRuns, eq(agentRuns.messageId, messages.id))
    .innerJoin(attachments, and(eq(attachments.userId, p.user.id), sql`${messages.parts} @> jsonb_build_array(jsonb_build_object('type', 'file', 'url', '/api/files/' || ${attachments.id}))`))
    .where(and(eq(conversations.userId, p.user.id), eq(conversations.botId, botId), eq(messages.role, "assistant"),
      or(isNull(agentRuns.id), and(eq(agentRuns.userId, p.user.id), eq(agentRuns.botId, botId), eq(agentRuns.status, "succeeded"))),
      sql`not exists (select 1 from messages input_message join conversations input_chat on input_chat.id = input_message.conversation_id
        where input_chat.user_id = ${p.user.id} and input_message.role = 'user'
        and input_message.parts @> jsonb_build_array(jsonb_build_object('type', 'file', 'url', '/api/files/' || ${attachments.id})))`))
    .groupBy(attachments.id, attachments.filename)
    .orderBy(desc(sql`max(${messages.createdAt})`), desc(attachments.id)).limit(10);

  const [activityRows, [state], files] = await Promise.all([activityQuery, stateQuery, filesQuery]);
  return {
    state,
    activity: activityRows.map((r) => ({
      id: r.id, conversationId: r.conversationId, status: r.status,
      kind: r.executionMode === "inline_delegate" || r.executionMode === "async_delegate" ? "delegation" as const : r.routineRunId ? "routine" as const : r.background ? "background" as const : "reply" as const,
      title: (r.routineName || (r.background ? r.title : r.prompt?.trim()) || r.title).replace(/\s+/g, " ").slice(0, 100),
      unread: r.unread, updatedAt: r.updatedAt.toISOString(),
    })),
    outputs: files.map((f): BotOutput => ({ ...f, href: `/api/files/${f.id}`, kind: "file", createdAt: new Date(f.createdAt).toISOString() })),
  };
}

export type WorkspacePreview = {
  state: "running" | "stopped" | "missing" | "unavailable";
  /** The latest command this bot ran in the person's workspace, with the tail of its output. */
  command: string | null;
  lines: string[];
  ok: boolean | null;
  at: string | null;
};

/**
 * The bot's "screen" in its panel (Grok Bot shows the bot's computer): only for bots with workspace tools, only the
 * acting person's own workspace and their own chats with this bot. No paths or refs leave the server.
 */
export async function loadWorkspacePreview(p: Principal, botId: string): Promise<WorkspacePreview | null> {
  const [bot] = await db.select({ team: bots.hermesTeam }).from(bots).where(eq(bots.id, botId));
  if (bot?.team) return null;
  const [tool] = await db.select({ key: botTools.toolKey }).from(botTools).where(and(eq(botTools.botId, botId), eq(botTools.toolKey, "workspace"))).limit(1);
  if (!tool) return null;
  const settings = await getSetting("sandbox");
  if (!settings.enabled || !userMayUseWorkspace(p, settings)) return null;
  const [last] = await db
    .select({ parts: messages.parts, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.userId, p.user.id), eq(conversations.botId, botId), eq(messages.role, "assistant"), sql`${messages.parts} @> '[{"type":"tool-workspace_bash"}]'::jsonb`))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const bash = (last?.parts as { type?: string; input?: { command?: string }; output?: { stdout?: string; stderr?: string; ok?: boolean } }[] | undefined)
    ?.filter((x) => x.type === "tool-workspace_bash")
    .at(-1);
  const text = `${bash?.output?.stdout ?? ""}${bash?.output?.stderr ?? ""}`;
  let state: WorkspacePreview["state"] = "missing";
  const client = sandboxd();
  const row = await findSandbox(p.user.id);
  if (!client) state = "unavailable";
  else if (row) state = await client.state(row.ref).then((s) => s.state, () => "unavailable" as const);
  return {
    state,
    command: bash?.input?.command?.slice(0, 300) ?? null,
    lines: text.split("\n").map((l) => l.slice(0, 200)).filter((l) => l.trim()).slice(-8),
    ok: typeof bash?.output?.ok === "boolean" ? bash.output.ok : null,
    at: last?.createdAt.toISOString() ?? null,
  };
}
