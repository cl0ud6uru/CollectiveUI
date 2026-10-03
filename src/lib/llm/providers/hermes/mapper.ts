/**
 * Turns Hermes Runs API events into AI SDK stream parts (pure; unit-tested against events recorded from a real
 * Hermes gateway). Hermes runs its tools itself, so tool calls are provider-executed and dynamic, named
 * `hermes__<tool>`, and a flagged command becomes a provider-side approval request on that tool's own call.
 *
 * Hermes tool events carry no call id: started/completed are paired first-in-first-out per tool name.
 */
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { HermesEvent } from "./client";

export const HERMES_TOOL_PREFIX = "hermes__";

/** What must survive while a turn waits for someone to answer an approval (kept with the parked run). */
export type MapperState = {
  runId: string;
  /** Tool calls started and not yet completed, oldest first. */
  open: { id: string; tool: string; upstreamId?: string }[];
  /** Calls whose approval was denied: the SDK already closed them, so their tool.completed is dropped. */
  denied: string[];
  counter: number;
  /** Hermes' approval timeout, shown on the approval card. */
  approvalTimeoutSec?: number;
};

export type Approval = { approvalId: string; requestId: string; toolCallId: string };

export type Outcome =
  | { kind: "completed"; usage: LanguageModelV4Usage; output: string; runtime: { provider?: string; model?: string } }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

export type Step = { parts: LanguageModelV4StreamPart[]; approval?: Approval & { command?: string; reason?: string }; outcome?: Outcome };

/** Stable per run and unique per call; safe inside the approval id (no dots). */
const callId = (runId: string, n: number) => `hc_${runId.replace(/^run_/, "").slice(0, 12)}_${n}`;

/** hermes.<run_id>.<request_id>.<tool_call_id>: everything a later request needs to answer and resume. */
export function approvalIdFor(runId: string, requestId: string, toolCallId: string) {
  return `hermes.${runId}.${requestId}.${toolCallId}`;
}

export function parseApprovalId(id: string): Approval | null {
  const m = /^hermes\.(run_[A-Za-z0-9]+)\.([A-Za-z0-9_-]{1,256})\.(hc_[A-Za-z0-9]+_\d+)$/.exec(id);
  return m ? { approvalId: id, requestId: m[2], toolCallId: m[3] } : null;
}

export const runIdOfApproval = (id: string) => /^hermes\.(run_[A-Za-z0-9]+)\./.exec(id)?.[1] ?? null;

const toolName = (tool: string) => `${HERMES_TOOL_PREFIX}${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50) || "tool"}`;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function usageFrom(raw: unknown): LanguageModelV4Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const input = num(u.input_tokens);
  const cacheRead = num(u.cache_read_tokens);
  return {
    inputTokens: { total: input, noCache: input !== undefined ? input - (cacheRead ?? 0) : undefined, cacheRead, cacheWrite: num(u.cache_write_tokens) },
    outputTokens: { total: num(u.output_tokens), text: undefined, reasoning: undefined },
  };
}

