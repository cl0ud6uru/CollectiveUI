import { tool } from "ai";
import { z } from "zod";
import type { Principal } from "@/lib/auth/groups";
import { adminGetBot, adminListBots, adminListConnections, adminListUsers } from "@/lib/admin/inventory";
import { secretSafe } from "@/lib/admin/secret-safe";
import type { AgentCtx, ToolEntry } from "../types";
import { changeBotStatus } from "@/lib/admin/bot-status";
import { authorizeArchitectCall, lockArchitectActor, runArchitectCall } from "./admin-guard";

/** The Architect's tool group key (never stored in bot_tools: the tools follow the installation receipt). */
export const ADMIN_TOOL_KEY = "admin";

const search = z.object({
  query: z.string().trim().max(200).optional().describe("Filter by name (case-insensitive substring)"),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum rows (default 100)"),
});
const none = z.object({}).strict();
const window = z.object({
  hours: z.number().int().min(1).max(336).optional().describe("How far back to look, in hours (default 24)"),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum rows per section (default 50)"),
});
const period = z.object({ days: z.number().int().min(1).max(365).optional().describe("Usage period in days (default 30)") });
/** Loaded on first use: these read server-only services (sandboxd, billing, job queue). */
const ops = () => import("@/lib/admin/operations");

/**
 * Admin tools for The Architect. Writes always require per-call approval. Each call is re-authorized and audited (runArchitectCall) and its result
 * passes through secretSafe, which refuses credential fields and redacts token-shaped text.
 */
export function adminTools(ctx: AgentCtx): ToolEntry[] {
  /** The execute function for one admin tool: authorize, read, make secret-safe, audit. */
  const guarded = <I>(name: string, read: (p: Principal, input: I, signal?: AbortSignal) => Promise<unknown>) =>
    (input: I, { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal }) => runArchitectCall(ctx, name, toolCallId, async (p) => secretSafe(await read(p, input, abortSignal)), abortSignal);
  const entry = (name: string, t: ToolEntry["tool"]): ToolEntry => ({ name, key: ADMIN_TOOL_KEY, tool: t });

  return [
    { name: "admin_set_bot_enabled", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Enable or disable one ordinary bot. Always requires approval for this exact call. First read its current revision with admin_get_bot. Team bots must be managed in Admin. Returns verified saved state; failure means no success was verified.",
      inputSchema: z.object({ botId: z.string().min(1).max(128), enabled: z.boolean(), expectedRevision: z.number().int().min(1) }).strict(),
      execute: guarded("admin_set_bot_enabled", (p, i: { botId: string; enabled: boolean; expectedRevision: number }, signal) => changeBotStatus(p, i, {
        via: { agent: "architect", botId: ctx.bot!.id }, signal,
        beforeWrite: async tx => { await lockArchitectActor(ctx, tx); await authorizeArchitectCall(ctx, tx); },
      })),
    }) },
    entry("admin_list_bots", tool({
      description: "List bots: owner, model, visibility, tool groups, routines, and whether each is built in (The Architect, Office Bot) or the default coordinator.",
      inputSchema: search,
      execute: guarded("admin_list_bots", (p, i: z.output<typeof search>) => adminListBots(p, i)),
    })),
    entry("admin_get_bot", tool({
      description: "One bot's full configuration: instructions, tools and approval modes, delegates, audience, MCP grants and routines.",
      inputSchema: z.object({ botId: z.string().min(1).max(128) }),
      execute: guarded("admin_get_bot", (p, i: { botId: string }) => adminGetBot(p, i.botId)),
    })),
    entry("admin_list_connections", tool({
      description: "Models, saved provider connections and MCP servers with status and error-presence flags. Credentials appear only as hasKey/hasHeaders flags.",
      inputSchema: none,
      execute: guarded("admin_list_connections", (p) => adminListConnections(p)),
    })),
    entry("admin_list_users", tool({
      description: "Users (sign-in source, effective admin, groups, last login) and portal groups with their permissions.",
      inputSchema: search,
      execute: guarded("admin_list_users", (p, i: z.output<typeof search>) => adminListUsers(p, i)),
    })),
    entry("admin_status", tool({
      description: "Overview: version, usage over a period, counts of users, bots, models, MCP servers and active runs, and which features are on.",
      inputSchema: period,
      execute: guarded("admin_status", async (p, i: z.output<typeof period>) => (await ops()).adminStatus(p, i)),
    })),
    entry("admin_health", tool({
      description: "Health checks: database, background worker, job queues, workspaces (sandboxd), personal and local Hermes, MCP servers and spending accounts. Each check says what was verified.",
      inputSchema: none,
      execute: guarded("admin_health", async (p) => (await ops()).adminHealth(p)),
    })),
    entry("admin_recent_errors", tool({
      description: "Recent failures: failed or interrupted runs, failed routine runs, tool error counts, and MCP, spending and Hermes provisioning errors.",
      inputSchema: window,
      execute: guarded("admin_recent_errors", async (p, i: z.output<typeof window>) => (await ops()).adminRecentErrors(p, i)),
    })),
    entry("admin_runs", tool({
      description: "Agent runs: counts by status over a window, and the currently queued, running or waiting runs with heartbeats.",
      inputSchema: window,
      execute: guarded("admin_runs", async (p, i: z.output<typeof window>) => (await ops()).adminRuns(p, i)),
    })),
    entry("admin_jobs", tool({
      description: "Background job queues: ready, deferred, active and recently failed job counts per queue.",
      inputSchema: none,
      execute: guarded("admin_jobs", async (p) => (await ops()).adminJobs(p)),
    })),
    entry("admin_spending", tool({
      description: "Provider spending accounts (last snapshot and refresh status) and token usage by model or bot over a period.",
      inputSchema: period,
      execute: guarded("admin_spending", async (p, i: z.output<typeof period>) => (await ops()).adminSpending(p, i)),
    })),
    entry("admin_workspaces_status", tool({
      description: "Workspaces: policy, sandboxd setup checks, and each person's workspace state, runtime and activity.",
      inputSchema: none,
      execute: guarded("admin_workspaces_status", async (p) => (await ops()).adminWorkspacesStatus(p)),
    })),
  ];
}
