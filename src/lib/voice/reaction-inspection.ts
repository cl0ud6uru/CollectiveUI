import { z } from "zod";
import { FACE_PROFILES, MOTION_PROFILES } from "./reaction-library";
import type { DecisionResult } from "@/lib/llm/providers/decisions";
import type { ReactionMetricReason } from "./reaction-diagnostics";

const choices = ["keep_current", ...FACE_PROFILES, ...MOTION_PROFILES, "restrained", "natural", "clear", "linger", "brisk"] as const;
export const decisionInspectionSchema = z.object({
  status: z.enum(["ok", "unavailable", "timeout", "invalid", "refusal", "disabled", "rate_limited"]),
  answers: z.array(z.object({ name: z.enum(["face", "motion", "intensity", "pace"]), choice: z.enum(choices), confidence: z.number().finite().min(0).max(1) }).strict()).max(4),
  latencyMs: z.number().finite().min(0).max(60000),
}).strict();
export type DecisionInspection = z.infer<typeof decisionInspectionSchema>;
export type ReactionDecisionView = { revision: number; reason: ReactionMetricReason; latencyMs: number; decision?: DecisionInspection; motionDropReason?: "cooldown" };

/** Fixed choices only: no prompt, provider error body, credentials or arbitrary response strings. */
export function inspectDecision(result: DecisionResult, latencyMs: number): DecisionInspection {
  const answers: DecisionInspection["answers"] = [];
  if (result.status === "ok") for (const answer of result.answers) {
    if (answer.type !== "choice") continue;
    const parsed = decisionInspectionSchema.shape.answers.element.safeParse({ name: answer.name, choice: answer.choice, confidence: answer.confidence });
    if (parsed.success && !answers.some(a => a.name === parsed.data.name)) answers.push(parsed.data);
  }
  return { status: result.status, answers: answers.slice(0, 4), latencyMs: Math.min(60000, Math.max(0, latencyMs)) };
}