export const EMPTY_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** A tool preview is usually JSON text (the tool's own result); keep it structured when it parses. */
function previewValue(preview: string): Record<string, unknown> {
  if (preview.startsWith("{")) {
    try {
      const v = JSON.parse(preview) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // cut at 500 characters by Hermes: fall through
    }
  }
  return { preview };
}

export class HermesMapper {
  readonly state: MapperState;
  private textId: string | null = null;
  private streamedText = "";
  private sawText = false;
  private held: { id: string; tool: string; preview: string } | null = null;
  private seq = 0;

  constructor(state: MapperState) {
    this.state = state;
  }

  static fresh(runId: string, approvalTimeoutSec?: number) {
    return new HermesMapper({ runId, open: [], denied: [], counter: 0, approvalTimeoutSec });
  }

  /** A tool call that started but isn't shown yet (Hermes asks for approval right after tool.started). */
  get holding() {
    return this.held !== null;
  }

  private nextId() {
    this.state.counter += 1;
    return callId(this.state.runId, this.state.counter);
  }

  private endText(parts: LanguageModelV4StreamPart[]) {
    if (this.textId) {
      parts.push({ type: "text-end", id: this.textId });
      this.textId = null;
    }
  }

  private text(parts: LanguageModelV4StreamPart[], delta: string) {
    if (!delta) return;
    if (!this.textId) {
      this.textId = `ht_${++this.seq}`;
      parts.push({ type: "text-start", id: this.textId });
    }
    parts.push({ type: "text-delta", id: this.textId, delta });
    this.streamedText += delta;
    this.sawText = true;
  }

  private toolCall(parts: LanguageModelV4StreamPart[], id: string, tool: string, input: Record<string, unknown>) {
    this.endText(parts);
    parts.push({ type: "tool-call", toolCallId: id, toolName: toolName(tool), input: JSON.stringify(input), providerExecuted: true, dynamic: true });
  }

  /** Shows the held tool call (no approval followed within the hold window). */
  flushHeld(): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [];
    if (this.held) {
      const h = this.held;
      this.held = null;
      this.toolCall(parts, h.id, h.tool, { preview: h.preview });
    }
    return parts;
  }

  /** Marks an approval the person denied, so the tool's later "blocked" completion isn't shown twice. */
  denied(toolCallId: string) {
    if (!this.state.denied.includes(toolCallId)) this.state.denied.push(toolCallId);
  }

  onEvent(e: HermesEvent): Step {
    const parts: LanguageModelV4StreamPart[] = e.event === "approval.request" ? [] : this.flushHeld();
    switch (e.event) {
      case "message.delta":
        this.text(parts, str(e.delta));
        break;
      case "message.interim":
        if (e.already_streamed !== true) this.text(parts, str(e.text) + "\n\n");
        break;
      case "reasoning.available": {
        // Hermes repeats the final answer here; only real reasoning is shown.
        const text = str(e.text).trim();
        if (text && text !== this.streamedText.trim() && !this.streamedText.includes(text)) {
          this.endText(parts);
          const id = `hr_${++this.seq}`;
          parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: text }, { type: "reasoning-end", id });
        }
        break;
      }
      case "tool.started": {
        const id = this.nextId();
        const tool = str(e.tool) || "tool";
        this.state.open.push({ id, tool, ...(str(e.tool_id) ? { upstreamId: str(e.tool_id) } : {}) });
        // Held briefly: if Hermes flags it, the call is shown with the approval reason (see HermesModel).
        this.held = { id, tool, preview: str(e.preview) };
        this.streamedText = "";
        break;
      }
      case "tool.completed": {
        const tool = str(e.tool) || "tool";
        const i = this.state.open.findIndex((o) => str(e.tool_id) ? o.upstreamId === e.tool_id : o.tool === tool);
        if (i < 0) break;
        const [{ id }] = this.state.open.splice(i, 1);
        if (this.state.denied.includes(id)) break;
        const duration = num(e.duration);
        const value = { ...previewValue(str(e.preview)), ...(duration !== undefined ? { duration_s: duration } : {}) };
        this.endText(parts);
        parts.push({ type: "tool-result", toolCallId: id, toolName: toolName(tool), result: value as never, isError: e.error === true, dynamic: true });
        break;
      }
      case "subagent.start": {
        const id = this.nextId();
        this.state.open.push({ id, tool: "delegate_task" });
        this.toolCall(parts, id, "delegate_task", { goal: str(e.goal) || str(e.preview) });
        break;
      }
      case "subagent.complete": {
        const i = this.state.open.findIndex((o) => o.tool === "delegate_task");
        if (i < 0) break;
        const [{ id }] = this.state.open.splice(i, 1);
        const duration = num(e.duration_seconds);
        const result = { status: str(e.status) || "done", summary: str(e.summary) || str(e.preview), ...(duration !== undefined ? { duration_s: duration } : {}) };
        this.endText(parts);
        parts.push({ type: "tool-result", toolCallId: id, toolName: toolName("delegate_task"), result, isError: e.status === "failed", dynamic: true });
        break;
      }
      case "approval.request": {
        const requestId = str(e.request_id);
        const command = str(e.command);
        const reason = str(e.description) || str(e.pattern_key);
        const expires = this.state.approvalTimeoutSec ? { expires_in_s: this.state.approvalTimeoutSec } : {};
        let target = this.held;
        if (str(e.tool_id)) {
          const exact = this.state.open.find(o => o.upstreamId === e.tool_id);
          if (!exact) break;
          if (target && target.id !== exact.id) parts.push(...this.flushHeld());
          target = this.held?.id === exact.id ? this.held : null;
          if (!target) {
            const approvalId = approvalIdFor(this.state.runId, requestId, exact.id);
            parts.push({ type: "tool-approval-request", approvalId, toolCallId: exact.id });
            return { parts, approval: { approvalId, requestId, toolCallId: exact.id, command, reason } };
          }
        }
        if (target) {
          this.held = null;
          this.toolCall(parts, target.id, target.tool, { command: command || target.preview, reason, ...expires });
        } else {
          const last = this.state.open.at(-1);
          target = last ? { ...last, preview: "" } : null;
          if (!target) {
            // An approval for something that didn't announce itself: give it a call of its own.
            const id = this.nextId();
            this.state.open.push({ id, tool: "approval" });
            target = { id, tool: "approval", preview: "" };
            this.toolCall(parts, id, "approval", { command, reason, ...expires });
          }
        }
        if (!requestId) break;
        const approvalId = approvalIdFor(this.state.runId, requestId, target.id);
        parts.push({ type: "tool-approval-request", approvalId, toolCallId: target.id });
        return { parts, approval: { approvalId, requestId, toolCallId: target.id, command, reason } };
      }
      case "run.completed": {
        const output = str(e.output);
        // Nothing streamed (e.g. the turn ran in a Hermes desktop's live Bot Chat): show the final answer.
        if (!this.sawText && output) this.text(parts, output);
        this.endText(parts);
        return { parts, outcome: { kind: "completed", usage: usageFrom(e.usage), output, runtime: (e.runtime ?? {}) as { provider?: string; model?: string } } };
      }
      case "run.failed":
        this.endText(parts);
        return { parts, outcome: { kind: "failed", error: str(e.error) || "The Hermes run failed." } };
      case "run.cancelled":
      case "run.interrupted":
        this.endText(parts);
        return { parts, outcome: { kind: "cancelled" } };
      default:
        break;
    }
    return { parts };
  }

  /**
   * Ends the calls still open when the run itself has ended without their tool.completed (its events were lost and the
   * outcome came from the run's status): `resultFor` says what is known about each. Denied calls are already closed.
   */
  closeOpen(resultFor: (toolCallId: string) => { result: Record<string, unknown>; isError: boolean }): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [];
    for (const { id, tool } of this.state.open.splice(0)) {
      if (this.state.denied.includes(id)) continue;
      const { result, isError } = resultFor(id);
      this.endText(parts);
      parts.push({ type: "tool-result", toolCallId: id, toolName: toolName(tool), result: result as never, isError, dynamic: true });
    }
    return parts;
  }

  /** Closes open text at the end of a request (the run itself may continue later). */
  finish(): LanguageModelV4StreamPart[] {
    const parts = this.flushHeld();
    this.endText(parts);
    return parts;
  }
}
