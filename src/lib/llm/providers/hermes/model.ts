/**
 * A Hermes profile as an AI SDK language model, driven through the Runs API (docs/architecture/hermes.md).
 *
 * Hermes keeps the conversation itself (one Hermes session per portal conversation), so each call sends only the new
 * user message. Its tool steps come back as provider-executed tool parts; a flagged command becomes a provider-side
 * approval request, the segment ends (the portal run pauses), and the answer arrives with the next call
 * (`tool-approval-response`), which posts it to Hermes and continues the same run: on the stream this process held
 * (runs.ts), else from the resume state saved with the pause. Turns that can't pause (delegates, group chats) deny.
 */
import { nativeAttachments, type NativeAttachment } from "@/local-hermes/interactions";
import { randomUUID } from "node:crypto";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { RunHandle } from "@/lib/runs/types";
import { answerApproval, getRun, HermesError, runEvents, startRun, stopRun, type HermesEvent, type HermesRunStatus, type HermesTarget } from "./client";
import { EMPTY_USAGE, HermesMapper, parseApprovalId, runIdOfApproval, type Approval } from "./mapper";
import { dropParkedForAgentRun, EventTap, holdTtlMs, isParked, park, parkedForAgentRun, parkedForSession, unpark, type ParkedRun } from "./runs";

export type HermesTurnContext = {
  target: HermesTarget;
  /** One Hermes session per portal conversation; null = a fresh session per run (no conversation). */
  sessionId: string | null;
  /** Pseudonymous per-user scope for Hermes' memory providers. */
  sessionKey: string | null;
  /**
   * The turn can pause at an approval and continue once someone answers (the run executor: chats, and routines via
   * the Inbox). False for delegates and group chats, which deny approvals themselves.
   */
  interactive: boolean;
  /** How long Hermes waits for an approval answer (the parked stream is kept a little longer). */
  approvalTimeoutSec: number;
  /** The portal run executing this turn: a pause saves its resume state here, and the next segment reads it back. */
  run?: RunHandle;
  requestedModel?: string | null;
};

/** How long a started tool call is held back, waiting to see whether Hermes flags it (seen: ~180 ms). */
const HOLD_MS = 400;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** What a Hermes call open at the end of a run whose events were lost shows (see HermesMapper.closeOpen). */
function lostResult(answer: "resolved" | "not_pending" | undefined) {
  if (answer === "not_pending") return { result: { status: "not_run", note: "Hermes had already denied it: nobody answered within its time limit." }, isError: true };
  if (answer === "resolved") return { result: { status: "ran", note: "Hermes ran it; its output isn't available." }, isError: false };
  return { result: { status: "unknown", note: "Hermes didn't report how this ended." }, isError: false };
}

type ApprovalAnswer = Approval & { approved: boolean; reason?: string };
type Emit = (part: LanguageModelV4StreamPart) => void;

/** Text of the newest user message (attachments beyond text aren't sent; Hermes bots take text). */
export function lastUserInput(prompt: LanguageModelV4Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user") continue;
    const text = m.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n")
      .trim();
    const files = m.content.filter((p) => p.type === "file").length;
    return files ? `${text}\n\n[${files} attachment${files > 1 ? "s" : ""} not passed on: this Hermes bot takes text only]`.trim() : text;
  }
  return "";
}

export function newestNativeText(prompt: LanguageModelV4Prompt): string {
  const message = [...prompt].reverse().find(m => m.role === 'user');
  return message?.role === 'user' ? message.content.filter(p => p.type === 'text').map(p => p.type === 'text' ? p.text : '').join('\n').trim() : '';
}
/** Resolved inline bytes only. Never fetch a browser URL, provider URL, or local path. */
export function newestNativeAttachments(prompt: LanguageModelV4Prompt): NativeAttachment[] {
  const message = [...prompt].reverse().find(m => m.role === 'user');
  if (message?.role !== 'user') return [];
  return nativeAttachments.parse(message.content.filter(p => p.type === 'file').map(p => {
    if (p.type !== 'file') throw new HermesError('rejected', 400, 'Invalid attachment');
    let bytes: Buffer;
    const tagged = p.data;
    if (tagged.type === 'text') bytes = Buffer.from(tagged.text, 'utf8');
    else if (tagged.type === 'data' || (tagged.type === 'url' && tagged.url.protocol === 'data:')) {
      const encoded = tagged.type === 'url' ? tagged.url.href : tagged.data;
      if (encoded instanceof Uint8Array) bytes = Buffer.from(encoded);
      else {
        if (encoded.startsWith('data:') && !encoded.startsWith(`data:${p.mediaType};base64,`)) throw new HermesError('rejected', 400, 'Attachment media type does not match its inline bytes.');
        const data = encoded.startsWith('data:') ? encoded.slice(encoded.indexOf(',') + 1) : encoded;
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new HermesError('rejected', 400, 'Attachment bytes must be resolved before sending to Hermes.');
        bytes = Buffer.from(data, 'base64');
      }
    } else throw new HermesError('rejected', 400, 'Hermes cannot fetch attachment URLs or provider references.');
    return { name: p.filename || 'attachment', mediaType: p.mediaType, contentBase64: bytes.toString('base64') };
  }));
}

