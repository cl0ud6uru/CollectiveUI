import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, hermesRunContexts } from "@/db/schema";
import type { HermesRunContext } from "@/lib/llm/providers/hermes/scope";
import { FINAL_STATUSES } from "./types";

/** Native Team candidates own their admission elsewhere and have no remote run context. */
export function hermesAdmissionRecorder(runId: string, holder: string, segment: number, binding: HermesRunContext | undefined) {
  return binding ? (state: "attempted" | "rejected") => noteHermesAdmission(runId, holder, segment, binding, state) : undefined;
}

/** Never turn a rejection on a later retry into evidence that an earlier POST did not reach Hermes. */
export async function noteHermesAdmission(runId: string, holder: string, segment: number, binding: HermesRunContext | undefined, state: "attempted" | "rejected") {
  if (!binding) throw new Error("Hermes admission binding is unavailable.");
  await db.transaction(async tx => {
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.holder, holder),
      eq(agentRuns.status, "running"), eq(agentRuns.segment, segment))).for("update");
    if (!run || run.resumeState?.hermes) throw new Error("Hermes admission could not be recorded under the current lease.");
    if (state === "rejected" && (run.segment !== 0 || run.legacy)) return;
    const [changed] = await tx.update(hermesRunContexts).set({ admissionState: state }).where(and(
      eq(hermesRunContexts.runId, runId), eq(hermesRunContexts.targetKey, binding.targetKey),
      binding.provisionId ? eq(hermesRunContexts.provisionId, binding.provisionId) : isNull(hermesRunContexts.provisionId),
      isNull(hermesRunContexts.upstreamRunId),
      state === "rejected" ? eq(hermesRunContexts.admissionState, "prepared") :
        or(isNull(hermesRunContexts.admissionState), inArray(hermesRunContexts.admissionState, ["prepared", "attempted"])),
    )).returning({ id: hermesRunContexts.runId });
    // Rejected proof is optional; attempted must be durable before the network call.
    if (!changed && state === "attempted") throw new Error("Hermes admission is already closed or its binding changed.");
  });
}

/** Terminal local rejection is independent of stop_state, which concurrent Stop actions may overwrite. */
export async function confirmHermesNonAdmission(runId: string): Promise<boolean> {
  const [changed] = await db.update(hermesRunContexts).set({ stopState: "confirmed" }).where(and(
    eq(hermesRunContexts.runId, runId), eq(hermesRunContexts.admissionState, "rejected"), isNull(hermesRunContexts.upstreamRunId),
    sql`exists (select 1 from ${agentRuns} where ${agentRuns.id} = ${hermesRunContexts.runId}
      and ${agentRuns.status} in (${sql.join(FINAL_STATUSES.map(s => sql`${s}`), sql`, `)})
      and ${agentRuns.segment} = 0 and not ${agentRuns.legacy} and ${agentRuns.resumeState} is null)`,
  )).returning({ id: hermesRunContexts.runId });
  return !!changed;
}
