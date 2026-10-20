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
      ("isError" in output && output.isError === true) || ("error" in output && output.error) || ("success" in output && output.success === false) ||
      ("ok" in output && output.ok === false) || ("exitCode" in output && typeof output.exitCode === "number" && output.exitCode !== 0) ||
      ("status" in output && ["error", "failed", "denied", "cancelled", "interrupted", "queued", "running", "working", "assigned"].includes(String(output.status)))
    )) return [];
    const name = getToolOrDynamicToolName(p);
    if (name === "use_skill" || name === "remember" || name === "forget" || name.startsWith("ask_") || name.startsWith("continue_")) return [];
    return [{ callId: p.toolCallId, name, input: p.input, output }];
  });
}

/** Shared additions and revisions always need human review; successful calls do not prove generalized steps. */
export function lessonDisposition(lesson: ReviewedLesson, successfulCallIds: Set<string>) {
  const verified = lesson.evidenceCallIds.length > 0 && lesson.evidenceCallIds.every(id => successfulCallIds.has(id));
  const scope = lesson.kind === "preference" || (lesson.kind !== "policy" && !verified) ? "user" : lesson.scope;
  return { scope, status: scope === "bot" || lesson.kind === "policy" ? "pending" as const : "active" as const };
}

export function containsPrivateIdentity(text: string, identity: { id: string; name: string; upn: string; email: string | null }) {
  const lower = text.toLowerCase();
  return [identity.id, identity.upn, identity.email, identity.name].filter((v): v is string => !!v && v.length >= 3)
    .some(v => lower.includes(v.toLowerCase())) || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
}

/** Concrete inventory/user identifiers must not become shared instructions, even inside prose. */
export function privateEvidenceValues(value: unknown, key = ""): string[] {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return /(?:^|_)(?:id|ids|account|device|computer)(?:$|_)/i.test(key) && String(value).length >= 4 ? [String(value)] : [];
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

/** Reject explicit approval-bypass claims; successful execution never grants standing authorization. */
export function unsupportedAuthorizationGuidance(text: string): boolean {
  return text.split(/[.!?\n]+/).some(sentence => {
    if (/\b(?:approval|permission|authorization|consent)\s+(?:(?:is|are|was|were)(?:n't|\s+not)\s+(?:needed|required|necessary)|(?:is|are)\s+(?:optional|unnecessary))\b/i.test(sentence)) return true;
    if (/\b(?:do not|don't|does not|doesn't|need not)\s+(?:need|require|seek|obtain|wait for)\b.{0,60}\b(?:approval|permission|authorization|consent)\b/i.test(sentence)) return true;
    if (/\b(?:do not|don't|never)\s+(?:ask|wait|check|require|enforce|request)\b.{0,80}\b(?:approval|permission|authorization|consent)\b/i.test(sentence)) return true;
    const bypass = /\b(?:skip|bypass|ignore|disable|waive)\b.{0,60}\b(?:approval|permission|authorization|consent|instructions|boundaries|policy)\b/i.exec(sentence);
    if (bypass && !/(?:do not|don't|never|must not|should not)\s*$/i.test(sentence.slice(0, bypass.index))) return true;
    if (/\b(?:no|without)\s+(?:(?:further|new|explicit|human|user|required)\s+){0,3}(?:approval|permission|authorization|consent)\b/i.test(sentence) &&
        !/(?:\b(?:never|do not|don't|must not|should not|cannot|can't)\b|\bno\s+(?:changes?|actions?|writes?|installations?)\b|^\s*not\s+without\b)/i.test(sentence)) return true;
    return /\b(?:checking|a check|check request|request to check|read-only request)\b.{0,60}\b(?:authorizes|permits|allows|grants)\b/i.test(sentence);
  });
}
