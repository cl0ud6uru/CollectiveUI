import { sha256Hex } from '@/lib/crypto';
import { slugify } from '@/lib/utils';

/** Stable approval identity: display names, discovery order and neighboring tools cannot reassign it. */
export function modelToolName(server: { id: string; name?: string }, tool: string, taken: Set<string>): string {
  const identity = sha256Hex(JSON.stringify([server.id, tool])).slice(0, 32);
  const label = tool.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 25);
  const name = `mcp__${label}__${identity}`;
  // Never fall back to an order-dependent alias, even for a malformed duplicate catalog.
  if (taken.has(name)) throw new Error('Duplicate MCP tool identity.');
  taken.add(name);
  return name;
}

/** Compatibility for restrictive admin rules only. Never use this lossy name for remembered grants. */
export function legacyMcpToolName(server: { name: string }, tool: string): string {
  const prefix = slugify(server.name).replace(/-/g, '_') || 'mcp';
  return `${prefix}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
}
