import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/kinds";

const safePath = z.string().min(1).max(200).refine((s) =>
  s.split(".").every((k) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) && !["__proto__", "prototype", "constructor"].includes(k)),
  "Use a property path without prototype keys or array indices",
);
export const ArgumentConstraintSchema = z.object({
  path: safePath,
  source: z.enum(["constant", "caller.id", "caller.upn", "caller.email"]),
  value: z.union([z.string().max(1000), z.number().finite(), z.boolean()]).optional(),
}).strict().refine((c) => c.source !== "constant" || c.value !== undefined, "A constant needs a value");
export type ArgumentConstraint = z.infer<typeof ArgumentConstraintSchema>;

export const ServiceGrantInputSchema = z.object({
  serverId: z.string().min(1),
  serverRevision: z.number().int().positive(),
  toolName: z.string().min(1).max(128),
  toolHash: z.string().regex(/^[a-f0-9]{64}$/),
  effect: z.enum(["read", "write"]).default("write"),
  requireApproval: z.boolean().default(true),
  constraints: z.array(ArgumentConstraintSchema).min(1).max(32),
}).strict().refine((g) => g.effect !== "write" || g.requireApproval, "Writes always require approval");
export type ServiceGrantInput = z.infer<typeof ServiceGrantInputSchema>;

/** Only exact, scalar property constraints; this is not a policy language or a prompt instruction. */
export function validateConstraintSchema(def: McpToolDef, constraints: ArgumentConstraint[]) {
  const seen = new Set<string>();
  for (const c of constraints) {
    if (seen.has(c.path)) throw new Error("Use only one constraint per property");
    seen.add(c.path);
    let schema: Record<string, unknown> = def.inputSchema;
    for (const key of c.path.split(".")) {
      const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
      if (!props || !Object.hasOwn(props, key) || !props[key] || typeof props[key] !== "object")
        throw new Error(`Constraint ${c.path} must name a declared tool property`);
      schema = props[key];
    }
    const type = c.source === "constant" ? typeof c.value : "string";
    if ((schema.type !== type && !(type === "number" && schema.type === "integer")) ||
        (schema.type === "integer" && c.source === "constant" && !Number.isInteger(c.value)))
      throw new Error(`Constraint ${c.path} must match a scalar property's type`);
  }
}

/** Refuse a mismatch instead of silently changing what the model/user approved. Missing identity fails closed. */
export function assertArgumentConstraints(
  input: unknown, constraints: ArgumentConstraint[], caller: { id: string; upn: string; email: string | null },
) {
  for (const c of constraints) {
    let actual: unknown = input;
    for (const key of c.path.split(".")) {
      if (!actual || typeof actual !== "object" || Array.isArray(actual) || !Object.hasOwn(actual, key))
        throw new Error(`Required scope property: ${c.path}`);
      actual = (actual as Record<string, unknown>)[key];
    }
    const expected = c.source === "constant" ? c.value : caller[c.source.slice(7) as keyof typeof caller];
    if (expected == null || (c.source !== "constant" && expected === "") || actual !== expected)
      throw new Error(`This bot cannot use the requested scope for ${c.path}`);
  }
}

export const ENFORCED_APPROVAL_REASON = "Organization policy requires approval for every call.";
