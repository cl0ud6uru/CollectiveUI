import { tool } from "ai";
import { z } from "zod";
import type { Principal } from "@/lib/auth/groups";
import { adminGetBot, adminListBots, adminListConnections, adminListUsers } from "@/lib/admin/inventory";
import { secretSafe } from "@/lib/admin/secret-safe";
import type { AgentCtx, ToolEntry } from "../types";
import { changeBotStatus } from "@/lib/admin/bot-status";
import { authorizeArchitectCall, lockArchitectActor, runArchitectCall } from "./admin-guard";
import { architectBotCreateInput, architectBotSkillsInput, architectBotToolsInput, architectBotUpdateInput, assignArchitectBotSkills, assignArchitectBotTools, createArchitectBot, updateArchitectBot } from "@/lib/admin/bot-config";
import { architectProviderConnectionTestInput, architectProviderConnectionUpdateInput, testArchitectProviderConnection, updateArchitectProviderConnection } from "@/lib/admin/architect-connections";
import { architectGroupProfileInput, architectUserDisabledInput, setArchitectUserDisabled, updateArchitectGroupProfile } from "@/lib/admin/architect-people";
import { adminDiagnosticBundle } from "@/lib/admin/architect-diagnostics";
import { adminGetArchitectSettings, architectSettingsUpdateInput, updateArchitectSettings } from "@/lib/admin/architect-settings";

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
const diagnosticWindow = z.object({
  days: z.number().int().min(1).max(30).optional().describe("Usage rollup period in days (default 7)"),
  hours: z.number().int().min(1).max(168).optional().describe("Failure summary period in hours (default 24)"),
}).strict();
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
    { name: "admin_create_bot", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Create an ordinary private caller bot with an enabled shared tool-capable model. Always requires exact approval. It starts with no tools; assign built-in groups separately. Returns verified saved state.",
      inputSchema: architectBotCreateInput,
      execute: guarded("admin_create_bot", (p, i: z.output<typeof architectBotCreateInput>, signal) => createArchitectBot(ctx, p, i, signal)),
    }) },
    { name: "admin_update_bot", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Update basic configuration of an ordinary caller bot. Read admin_get_bot first and pass its exact revision. Always requires approval for this exact change; returns verified saved state.",
      inputSchema: architectBotUpdateInput,
      execute: guarded("admin_update_bot", (p, i: z.output<typeof architectBotUpdateInput>, signal) => updateArchitectBot(ctx, p, i, signal)),
    }) },
    { name: "admin_assign_bot_tools", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Replace an ordinary caller bot's built-in tool-group assignments, including Skills. Read admin_get_bot first and pass its exact revision. Each selected group and approval mode requires approval; MCP assignments are preserved and cannot be edited here. Returns verified saved state.",
      inputSchema: architectBotToolsInput,
      execute: guarded("admin_assign_bot_tools", (p, i: z.output<typeof architectBotToolsInput>, signal) => assignArchitectBotTools(ctx, p, i, signal)),
    }) },
    { name: "admin_assign_bot_skills", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Move skills you own between your shared skill library and one of your ordinary caller bots. Read admin_get_bot first and pass its exact revision. This changes whether the skill is available to all your bots or only this bot; the Skills tool group must already be enabled. It preserves bot audiences, tool groups and MCP assignments. Always requires exact per-call approval.",
      inputSchema: architectBotSkillsInput,
      execute: guarded("admin_assign_bot_skills", (p, i: z.output<typeof architectBotSkillsInput>, signal) => assignArchitectBotSkills(ctx, p, i, signal)),
    }) },
    { name: "admin_update_provider_connection", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Update only the display name or enabled state of an existing saved provider connection. Read admin_list_connections first and pass its exact updatedAt value. Provider, endpoint, billing target and credential are protected and unchanged. Always requires exact per-call approval.",
      inputSchema: architectProviderConnectionUpdateInput,
      execute: guarded("admin_update_provider_connection", (p, i: z.output<typeof architectProviderConnectionUpdateInput>, signal) => updateArchitectProviderConnection(ctx, p, i, signal)),
    }) },
    { name: "admin_test_provider_connection", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Test an enabled existing saved provider connection using only its stored credential and a metadata-only endpoint check. Read admin_list_connections first and pass its exact updatedAt value. Does not accept or reveal a credential, send a model prompt, or generate content. Always requires exact per-call approval.",
      inputSchema: architectProviderConnectionTestInput,
      execute: guarded("admin_test_provider_connection", (p, i: z.output<typeof architectProviderConnectionTestInput>, signal) => testArchitectProviderConnection(ctx, p, i, signal)),
    }) },
    { name: "admin_set_user_disabled", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Disable or re-enable one user account. Read admin_list_users first and pass its exact sessionVersion. This revokes sessions and follows existing workspace, ChatGPT and Team lifecycle handling; self-disable and removal of the last enabled local admin are refused. Always requires exact per-call approval.",
      inputSchema: architectUserDisabledInput,
      execute: guarded("admin_set_user_disabled", (p, i: z.output<typeof architectUserDisabledInput>, signal) => setArchitectUserDisabled(ctx, p, i, signal)),
    }) },
    { name: "admin_update_group_profile", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Change only a group's name or description. Read admin_list_users and pass the group's exact revision. Memberships, directory mappings, administrator status and bot-creation permission remain unchanged. Always requires exact per-call approval.",
      inputSchema: architectGroupProfileInput,
      execute: guarded("admin_update_group_profile", (p, i: z.output<typeof architectGroupProfileInput>, signal) => updateArchitectGroupProfile(ctx, p, i, signal)),
    }) },
    { name: "admin_update_settings", key: ADMIN_TOOL_KEY, sensitive: true, grantable: false, tool: tool({
      description: "Update only the existing public branding text fields or upload/attachment limits. Read admin_get_settings first and pass the exact updatedAt revision. Default model/bot routing and all access/policy settings are excluded. Always requires exact per-call approval.",
      inputSchema: architectSettingsUpdateInput,
      execute: guarded("admin_update_settings", (p, i: z.output<typeof architectSettingsUpdateInput>, signal) => updateArchitectSettings(ctx, p, i, signal)),
    }) },
    entry("admin_get_settings", tool({
      description: "Read public portal branding fields and upload/attachment limits with exact update revisions. Default model/bot routing is omitted.",
      inputSchema: none,
      execute: guarded("admin_get_settings", p => adminGetArchitectSettings(p)),
    })),
    entry("admin_diagnostic_bundle", tool({
      description: "Build a worker-safe bounded diagnostic summary from database counts and usage rollups. Returns numeric totals plus database/worker health and recent failure classifications; it does not probe network services or return names, raw logs, environment values, URLs or credentials.",
      inputSchema: diagnosticWindow,
      execute: guarded("admin_diagnostic_bundle", async (p, i: z.output<typeof diagnosticWindow>) => adminDiagnosticBundle(p, i)),
    })),
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
      description: "Read persisted pg-boss queue counters without starting the queue service. If its queue catalog is not available, reports unavailable rather than initializing it.",
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
