/** Shared MCP types (imported by the schema, so no runtime imports here). */

/**
 * draft: added or imported, not yet tested and enabled (bots can't use it).
 * enabled: in use. needs_review: in use, but the server's tool list changed; changed tools stay hidden until an
 * admin accepts them. disabled: switched off.
 */
export type McpServerStatus = "draft" | "enabled" | "disabled" | "needs_review";

/** "trusted" lets Smart approvals believe the server's readOnlyHint annotations. */
export type McpTrust = "untrusted" | "trusted";

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** One tool as the server listed it (tools/list), keeping only the fields the portal uses. */
export type McpToolDef = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

/** Admin choices per tool, by tool name. Tools not listed are on and follow the bot's approval setting. */
export type McpToolPolicy = Record<string, { enabled?: boolean; requireApproval?: boolean }>;

/** A tool list that differs from the accepted one, waiting for an admin. */
export type McpDrift = {
  detectedAt: string;
  hash: string;
  tools: McpToolDef[];
  added: string[];
  changed: string[];
  removed: string[];
};

export type McpServerInfo = { name?: string; version?: string; protocolVersion?: string };
