import { z } from "zod";

/**
 * Write-only secret fields in admin forms: blank keeps the stored value, "__clear__" removes it,
 * anything else replaces it.
 */
export const CLEAR_SECRET = "__clear__";

export type SecretInput = { action: "keep" } | { action: "clear" } | { action: "set"; value: string };

export function parseSecretInput(raw: string | null | undefined): SecretInput {
  const v = raw?.trim() ?? "";
  if (!v) return { action: "keep" };
  if (v === CLEAR_SECRET) return { action: "clear" };
  return { action: "set", value: v };
}

/** MCP server headers: a JSON object of string values, with the same keep/clear semantics. */
export function parseHeadersInput(raw: string | null | undefined): { action: "keep" } | { action: "clear" } | { action: "set"; headers: Record<string, string> } {
  const s = parseSecretInput(raw);
  if (s.action !== "set") return s;
  let json: unknown;
  try {
    json = JSON.parse(s.value);
  } catch {
    throw new Error('Headers must be a JSON object, e.g. {"Authorization": "Bearer …"}');
  }
  return { action: "set", headers: z.record(z.string(), z.string()).parse(json) };
}
