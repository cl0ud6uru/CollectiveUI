/**
 * Stops the provider run behind a portal run that ended abnormally (stopped while queued, its worker died, its
 * continuation couldn't start), so it doesn't carry on unobserved: closes the Hermes stream this process holds for it,
 * else asks Hermes to stop the run recorded in its resume state. Best effort; never throws.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, aiApps } from "@/db/schema";
import { dropParkedForAgentRun } from "@/lib/llm/providers/hermes/runs";
import { stopHermesRun } from "@/lib/llm/resolve";
import { notifyRun } from "./log";
import type { AgentRun, ResumeState } from "./types";
import { loadHermesRunContext } from "./hermes-context";
import { reconcileHermesStop } from "./hermes-stop";

export async function stopProviderRun(run: Pick<AgentRun, "id" | "appId" | "resumeState">): Promise<void> {
  try {
    if (await loadHermesRunContext(run.id)) {
      // Use the immutable connection binding and retain an unconfirmed outcome for /status and retries.
      const [stored] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
      if (stored) await reconcileHermesStop(stored, true);
      dropParkedForAgentRun(run.id);
      return;
    }
    if (dropParkedForAgentRun(run.id)) return;
    const hermesRunId = (run.resumeState as ResumeState | null)?.hermes?.runId;
    if (!hermesRunId || !run.appId) return;
    const [app] = await db.select().from(aiApps).where(eq(aiApps.id, run.appId));
    if (app?.provider === "hermes") await stopHermesRun(app, hermesRunId);
  } catch (err) {
    console.warn(`[runs] run ${run.id}: couldn't stop its provider run`, err);
  }
}

/**
 * Before conversations are deleted (their runs go with them, by cascade): asks the worker holding each open run's
 * provider stream to close it, and stops the provider runs, so nothing keeps running for a chat that's gone.
 */
export async function stopRunsBeforeDelete(where: { conversationId: string } | { userId: string }): Promise<void> {
  try {
    const open = await db
      .select({ id: agentRuns.id, appId: agentRuns.appId, resumeState: agentRuns.resumeState })
      .from(agentRuns)
      .where(
        and(
          "conversationId" in where ? eq(agentRuns.conversationId, where.conversationId) : eq(agentRuns.userId, where.userId),
          inArray(agentRuns.status, ["queued", "running", "waiting"]),
        ),
      );
    for (const run of open) {
      await notifyRun(db, { r: run.id, k: "c" }).catch(() => {});
      await stopProviderRun(run);
    }
  } catch (err) {
    console.warn("[runs] couldn't stop runs before deleting conversations", err);
  }
}
