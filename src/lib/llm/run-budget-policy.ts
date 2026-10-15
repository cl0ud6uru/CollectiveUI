import { z } from "zod";
import { HttpError } from "@/lib/http-error";

const positive = z.number().int().min(1).max(1_000_000_000_000);
const rate = z.number().int().min(0).max(1_000_000_000_000);
const route = z.object({
  provider: z.enum(["openai", "azure", "anthropic", "bedrock", "vertex-anthropic", "openai-compatible", "openrouter"]),
  model: z.string().trim().min(1).max(300),
  /** An operator-approved native text adapter, never inferred from a model name or a price catalog. */
  inputContract: z.literal("conservative-text-v1"),
  inputMicrosPerMillion: rate.optional(),
  outputMicrosPerMillion: rate.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.inputMicrosPerMillion === undefined) !== (value.outputMicrosPerMillion === undefined))
    ctx.addIssue({ code: "custom", message: "Input and output rates must both be configured or both be omitted." });
});
export const NativeRunBudgetPolicySchema = z.object({
  enabled: z.literal(true),
  maxTokens: positive.nullable(),
  maxCostMicros: positive.nullable(),
  maxInputTokensPerCall: positive.max(10_000_000),
  maxOutputTokensPerCall: positive.max(1_000_000),
  routes: z.array(route).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  if (value.maxTokens === null && value.maxCostMicros === null) ctx.addIssue({ code: "custom", message: "At least one cap is required." });
  const identities = value.routes.map(item => `${item.provider}:${item.model}`);
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: "custom", message: "Routes must be unique." });
});
export type NativeRunBudgetPolicy = z.infer<typeof NativeRunBudgetPolicySchema>;
export type NativeBudgetRoute = NativeRunBudgetPolicy["routes"][number];

export class NativeRunBudgetError extends HttpError {
  readonly userFacing = true;
  constructor(message: string) { super(409, message); this.name = "NativeRunBudgetError"; }
}

/** Off unless an operator explicitly supplies the whole policy. Malformed nonempty config fails closed. */
export function nativeRunBudgetPolicy(raw = process.env.NATIVE_RUN_BUDGET): NativeRunBudgetPolicy | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(raw);
    if (value && Object.keys(value).length === 1 && value.enabled === false) return null;
    const parsed = NativeRunBudgetPolicySchema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch { /* Never include operator config or provider input in errors. */ }
  throw new NativeRunBudgetError("Native run budget configuration is invalid. Ask an administrator to review it.");
}

export function nativeBudgetRoute(policy: NativeRunBudgetPolicy, provider: string, model: string) {
  const found = policy.routes.find(item => item.provider === provider && item.model === model);
  if (!found) throw new NativeRunBudgetError("This model has no approved native budget input contract. No provider request was sent.");
  if (policy.maxCostMicros !== null && (found.inputMicrosPerMillion === undefined || found.outputMicrosPerMillion === undefined)) {
    throw new NativeRunBudgetError("This model's budget price is unknown. No provider request was sent and no billing fallback was selected.");
  }
  return found;
}

/** Integer price ceilings prevent floating-point rounding from understating a reservation. */
export function nativeBudgetCost(input: number, output: number, route: NativeBudgetRoute): number {
  const scaled = BigInt(input) * BigInt(route.inputMicrosPerMillion ?? 0) + BigInt(output) * BigInt(route.outputMicrosPerMillion ?? 0);
  const micros = (scaled + BigInt(999_999)) / BigInt(1_000_000);
  if (micros > BigInt(1_000_000_000_000)) throw new NativeRunBudgetError("This native model request exceeds the supported cost bound.");
  return Number(micros);
}

/**
 * A conservative local admission envelope, not a tokenizer or invoice guarantee. All known input-bearing fields
 * are included. Modal/opaque input and provider-executed tools have no supported bound and fail before dispatch.
 * The explicit route contract means the operator reviewed its text formatting and input/output rate ceilings.
 */
export function nativeTextInputBound(value: unknown): number {
  let nodes = 0;
  function check(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 32) throw new NativeRunBudgetError("Native model input exceeds the supported budget envelope.");
    if (item === undefined || item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) check(child, depth + 1); return; }
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) throw new NativeRunBudgetError("Opaque model input cannot be safely admitted under a native run budget.");
    const object = item as Record<string, unknown>;
    if (["file", "image", "audio", "video", "reasoning-file", "custom", "provider", "provider-defined"].includes(String(object.type))) {
      throw new NativeRunBudgetError("Multimodal input or provider-executed tools have no supported native budget bound. No provider request was sent.");
    }
    for (const [key, child] of Object.entries(object)) {
      if (/^(?:encryptedContent|reasoningEncryptedContent|signature|itemId|previousResponseId|conversationId|fileId|containerId|providerReference)$/i.test(key)) {
        throw new NativeRunBudgetError("Opaque provider input has no supported native budget bound. No provider request was sent.");
      }
      check(child, depth + 1);
    }
  }
  check(value, 0);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new NativeRunBudgetError("Native model input cannot be safely budgeted."); }
  if (typeof serialized !== "string") throw new NativeRunBudgetError("Native model input cannot be safely budgeted.");
  // Include JSON escaping, tools/instructions and generous bounded provider framing; UTF-8 text bytes are
  // deliberately over-reserved. Invoices, hidden provider adjustments and unsupported inputs are not inferred.
  return new TextEncoder().encode(serialized).byteLength * 2 + nodes * 128 + 4_096;
}

export function nativeBudgetEnvelope(policy: NativeRunBudgetPolicy, route: NativeBudgetRoute, input: unknown, output: number) {
  const inputTokens = nativeTextInputBound(input);
  if (inputTokens > policy.maxInputTokensPerCall) throw new NativeRunBudgetError("Instructions, tools and input exceed this native run's per-call budget ceiling. No provider request was sent.");
  if (!Number.isSafeInteger(output) || output < 0 || output > policy.maxOutputTokensPerCall) throw new NativeRunBudgetError("The native model output limit exceeds its approved budget ceiling.");
  return { inputTokens, outputTokens: output, tokens: inputTokens + output, costMicros: nativeBudgetCost(inputTokens, output, route) };
}
