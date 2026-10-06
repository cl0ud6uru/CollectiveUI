import { and, eq, inArray } from "drizzle-orm";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { aiApps, botTools, groups, mcpServers, toolGrants, type Bot, type McpServer, type Skill } from "@/db/schema";
import { HttpError, listAccessibleMcpServers } from "@/lib/authz";
import type { McpCaller } from "@/lib/mcp/client";
import type { IdentitySubject } from "@/lib/mcp/identity";
import { userFacingMessage } from "@/lib/llm";
import { isAgentServer } from "@/lib/llm/catalog";
import { sandboxd } from "@/lib/sandbox/client";
import { isHardDenied, requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { PortalWorkspace } from "@/lib/sandbox/session";
import { getOrCreateRef, touchSandbox } from "@/lib/sandbox/store";
import { getSetting, type SandboxSettings } from "@/lib/settings";
import { slugify } from "@/lib/utils";
import { activeServiceGrants } from "@/lib/bots/service";
import { ENFORCED_APPROVAL_REASON } from "@/lib/bots/service-policy";
import { assertDirectServiceContext, mcpAuthorityBinding } from "@/lib/mcp/authorization";
import { sha256Hex } from "@/lib/crypto";
import { resolveApproval } from "./approvals";
import { memoryEnabled } from "./memory";
import { knowledgeTool } from "./tools/knowledge";
import { m365Tools } from "./tools/m365";
import { connectedMcpTools, mcpTools, modelToolName } from "./tools/mcp";
import { memoryTools } from "./tools/memory";
import { skillsForBot, skillTool } from "./tools/skills";
import { nativeSearchFor } from "./native-search";
import { webTools } from "./tools/web";
import { workspaceTools } from "./tools/workspace";
import type { AgentCtx, ToolEntry } from "./types";

import { MAX_DELEGATION_DEPTH } from "@/lib/delegation/policy";
import { assertDelegationPath, delegatedAuthorityBinding, discoverDelegates, type DelegationMode } from "@/lib/coordinator/delegation";
export { MAX_DELEGATION_DEPTH };

export type Toolset = {
  nativeSearch?: import("@/lib/llm/native-search").NativeSearchOptions;
  tools: ToolSet;
  entries: ToolEntry[];
  skills: Skill[];
  delegates: Bot[];
  approval: (opts: { toolCall: { toolName: string; input?: unknown } }) => ReturnType<typeof resolveApproval> | { type: "denied" | "user-approval"; reason: string };
  approvalBinding?: string;
  close: () => Promise<void>;
  warnings: string[];
  /** The person's workspace, when this bot has workspace tools (its description goes into the instructions). */
  workspace: PortalWorkspace | null;
  /** Per-tool timeouts for streamText (`{toolName}Ms`). */
  timeout?: { tools: Record<string, number> };
};

const EMPTY: Toolset = {
  tools: {},
  entries: [],
  skills: [],
  delegates: [],
  approval: () => undefined,
  close: async () => {},
  warnings: [],
  workspace: null,
};

/**
 * The acting person's workspace for this turn: one handle, created by the first toolset that needs it and shared
 * with delegates through ctx (only the creator closes it). Null, with a warning, when the person may not use one.
 */
async function workspaceFor(ctx: AgentCtx, settings: SandboxSettings, warnings: string[], closers: (() => Promise<void>)[]) {
  if (!userMayUseWorkspace(ctx.principal, settings)) {
    warnings.push("Workspace tools aren't enabled for you, so this bot can't run commands or edit files.");
    return null;
  }
  const client = sandboxd();
  if (!client) {
    warnings.push("Workspaces aren't set up on this server.");
    return null;
  }
  if (ctx.workspace) return ctx.workspace;
  const userId = ctx.principal.user.id;
  let lastTouch = 0;
  const ws = new PortalWorkspace({
    client,
    ref: () => getOrCreateRef(userId),
    isolation: requiredIsolation(settings),
    onUse: () => {
      if (Date.now() - lastTouch < 60_000) return;
      lastTouch = Date.now();
      void touchSandbox(userId).catch(() => {});
    },
  });
  ctx.workspace = ws;
  closers.push(() => ws.close());
  return ws;
}

export async function buildToolset(ctx: AgentCtx): Promise<Toolset> {
  const bot = ctx.bot;
  if (!bot) return { ...EMPTY, ...await nativeSearchFor(ctx) };
  await assertDirectServiceContext(ctx);
  // Agent servers (Hermes) bring their own tools, memory and skills; portal tools don't apply.
  if (isAgentServer(ctx.app.provider)) return EMPTY;
  if (!ctx.app.supportsTools) return { ...EMPTY, warnings: ["This bot's model endpoint does not support tools."] };

  const delegatedBinding = ctx.delegationPath?.some(edge => edge.mode === "coordinator") ? await delegatedAuthorityBinding(ctx, true) : null;

  const disabled = new Set(ctx.toolSettings.disabledTools);
  const configured = (await db.select().from(botTools).where(eq(botTools.botId, bot.id))).filter(
    (t) => !disabled.has(t.toolKey) && !(t.toolKey.startsWith("mcp:") && disabled.has("mcp")),
  );
  const hosted = await nativeSearchFor(ctx, configured);
  const modes = new Map(configured.map((t) => [t.toolKey, t.approval]));
  const entries: ToolEntry[] = [];
  const closers: (() => Promise<void>)[] = [];
  const warnings: string[] = [...hosted.warnings];
  let skills: Skill[] = [];
  const mcpServerIds: string[] = [];
  let workspace: PortalWorkspace | null = null;
  const timeouts: Record<string, number> = {};
  const bindings: string[] = [];

  const web = webTools(ctx);
  for (const t of configured) {
    try {
      switch (t.toolKey) {
        case "web_search":
          entries.push(web.web_search);
          break;
        case "fetch_url":
          entries.push(web.fetch_url);
          break;
        case "knowledge": {
          const k = knowledgeTool(ctx);
          if (k) entries.push(k);
          break;
        }
        case "memory":
          if (await memoryEnabled(ctx.principal.user.id)) entries.push(...memoryTools(ctx));
          break;
        case "skills": {
          skills = await skillsForBot(bot.id, bot.ownerId);
          const s = skillTool(ctx, skills);
          if (s) entries.push(s);
          break;
        }
        case "m365":
          entries.push(...m365Tools(ctx));
          break;
        case "workspace": {
          const settings = await getSetting("sandbox");
          workspace = await workspaceFor(ctx, settings, warnings, closers);
          if (workspace) {
            entries.push(...workspaceTools(workspace, settings));
            // The command's own limit ends it first; this only catches a lost stream.
            timeouts.workspace_bashMs = (settings.commandTimeoutSec + 30) * 1000;
          }
          break;
        }
        default:
          if (t.toolKey.startsWith("mcp:")) mcpServerIds.push(t.toolKey.slice(4));
      }
    } catch (err) {
      console.error(`[agent] failed to load tool ${t.toolKey}`, err);
      warnings.push(`Tool "${t.toolKey}" is unavailable right now.`);
    }
  }

  // MCP servers: one access check for all of them. Servers with an accepted tool snapshot connect lazily, on
  // their first tool call; older ones without a snapshot yet connect now, in parallel, so one slow server doesn't
  // hold up the others. A failing server only removes its own tools.
  if (mcpServerIds.length) {
    const serviceGrants = bot.executionMode === "service" ? await activeServiceGrants(bot.id) : [];
    const accessible = new Map((bot.executionMode === "service"
      ? await db.select().from(mcpServers).where(inArray(mcpServers.id, mcpServerIds))
      : await listAccessibleMcpServers(ctx.principal)).map((s) => [s.id, s]));
    const servers = mcpServerIds
      .flatMap((id) => {
        const server = accessible.get(id);
        if (!server) warnings.push("One of this bot's MCP servers isn't available to you, so its tools are missing.");
        return server ? [server] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id)); // stable tool names when two servers share a name
    const caller: McpCaller = { subject: await identitySubject(ctx, servers), botId: bot.id, conversationId: ctx.conversationId };
    const taken = new Set<string>();
    const configs = new Map(configured.map((t) => [t.toolKey, t.config ?? null]));
    const opts = async (s: McpServer) => {
      const config = configs.get(`mcp:${s.id}`) ?? null;
      const grants = serviceGrants.filter((g) => g.serverId === s.id);
      if (bot.executionMode === "service" && (!s.toolsSnapshot || !["enabled", "needs_review"].includes(s.status) || !grants.length))
        throw new HttpError(403, "A service-bot connector grant is unavailable. Ask an admin to review and publish it.");
      const binding = await mcpAuthorityBinding(ctx, s, config, grants, s.identityHeader && caller.subject.kind === "user" ? caller.subject.groups : []);
      bindings.push(binding);
      return { caller, config, taken: new Set<string>(), authority: { ctx, binding, grants } };
    };
    const results = await Promise.allSettled(servers.map(async (s) => (s.toolsSnapshot ? mcpTools(s, await opts(s)) : connectedMcpTools(s, await opts(s)))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        for (const entry of r.value.entries) {
          if (entry.mcp) entry.name = modelToolName(servers[i], entry.mcp.tool, taken);
          entries.push(entry);
        }
        closers.push(r.value.close);
      } else {
        if (bot.executionMode === "service") throw r.reason;
        console.error(`[agent] failed to connect MCP server ${servers[i].name}`, r.reason);
        warnings.push(`"${servers[i].name}" is unavailable right now.`);
      }
    });
  }

  // Specialist bots this bot can delegate to (chief-of-staff pattern).
  const choices = await discoverDelegates(ctx);
  const delegates = choices.map(choice => choice.bot);
  for (const choice of choices) {
    const [receiverApp] = ctx.awaitTask ? await db.select().from(aiApps).where(eq(aiApps.id, choice.bot.appId!)) : [];
    const receiverTools = ctx.awaitTask && receiverApp?.provider !== "hermes" ? await db.select().from(botTools).where(eq(botTools.botId, choice.bot.id)) : [];
    const durableWorkspace = !!ctx.awaitTask && !ctx.inGroup && receiverTools.some(t => t.toolKey === "workspace");
    entries.push(delegateEntry(ctx, choice.bot, choice.mode, durableWorkspace));
    if (ctx.awaitTask && ctx.usage?.runId && !ctx.inGroup)
      entries.push(continueDelegateEntry(ctx, choice.bot, choice.mode));
  }
  if (delegatedBinding) for (const entry of entries) {
    const execute = entry.tool.execute;
    if (!execute) continue;
    entry.tool.execute = async function* (input, options) {
      await assertDelegationPath(ctx);
      if (delegatedBinding !== await delegatedAuthorityBinding(ctx)) throw new HttpError(403, "Tool permissions changed. Start a new request to review the current permissions.");
      const result = execute(input, options);
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        for await (const value of result as AsyncIterable<unknown>) yield value;
      } else yield await result;
    };
  }

  const grants = new Set(
    (
      await db
        .select({ toolName: toolGrants.toolName })
        .from(toolGrants)
        .where(and(eq(toolGrants.userId, ctx.principal.user.id), eq(toolGrants.botId, bot.id)))
    ).map((g) => g.toolName),
  );
  const byName = new Map(entries.map((e) => [e.name, e]));

  const approval: Toolset["approval"] = ({ toolCall }) => {
    const entry = byName.get(toolCall.toolName);
    if (!entry) return undefined;
    try { entry.validateInput?.(toolCall.input); }
    catch (err) { return { type: "denied", reason: err instanceof Error ? err.message : "Tool scope denied." }; }
    if (entry.name === "workspace_bash") {
      // Refused outright (no Run card), and checked again on every continuation.
      const blocked = isHardDenied(String((toolCall.input as { command?: unknown } | undefined)?.command ?? ""));
      if (blocked) return { type: "denied", reason: blocked };
    }
    const decision = resolveApproval({
      toolName: entry.name,
      toolKey: entry.key,
      mode: modes.get(entry.key) ?? "auto",
      sensitive: !!entry.sensitive,
      enforced: ctx.toolSettings.enforcedApproval,
      grants,
      mcp: entry.mcp,
      grantable: entry.grantable,
    });
    // Only a durable native workspace child can pause for its owning human. Inline/group/other tools keep denying.
    if (decision === "user-approval" && (ctx.inGroup || (ctx.depth > 0 && !(ctx.relayWorkspaceApproval && entry.key === "workspace")))) {
      return {
        type: "denied",
        reason: `${entry.name} needs the user's approval, which isn't possible here. Ask the user to open a direct chat with ${bot.name} to do this.`,
      };
    }
    if (decision === "user-approval" && (entry.mcp?.requireApproval ||
        ctx.toolSettings.enforcedApproval.includes(entry.name) || ctx.toolSettings.enforcedApproval.includes(entry.key)))
      return { type: "user-approval", reason: ENFORCED_APPROVAL_REASON };
    return decision;
  };

  return {
    nativeSearch: hosted.nativeSearch,
    tools: { ...Object.fromEntries(entries.map((e) => [e.name, e.tool])), ...hosted.tools },
    entries,
    skills,
    delegates,
    approval,
    ...(bindings.length ? { approvalBinding: sha256Hex(JSON.stringify({ authorities: bindings.sort(), mapping: entries.filter(e => e.mcp).map(e => ({ name: e.name, server: e.key, tool: e.mcp!.tool, definition: e.mcp!.definitionHash })) })) } : {}),
    warnings,
    workspace,
    ...(Object.keys(timeouts).length ? { timeout: { tools: timeouts } } : {}),
    close: async () => {
      await Promise.allSettled(closers.map((c) => c()));
    },
  };
}

