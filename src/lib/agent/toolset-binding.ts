import { sha256Hex } from "@/lib/crypto";
import type { ToolEntry } from "./types";

/** The same opaque authorization/catalog binding is used by dispatch approval and optional shortlisting. */
export function mcpToolsetBinding(authorities: string[], entries: ToolEntry[]): string {
  return sha256Hex(JSON.stringify({ authorities: [...authorities].sort(), mapping: entries.filter(e => e.mcp).map(e => ({
    name: e.name, server: e.key, tool: e.mcp!.tool, definition: e.mcp!.definitionHash,
  })) }));
}
