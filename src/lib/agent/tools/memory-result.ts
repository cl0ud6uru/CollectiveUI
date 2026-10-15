type MemoryResult = {
  status?: string;
  recordType?: string;
  recallStatus?: string;
  deleted?: boolean;
};

/** Keep current structured statuses and legacy `{ deleted: false }` results honest. */
export function memoryToolDoneLabel(name: string, result: MemoryResult | undefined, fallback: string): string {
  if (name === "forget") {
    const labels: Record<string, string> = {
      forgotten: result?.recordType === "learned_preference" ? "Learned preference forgotten" : "Memory forgotten",
      repeat_noop: "No change — same target already checked",
      unsupported_pending: "No change — review pending preference",
      not_found: "No matching memory changed",
    };
    return labels[result?.status ?? ""] ?? (result?.deleted === false ? labels.not_found : fallback);
  }
  if (name === "correct_memory") {
    const labels: Record<string, string> = {
      corrected: result?.recordType === "learned_preference" ? "Learned preference corrected" : result?.recallStatus === "recent_fallback" ? "Memory corrected · recent recall" : "Memory corrected",
      corrected_pending: "Correction saved for review",
      conflict: "Memory changed — refresh before retrying",
      not_found: "No matching memory changed",
    };
    return labels[result?.status ?? ""] ?? fallback;
  }
  return fallback;
}
