import { getToolOrDynamicToolName, isToolUIPart } from "ai";
import type { PortalUIMessage } from "@/lib/chat/store";
import { redactSecrets } from "@/lib/redact";
import type { ReviewedLesson } from "./types";

/** Model output is evidence only when the tool actually completed, without an error payload. */
export function successfulToolEvidence(message: PortalUIMessage) {
  return message.parts.flatMap(p => {
    if (!isToolUIPart(p) || p.state !== "output-available" || p.preliminary || p.output == null) return [];
    const output = p.output;
    if (output && typeof output === "object" && (
      ("error" in output && output.error) || ("success" in output && output.success === false) ||
      ("ok" in output && output.ok === false) || ("exitCode" in output && typeof output.exitCode === "number" && output.exitCode !== 0) ||
      ("status" in output && ["error", "failed", "denied", "cancelled", "interrupted", "queued", "running", "working", "assigned"].includes(String(output.status)))
    )) return [];
    const name = getToolOrDynamicToolName(p);
    if (name === "use_skill" || name === "remember" || name === "forget" || name.startsWith("ask_") || name.startsWith("continue_")) return [];
    return [{ callId: p.toolCallId, name, input: p.input, output }];
  });
}

/** Shared procedures need observed tool evidence. Preferences and uncertain claims stay private. */
export function lessonDisposition(lesson: ReviewedLesson, successfulCallIds: Set<string>) {
  const verified = lesson.evidenceCallIds.length > 0 && lesson.evidenceCallIds.every(id => successfulCallIds.has(id));
  const scope = lesson.kind === "preference" || (lesson.kind !== "policy" && !verified) ? "user" : lesson.scope;
  return { scope, status: lesson.kind === "policy" ? "pending" as const : "active" as const };
}

export function containsPrivateIdentity(text: string, identity: { id: string; name: string; upn: string; email: string | null }) {
  const lower = text.toLowerCase();
  return [identity.id, identity.upn, identity.email, identity.name].filter((v): v is string => !!v && v.length >= 3)
    .some(v => lower.includes(v.toLowerCase())) || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
}

/** Concrete inventory/user identifiers must not become shared instructions, even inside prose. */
export function privateEvidenceValues(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /(?:^|_)(?:id|ids|name|hostname|username|email|account|endpoint|device|computer|path|address|ip)(?:$|_)/i.test(key) && value.length >= 4 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(v => privateEvidenceValues(v, key)).slice(0, 1000);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => privateEvidenceValues(v, k.replace(/([a-z])([A-Z])/g, "$1_$2"))).slice(0, 1000);
  return [];
}

export function secretEvidenceValues(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /(?:password|passwd|secret|token|api[_-]?key|credential)/i.test(key) && value.length >= 4 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(v => secretEvidenceValues(v, key)).slice(0, 1000);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => secretEvidenceValues(v, k)).slice(0, 1000);
  return [];
}

export function cleanLearningText(value: string) {
  return redactSecrets(value).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
