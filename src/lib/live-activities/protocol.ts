import { z } from "zod";
import type { AgentRunStatus } from "@/db/schema";

export const MAX_ACTIVITIES = 3;
export const ACTIVITY_TTL_MS = 8 * 3600_000;
export const ID = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
// APNs tokens are opaque, variable-length bytes. Never trim, echo, or log them.
export const pushToken = z.string().regex(/^(?:[a-fA-F0-9]{2}){32,256}$/).transform((v) => v.toLowerCase());
export const registration = z.object({
  activityId: ID, runId: ID, pushToken,
  tokenVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const removal = z.object({ activityId: ID.optional() }).strict();
export type Registration = z.infer<typeof registration>;
export type Phase = "queued" | "working" | "attention" | "completed" | "failed" | "cancelled" | "reconnecting";
export type ContentState = { phase: Phase; updatedAt: number; revision: number };

export function phaseFor(status: AgentRunStatus, cancelling: boolean): Phase {
  if (status === "cancelled") return "cancelled";
  if (status === "succeeded") return "completed";
  if (status === "failed" || status === "interrupted") return "failed";
  if (cancelling) return "working"; // A stop request isn't a confirmed cancellation.
  if (status === "waiting") return "attention";
  if (status === "queued") return "queued";
  return "working";
}
export const terminal = (phase: Phase) => ["completed", "failed", "cancelled"].includes(phase);
export function contentFor(run: { status: AgentRunStatus; cancelRequestedAt: Date | null; updatedAt: Date; lastSeq: number }): ContentState {
  return { phase: phaseFor(run.status, !!run.cancelRequestedAt), updatedAt: Math.floor(run.updatedAt.getTime() / 1000), revision: run.lastSeq };
}
export const fingerprint = (state: ContentState) => state.phase;

/** Generic status only. No task titles, tool inputs, errors, messages, user names, or account identifiers. */
export function payloadFor(state: ContentState, timestamp: number) {
  const ending = terminal(state.phase);
  return { aps: {
    timestamp, event: ending ? "end" : "update", "content-state": state,
    ...(ending ? { "dismissal-date": timestamp + 300 } : { "stale-date": timestamp + 180 }),
  } };
}

export type DeliveryResult = "delivered" | "invalid-token" | "retry" | "configuration-error";
export function classifyResponse(status: number, reason: string): DeliveryResult {
  if (status === 200) return "delivered";
  if (status === 410 || (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(reason))) return "invalid-token";
  if (status === 429 || status >= 500) return "retry";
  return "configuration-error";
}