/** Who is calling, for servers that receive the signed identity (group names are only looked up when one does). */
async function identitySubject(ctx: AgentCtx, servers: McpServer[]): Promise<IdentitySubject> {
  const u = ctx.principal.user;
  const wantsGroups = servers.some((s) => s.identityHeader) && ctx.principal.groupIds.length > 0;
  const names = wantsGroups
    ? (await db.select({ name: groups.name }).from(groups).where(inArray(groups.id, ctx.principal.groupIds))).map((g) => g.name).sort()
    : [];
  return { kind: "user", id: u.id, upn: u.upn, email: u.email, name: u.name, groups: names };
}

function delegateEntry(ctx: AgentCtx, delegate: Bot, authorizationMode: DelegationMode, durableWorkspace = false): ToolEntry {
  const name = `ask_${slugify(delegate.name).replace(/-/g, "_") || delegate.id}`.slice(0, 50) + `_${delegate.id.slice(-10)}`;
  return {
    name,
    key: `delegate:${delegate.id}`,
    tool: tool({
      description: `Start a NEW task with the specialist bot "${delegate.name}". Its job: ${delegate.description ?? "n/a"}. Give it a complete, self-contained task description. For a related follow-up, use this specialist's continue_* tool with the taskId from its earlier result when offered. New or unrelated work must use this ask_* tool. ${durableWorkspace ? "This workspace specialist runs durably so its actions can pause for the human owner's approval. Both mode values schedule independent work and return a queued receipt; this reply resumes after the result arrives. Never approve on behalf of the human or repeat an accepted assignment." : ctx.awaitTask ? "Choose sync to ask and wait in this turn, or async to schedule durable independent work. Async results resume this reply automatically; do not start the same task twice. You may start several different async tasks in one model step." : "This context supports synchronous delegation only."}`,
      inputSchema: z.object({ task: z.string().min(1).max(200_000).describe("Self-contained task for the specialist"), mode: z.enum(ctx.awaitTask ? ["sync", "async"] : ["sync"]).default("sync") }),
      async *execute({ task, mode }, { abortSignal, toolCallId }) {
        try {
          if (mode === "async" || durableWorkspace) {
            abortSignal?.throwIfAborted();
            const { startAsyncDelegation } = await import("@/lib/delegation/async");
            yield await startAsyncDelegation(ctx, delegate.id, task, `${ctx.toolCallPrefix ?? ""}${toolCallId}`, authorizationMode);
            return;
          }
          const { runDelegation } = await import("@/lib/delegation/execute");
          yield* runDelegation(ctx, delegate.id, task, `${ctx.toolCallPrefix ?? ""}${toolCallId}`, abortSignal, authorizationMode);
        } catch (e) {
          yield { bot: delegate.name, botId: delegate.id, avatar: delegate.avatar, label: delegate.label, status: "error", steps: [], error: e instanceof HttpError ? e.message : userFacingMessage(e) ?? "The delegated task could not finish." };
        }
      },
    }),
  };
}

