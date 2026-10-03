import { z } from "zod";
import type { BotToolConfig } from "@/db/schema";

export const ApprovalModeSchema = z.enum(["auto", "ask", "smart"]);

/** Per-tool choices for an MCP server on a bot: an allowlist of tool names and per-tool approval overrides. */
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
