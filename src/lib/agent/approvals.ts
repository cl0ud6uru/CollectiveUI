import type { ApprovalMode } from "@/db/schema";
import type { McpApprovalFacts } from "./types";

export type ApprovalDecisionInput = {
  toolName: string;
  toolKey: string;
  /** mode configured on the bot for this tool group */
  mode: ApprovalMode;
  /** tool is inherently sensitive (sends/modifies data) — treated as "ask" at minimum */
  sensitive: boolean;
  /** admin-enforced tool names or keys */
  enforced: string[];
  /** tool names the user chose to "always allow" for this bot */
  grants: Set<string>;
  /** MCP tools only: annotations, server trust, admin policy and the bot's per-tool override */
  mcp?: Pick<McpApprovalFacts, "readOnly" | "destructive" | "trusted" | "requireApproval" | "override">;
  /** false: every call asks and "always allow" grants are ignored (e.g. workspace commands) */
  grantable?: boolean;
};

/**
 * Pure approval policy (unit-tested), in order of precedence:
 *  1. admin-enforced tools (org-wide list, or "require approval" on an MCP tool) always ask; grants can't bypass
 *  2. the bot's per-tool override (MCP tools), else the tool group's mode
 *  3. "smart": runs without asking only for an MCP tool that a *trusted* server marks read-only (and not
 *     destructive); annotations from untrusted servers are only hints, so those tools ask. Built-in tools are
 *     first-party, so smart behaves like auto for them (sensitive ones still ask).
 *  4. "ask" (or an inherently sensitive tool) needs approval unless the user granted "always allow" for this
 *     bot + tool (never for non-grantable tools); "auto" runs without approval
 * (An admin turning an MCP tool off removes it from the toolset before this runs.)
 */
export function resolveApproval(i: ApprovalDecisionInput): "user-approval" | undefined {
  if (i.enforced.includes(i.toolName) || i.enforced.includes(i.toolKey) || i.mcp?.requireApproval) return "user-approval";
  const mode = i.mcp?.override ?? i.mode;
  const ask = mode === "ask" || (mode === "smart" && !!i.mcp && !(i.mcp.trusted && i.mcp.readOnly && !i.mcp.destructive));
  if (ask || i.sensitive) {
    if (i.grantable === false || !i.grants.has(i.toolName)) return "user-approval";
  }
  return undefined;
}