function continueDelegateEntry(ctx: AgentCtx, delegate: Bot, authorizationMode: DelegationMode): ToolEntry {
  return {
    name: `continue_${slugify(delegate.name).replace(/-/g, "_") || delegate.id}`.slice(0, 50) + `_${delegate.id.slice(-10)}`,
    // The target's existing delegation approval policy applies equally to follow-ups.
    key: `delegate:${delegate.id}`,
    tool: tool({
      description: `Continue related work with "${delegate.name}" in its existing task conversation. Use the exact taskId from an earlier assignment to this specialist in this originating chat. Prior context is preserved; busy turns queue in order and the result resumes this reply automatically. Give only the new instruction and necessary updates. Never guess IDs, retry an accepted call, or reuse a task merely because the bot is the same. For unrelated work use ask_*. Supported for native engines only.`,
      inputSchema: z.object({ taskId: z.string().min(1).max(200).describe("Exact taskId returned by an earlier related assignment"), task: z.string().min(1).max(200_000).describe("Related follow-up instruction") }),
      async execute({ taskId, task }, { abortSignal, toolCallId }) {
        try {
          abortSignal?.throwIfAborted();
          const { startAsyncDelegation } = await import("@/lib/delegation/async");
          return await startAsyncDelegation(ctx, delegate.id, task, `${ctx.toolCallPrefix ?? ""}${toolCallId}`, authorizationMode, taskId);
        } catch (e) {
          return { bot: delegate.name, botId: delegate.id, avatar: delegate.avatar, label: delegate.label, status: "error", steps: [], error: e instanceof HttpError ? e.message : userFacingMessage(e) ?? "The related task could not continue." };
        }
      },
    }),
  };
}
