import { createHash } from "node:crypto";
import type { MCPClient } from "@ai-sdk/mcp";
import type { McpDrift, McpToolAnnotations, McpToolDef } from "./kinds";

/** Sanity limits for one server's tool list. */
export const MAX_TOOLS = 500;
const MAX_PAGES = 50;

const ANNOTATION_KEYS = ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** Keeps only the fields the portal uses (drops _meta, icons and anything unknown), so the snapshot stays small. */
export function toToolDef(raw: unknown): McpToolDef | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !t.name) return null;
  const schema = t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : {};
  const def: McpToolDef = { name: t.name, inputSchema: { ...schema, type: "object" } };
  if (typeof t.title === "string") def.title = t.title;
  if (typeof t.description === "string") def.description = t.description;
  if (t.outputSchema && typeof t.outputSchema === "object") def.outputSchema = t.outputSchema as Record<string, unknown>;
  if (t.annotations && typeof t.annotations === "object") {
    const a = t.annotations as Record<string, unknown>;
    const annotations: McpToolAnnotations = {};
    for (const k of ANNOTATION_KEYS) if (a[k] !== undefined) (annotations as Record<string, unknown>)[k] = a[k];
    if (Object.keys(annotations).length) def.annotations = annotations;
  }
  return def;
}

/** JSON with sorted keys, so a server reordering fields doesn't look like a change. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Everything the model or the approval policy reads: description, schemas and annotations. A changed description
 * or a tool that stops calling itself read-only counts as a change, not only a changed signature.
 */
export const toolHash = (t: McpToolDef) => sha256(canonicalJson(t));

export function snapshotHash(tools: McpToolDef[]): string {
  return sha256(
    tools
      .map((t) => `${t.name}:${toolHash(t)}`)
      .sort()
      .join("\n"),
  );
}

export function diffTools(accepted: McpToolDef[], next: McpToolDef[]): Pick<McpDrift, "added" | "changed" | "removed"> {
  const before = new Map(accepted.map((t) => [t.name, toolHash(t)]));
  const after = new Map(next.map((t) => [t.name, toolHash(t)]));
  return {
    added: [...after.keys()].filter((n) => !before.has(n)).sort(),
    changed: [...after.entries()].filter(([n, h]) => before.has(n) && before.get(n) !== h).map(([n]) => n).sort(),
    removed: [...before.keys()].filter((n) => !after.has(n)).sort(),
  };
}

/** Lists every tool (following nextCursor), deduplicated by name, first one wins. */
export async function listAllTools(client: MCPClient, options?: { signal?: AbortSignal; timeout?: number }): Promise<McpToolDef[]> {
  const byName = new Map<string, McpToolDef>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.listTools({ ...(cursor ? { params: { cursor } } : {}), options });
    for (const raw of res.tools) {
      const def = toToolDef(raw);
      if (def && !byName.has(def.name)) byName.set(def.name, def);
      if (byName.size > MAX_TOOLS) throw new Error(`The server lists more than ${MAX_TOOLS} tools`);
    }
    cursor = res.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return [...byName.values()];
}

/** Names of accepted tools that are hidden while a change waits for review (changed or removed ones). */
export function hiddenByDrift(drift: McpDrift | null | undefined): Set<string> {
  return new Set(drift ? [...drift.changed, ...drift.removed] : []);
}