export const systemText = (prompt: LanguageModelV4Prompt) =>
  prompt
    .filter((m) => m.role === "system")
    .map((m) => (m as { content: string }).content)
    .join("\n\n")
    .trim();

/** Approval answers in the trailing tool message (older answers are repeated in history; parked runs tell them apart). */
export function approvalAnswers(prompt: LanguageModelV4Prompt): ApprovalAnswer[] {
  const last = prompt.at(-1);
  if (last?.role !== "tool") return [];
  const out: ApprovalAnswer[] = [];
  for (const part of last.content) {
    if (part.type !== "tool-approval-response") continue;
    const a = parseApprovalId(part.approvalId);
    if (a) out.push({ ...a, approved: part.approved, reason: part.reason });
  }
  return out;
}

/** The dynamic tool name the portal gave a call (to rebuild pairing state when no parked run is left). */
function toolOfCall(prompt: LanguageModelV4Prompt, toolCallId: string): string {
  for (const m of prompt) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) if (p.type === "tool-call" && p.toolCallId === toolCallId) return p.toolName.replace(/^hermes__/, "");
  }
  return "terminal";
}

export class HermesLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "hermes";
  readonly modelId: string;
  readonly supportedUrls = {};
  private readonly ctx: HermesTurnContext;

  constructor(modelId: string, ctx: HermesTurnContext) {
    this.modelId = modelId;
    this.ctx = ctx;
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    // The consumer may cancel (Stop) while Hermes is still sending: writes after that are dropped, never thrown.
    let closed = false;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (controller) => {
        const emit: Emit = (p) => {
          if (closed) return;
          try {
            controller.enqueue(p);
          } catch {
            closed = true;
          }
        };
        emit({ type: "stream-start", warnings: [] });
        void this.drive(options, emit)
          .catch((error: unknown) => {
            emit({ type: "error", error });
            emit({ type: "finish", finishReason: { unified: "error", raw: undefined }, usage: EMPTY_USAGE });
          })
          .finally(() => {
            if (closed) return;
            closed = true;
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          });
      },
      cancel: () => {
        closed = true;
      },
    });
    return { stream };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { stream } = await this.doStream(options);
    const content: LanguageModelV4Content[] = [];
    const texts = new Map<string, { type: "text"; text: string }>();
    let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
    const reader = stream.getReader();
    for (;;) {
      const { done, value: p } = await reader.read();
      if (done) break;
      if (p.type === "text-start") {
        const t = { type: "text" as const, text: "" };
        texts.set(p.id, t);
        content.push(t);
      } else if (p.type === "text-delta") texts.get(p.id)!.text += p.delta;
      else if (p.type === "tool-call" || p.type === "tool-result" || p.type === "tool-approval-request") content.push(p);
      else if (p.type === "error") throw p.error;
      else if (p.type === "finish") finish = p;
    }
    return {
      content,
      finishReason: finish?.finishReason ?? { unified: "other", raw: undefined },
      usage: finish?.usage ?? EMPTY_USAGE,
      providerMetadata: finish?.providerMetadata,
      warnings: [],
    };
  }

  private async drive(options: LanguageModelV4CallOptions, emit: Emit) {
    const answers = approvalAnswers(options.prompt);
    const signal = options.abortSignal;
    if (signal?.aborted) {
      // Stopped before anything was sent (e.g. Stop while the continuation was being set up): post no answer, and stop
      // the Hermes run that was waiting for it.
      if (answers.length) this.abandon();
      emit({ type: "finish", finishReason: { unified: "other", raw: "stopped" }, usage: EMPTY_USAGE });
      return;
    }
    const run = answers.length ? await this.resume(options.prompt, answers) : await this.begin(options.prompt);
    await this.consume(run, emit, signal);
  }

  /** Stops this portal run's own Hermes run (held stream or saved state), never one named only by the prompt. */
  private abandon() {
    const { run, target } = this.ctx;
    if (!run) return;
    if (dropParkedForAgentRun(run.id)) return;
    const saved = run.resumeState?.hermes;
    if (saved) void stopRun(target, saved.runId).catch(() => {});
  }

  /** A new turn: stop runs of this conversation still waiting on an unanswered approval, then start one. */
  private async begin(prompt: LanguageModelV4Prompt) {
    const { target, sessionId, sessionKey } = this.ctx;
    if (sessionId) {
      for (const stale of parkedForSession(sessionId)) {
        unpark(stale.runId);
        stale.tap.close();
        void stopRun(stale.target, stale.runId).catch(() => {});
      }
    }
    const attachments = newestNativeAttachments(prompt);
    const input = newestNativeText(prompt);
    if (!input && !attachments.length) throw new HermesError("rejected", 400, "There's no message to send.");
    const runId = await startRun(target, {
      input,
      attachments,
      sessionId,
      instructions: target.local ? undefined : systemText(prompt) || undefined,
      idempotencyKey: this.ctx.run ? `portal-${this.ctx.run.id}` : `portal-${randomUUID()}`,
      sessionKey,
      model: this.ctx.requestedModel,
      // No abort signal: once Hermes has the run its id must come back, so a Stop meanwhile can stop it (consume()).
    });
    // Recorded at once, so the run can be stopped if the portal run ends abnormally (e.g. its worker dies).
    try {
      await this.ctx.run?.noteProviderRun?.({ hermes: { runId } });
    } catch (err) {
      await stopRun(target, runId).catch(() => {});
      throw err;
    }
    return { runId, tap: this.tap(runId), mapper: HermesMapper.fresh(runId, this.ctx.approvalTimeoutSec) };
  }

  /**
   * Continues a run after someone answered its approval (posting the answer to Hermes first). Only this portal run's
   * own Hermes run is continued, in order of preference: the stream this process held at the run's latest pause; the
   * resume state saved with that pause (exact pairing, re-attached after the last event read); and, only for a run
   * from before durable runs (no saved state), pairing rebuilt from the prompt for the newest answer. A Hermes run id
   * that merely appears in the prompt (e.g. in a copied chat) is never acted on otherwise.
   */
  private async resume(prompt: LanguageModelV4Prompt, answers: ApprovalAnswer[]) {
    const { target, run } = this.ctx;
    const byRun = new Map<string, ApprovalAnswer[]>();
    for (const a of answers) {
      const runId = runIdOfApproval(a.approvalId)!;
      byRun.set(runId, [...(byRun.get(runId) ?? []), a]);
    }
    const saved = run?.resumeState?.hermes;
    let entry: ParkedRun | undefined;
    if (run) {
      const held = parkedForAgentRun(run.id);
      if (held) {
        unpark(held.runId);
        // Held at this run's latest pause (another worker may have paused it again since, saving newer state)?
        const current = byRun.has(held.runId) && (!saved || (saved.runId === held.runId && saved.segment === held.segment));
        if (current) entry = held;
        else held.tap.close();
      }
    } else {
      // No portal run (tests, or a caller outside the run executor): the stream held for the answered run, if any.
      const parkedRunId = [...byRun.keys()].reverse().find(isParked);
      entry = parkedRunId ? unpark(parkedRunId) : undefined;
    }
    let runId: string;
    let mine: ApprovalAnswer[];
    let mapper: HermesMapper;
    let tap: () => EventTap;
    if (entry) {
      runId = entry.runId;
      mine = byRun.get(runId)!;
      mapper = new HermesMapper(entry.state);
      const held = entry.tap;
      tap = () => held;
    } else if (saved?.state && byRun.has(saved.runId)) {
      runId = saved.runId;
      mine = byRun.get(runId)!;
      mapper = new HermesMapper(structuredClone(saved.state));
      tap = () => this.tap(runId, saved.lastEventId);
    } else if (!run || run.legacy) {
      runId = runIdOfApproval(answers.at(-1)!.approvalId)!;
      mine = [answers.at(-1)!];
      mapper = new HermesMapper({
        runId,
        open: mine.map((a) => ({ id: a.toolCallId, tool: toolOfCall(prompt, a.toolCallId) })),
        denied: [],
        counter: Math.max(0, ...mine.map((a) => Number(/_(\d+)$/.exec(a.toolCallId)?.[1] ?? 0))),
        approvalTimeoutSec: this.ctx.approvalTimeoutSec,
      });
      tap = () => this.tap(runId);
    } else {
      throw new HermesError("not_found", 404, "This approval can't be continued any more. Send a new message instead.");
    }
    const answered = new Map<string, "resolved" | "not_pending">();
    try {
      for (const a of mine) {
        if (!a.approved) mapper.denied(a.toolCallId);
        // "not_pending" (Hermes' timeout, or answered twice) isn't an error: the run's own events say what happened.
        answered.set(a.toolCallId, await answerApproval(target, runId, a.requestId, a.approved ? "once" : "deny"));
      }
    } catch (err) {
      // Hermes couldn't take the answer (unreachable, key changed): this turn fails, so don't leave the run waiting.
      entry?.tap.close();
      void stopRun(target, runId).catch(() => {});
      throw err;
    }
    return { runId, tap: tap(), mapper, answered };
  }

  private tap(runId: string, lastEventId?: string) {
    return new EventTap((signal) => runEvents(this.ctx.target, runId, { signal, lastEventId }), lastEventId);
  }

  private async consume(
    run: { runId: string; tap: EventTap; mapper: HermesMapper; answered?: Map<string, "resolved" | "not_pending"> },
    emit: Emit,
    signal?: AbortSignal,
  ) {
    const { target, interactive } = this.ctx;
    const { runId, mapper } = run;
    let tap = run.tap;
    let parked = false;
    let settled = false;
    const onAbort = () => {
      if (parked || settled) return;
      void stopRun(target, runId).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Aborted while the answer was being posted or the run started: the listener above won't fire any more.
    if (signal?.aborted) onAbort();
    const out = (parts: LanguageModelV4StreamPart[]) => parts.forEach(emit);
    let fromStatus = false;
    try {
      for (;;) {
        if (signal?.aborted) {
          out(mapper.finish());
          emit({ type: "finish", finishReason: { unified: "other", raw: "stopped" }, usage: EMPTY_USAGE });
          return;
        }
        let next: HermesEvent | "idle" | null;
        try {
          next = await tap.next(mapper.holding ? HOLD_MS : undefined);
        } catch (err) {
          // The event stream is gone (older Hermes keeps it for its first subscriber only): use the run's status.
          if (!(err instanceof HermesError) || err.code !== "not_found") throw err;
          next = null;
        }
        if (next === "idle") {
          out(mapper.flushHeld());
          continue;
        }
        if (next === null) {
          next = await this.settle(runId, signal);
          if (!next) throw new HermesError("not_found", 404, "The run's result isn't available any more.");
          fromStatus = true;
          tap = new EventTap(async function* () {}, tap.lastSeq); // nothing more to read
        }
        const step = mapper.onEvent(next);
        if (step.approval && !interactive) {
          // Nobody can answer here: deny, and let Hermes carry on (its tool shows up as blocked).
          out(step.parts.filter((p) => p.type !== "tool-approval-request"));
          await answerApproval(target, runId, step.approval.requestId, "deny").catch(() => {});
          continue;
        }
        out(step.parts);
        if (step.approval) {
          const { run } = this.ctx;
          // Held here for a continuation in this process (unless the registry is full); saved with the pause for one
          // anywhere else, or after a restart.
          parked = park(
            { runId, sessionId: this.ctx.sessionId, target, tap, state: mapper.state, agentRunId: run?.id, segment: run?.segment },
            holdTtlMs(this.ctx.approvalTimeoutSec),
          );
          run?.saveResumeState({ hermes: { runId, lastEventId: tap.lastSeq, state: structuredClone(mapper.state), segment: run.segment } });
          out(mapper.finish());
          emit({ type: "finish", finishReason: { unified: "tool-calls", raw: "waiting_for_approval" }, usage: EMPTY_USAGE });
          return;
        }
        if (step.outcome) {
          settled = true;
          // Known only from the run's status: its tool events are lost, so say what is known about the calls still open
          // (an approved command did run unless Hermes had already denied it at its time limit).
          if (fromStatus) out(mapper.closeOpen((id) => lostResult(run.answered?.get(id))));
          out(mapper.finish());
          if (step.outcome.kind === "failed") throw new HermesError("run_failed", 502, step.outcome.error);
          if (step.outcome.kind === "cancelled") {
            emit({ type: "finish", finishReason: { unified: "other", raw: "cancelled" }, usage: EMPTY_USAGE });
            return;
          }
          const { usage, runtime } = step.outcome;
          emit({
            type: "finish",
            finishReason: { unified: "stop", raw: "completed" },
            usage,
            providerMetadata: { hermes: { runId, provider: runtime.provider ?? null, model: runtime.model ?? null } },
          });
          return;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!parked) tap.close();
    }
  }

  /**
   * The run's outcome from its status when its events can't be read: polls until it ends or asks for approval, and
   * turns that into the matching event.
   */
  private async settle(runId: string, signal?: AbortSignal): Promise<HermesEvent | null> {
    const deadline = Date.now() + (this.ctx.approvalTimeoutSec + 600) * 1000;
    let status: HermesRunStatus;
    for (;;) {
      status = await getRun(this.ctx.target, runId).catch((err) => {
        if (err instanceof HermesError && err.code === "not_found") return { run_id: runId, status: "unknown" };
        throw err;
      });
      if (TERMINAL.has(status.status) || status.status === "waiting_for_approval" || status.status === "unknown") break;
      if (signal?.aborted || Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (status.status === "unknown") return null;
    if (status.status === "waiting_for_approval" && status.approval) return { ...status.approval, event: "approval.request" };
    return { ...status, event: `run.${status.status}` } as HermesEvent;
  }
}
