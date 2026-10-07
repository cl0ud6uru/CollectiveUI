/** Delegation policy is independent of whether a browser happens to be connected. */
export const MAX_DELEGATION_DEPTH = 2;
export const MAX_ROOT_TASKS = 8;
export const MAX_ROOT_ACTIVE_TASKS = 4;
export const MAX_USER_OPEN_ASYNC_TASKS = 16;
export const TASK_READ_ONLY = "Delegated tasks are read-only. Open the original chat to request another attempt, or start a separate chat.";
export const isDelegationTool = (name: string) => /^(ask|continue)_/.test(name);

export function hasPendingAsyncTasks(message: { parts: readonly unknown[] } | undefined): boolean {
  return !!message?.parts.some(p => {
    if (!p || typeof p !== "object" || !("state" in p) || p.state !== "output-available" || !("output" in p)) return false;
    const output = p.output;
    return !!output && typeof output === "object" && "taskId" in output && "status" in output && output.status === "queued";
  });
}

export type DelegationResult = {
  taskId: string;
  conversationId: string | null;
  bot: string;
  /** Display-only receiver identity for the chat card; never authority. */
  botId?: string;
  avatar?: string | null;
  label?: string | null;
  status: "queued" | "working" | "done" | "error" | "cancelled" | "interrupted";
  steps: { tool: string; status: "running" | "done" | "error" | "denied" }[];
  answer?: string;
  error?: string;
  /** ISO times of the receiver's run, present only on a finished result that recorded both. */
  startedAt?: string;
  finishedAt?: string;
};

export function checkAncestry(path: { from: string; to: string }[], source: string, receiver: string, depth: number) {
  if (depth !== path.length || depth >= MAX_DELEGATION_DEPTH) throw new Error("Delegation depth limit reached.");
  const visited = new Set(path.flatMap(e => [e.from, e.to]));
  if (source === receiver || visited.has(receiver)) throw new Error("This delegation would create a loop.");
  if (path.length && path.at(-1)!.to !== source) throw new Error("Invalid delegation ancestry.");
}
