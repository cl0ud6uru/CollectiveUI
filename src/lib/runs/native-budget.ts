import { HttpError } from "@/lib/authz";
import type { ResumeState } from "./types";

export const NATIVE_BUDGET_EXHAUSTED = "This reply exhausted its deadline or model-step budget. Start a new request to continue.";

/** Check the retained budget under the run lock before accepting any approval decisions. */
export function assertNativeContinuationBudget(resumeState: ResumeState | null, now = Date.now()): void {
  const native = resumeState?.native;
  if (native && (native.deadlineAt <= now || native.stepsUsed >= native.maxSteps))
    throw new HttpError(409, NATIVE_BUDGET_EXHAUSTED);
}
