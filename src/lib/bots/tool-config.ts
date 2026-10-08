import { z } from "zod";
import type { BotToolConfig } from "@/db/schema";

export const ApprovalModeSchema = z.enum(["auto", "ask", "smart"]);

/** Per-tool choices for MCP servers and workspace tools on a bot. */
export const BotToolConfigSchema = z.object({
  tools: z.array(z.string().max(128)).max(500).optional(),
  approvals: z.record(z.string().max(128), ApprovalModeSchema).optional(),
});

/** Drops empty parts, so "every tool, no overrides" is stored as no config at all. */
export function normalizeToolConfig(config: BotToolConfig | null | undefined): BotToolConfig | null {
  if (!config) return null;
  const approvals = config.approvals && Object.keys(config.approvals).length ? config.approvals : undefined;
  const out: BotToolConfig = { ...(config.tools ? { tools: [...new Set(config.tools)] } : {}), ...(approvals ? { approvals } : {}) };
  return Object.keys(out).length ? out : null;
}

export const WORKSPACE_PERMISSIONS = [
  { label: "Use uploaded files", names: ["workspace_import_attachment"], description: "Copy files from this chat into the workspace for analysis.", defaultMode: "ask" },
  { label: "Read files", names: ["workspace_read", "workspace_list", "workspace_grep"], description: "Read, list and search workspace files.", defaultMode: "auto" },
  { label: "Create and edit files", names: ["workspace_write", "workspace_edit"], description: "Create documents and update workspace files.", defaultMode: "ask" },
  { label: "Run commands", names: ["workspace_bash"], description: "Analyze spreadsheets and generate charts. Commands can also read and change files.", defaultMode: "ask" },
] as const;

/** Workspace accepts only known tools and explicit auto/ask overrides. */
export function normalizeWorkspaceConfig(config: BotToolConfig | null | undefined): BotToolConfig | null {
  const names = WORKSPACE_PERMISSIONS.flatMap((p) => [...p.names]);
  const approvals = Object.fromEntries(Object.entries(config?.approvals ?? {}).filter(
    ([name, mode]) => names.includes(name as typeof names[number]) && (mode === "auto" || mode === "ask"),
  ));
  return Object.keys(approvals).length ? { approvals } : null;
}
