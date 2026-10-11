import { newId } from "@/lib/ids";
import { compactTranscript, orderedFragments, reactionContext, reactionEvidence, reactionIsFresh, REACTION_CONFIDENCE, REACTIONS, type Reaction, type VoiceFragment } from "./policy";
import { voiceHistory, type VoiceHistoryMessage } from "./history";
import { isPulse, legacyPlan, legacyReaction, reactionPlanSchema, reactionPreserveSchema, resolveReactionPlan, type ReactionPlan } from "./reaction-library";
import type { VoiceReactionDiagnostics } from "./reaction-diagnostics";

type LiveEvent = { type?: string; event_id?: string; client_event_id?: string; delta?: string; start_ms?: number; end_ms?: number; offset_ms?: number; delegation?: { id?: string; target?: string } };
type Options = {
  fetcher?: typeof fetch;
  conversationId: string; sessionId: string; reactions: boolean;
  history?: readonly VoiceHistoryMessage[];
  reactionDiagnostics?: VoiceReactionDiagnostics;
  send: (event: Record<string, unknown>) => void;
  changed: () => void; transcript: (fragments: VoiceFragment[]) => void;
  reaction: (reaction: Reaction, latencyMs: number, plan?: ReactionPlan, motionRevision?: number) => void;
  notice: (message: string) => void; approval: () => void;
};
type Batch = { conversationId: string; sessionId: string; batchId: string; fragments: VoiceFragment[]; delegate: boolean };
type Delegation = { id: string; offset: number; at: number; generation: number };
type PendingResult = { messageId: string; delegationId: string; generation: number; userRevision: number };
const TRANSCRIPT_SETTLE_MS = 750;
const SILENT_GAP_SETTLE_MS = 1800;
const TRANSCRIPT_WAIT_MS = 3000;
const TIMELINE_TOLERANCE_MS = 250;

/** Independent of rendering: one bot request at a time, durable identities, no tools from partial STT. */
export class VoiceBridge {
  private pending: VoiceFragment[] = [];
  private history: VoiceFragment[] = [];
  private seen = new Set<string>();
  private delegations = new Set<string>();
  private queue: Delegation[] = [];
  private task: Promise<void> | null = null;
  private savedBatch: Batch | null = null;
  private savedDelegation: string | null = null;
  private pendingResult: PendingResult | null = null;
  private savedRequest: PendingResult | null = null;
  private generation = 0;
  private userRevision = 0;
  private lastUserArrival = 0;
  private admittedThrough = -1;
  private redirected = false;
  private contextMessages = new Map<string, string>();
  private appends = new Set<string>();
  private finishing: Promise<void> | null = null;
  get hasUnsaved() { return !!this.savedBatch || this.pending.length > 0; }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reactionAbort: AbortController | null = null;
  private reactionDwell: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private disposed = false;
  private revision = 0;
  private gesture: Reaction = "neutral";
  private gesturePlan = legacyPlan("neutral");
  private lastPulseAt = 0;
  private pulseCooldownMs = 3000;
  private motionRevision = 0;
  private gestureAt = 0;
  private lastReactionAt = 0;
  private wake: (() => void) | null = null;
  constructor(private options: Options) {
    for (const message of options.history ?? []) this.contextMessages.set(message.id, message.text);
    options.reaction("neutral", 0, this.gesturePlan, this.motionRevision); // Session reset shares the same motion token namespace.
  }

  receive(event: LiveEvent) {
    if (this.stopped) return;
    if (event.client_event_id && this.appends.has(event.client_event_id) && (event.type?.endsWith(".appended") || event.type === "error")) {
      this.appends.delete(event.client_event_id);
      if (event.type === "error") this.options.notice("A voice update could not be delivered. Check the saved chat for the verified result.");
      return true; // A rejected append is not a transport failure or permission to repeat an action.
    }
    if (event.event_id && this.seen.has(event.event_id)) return;
    if (event.event_id) this.seen.add(event.event_id);
    if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      if (!event.delta || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms! < 0 || event.end_ms! < event.start_ms!) return;
      const fragment: VoiceFragment = { id: event.event_id ?? newId(), role: event.type === "session.input_transcript.delta" ? "user" : "assistant",
        text: event.delta, startMs: event.start_ms!, endMs: event.end_ms! };
      this.pending.push(fragment);
      if (fragment.role === "user") {
        this.userRevision++; this.lastUserArrival = Date.now();
        if ((this.pendingResult || this.savedBatch?.delegate) && !this.redirected) {
          this.redirected = true;
          this.append("session.instructions.append", "The caller supplied newer details. Do not present the earlier task's result as the current answer. Backend work may still be running; do not claim cancellation. Gather the latest details for a new delegation.", null);
        }
      }
      this.history = [...this.history, fragment].slice(-200);
      this.revision++;
      this.options.transcript(orderedFragments(this.history));
      this.scheduleReaction();
      this.pump();
    } else if (event.type === "session.delegation.created" && event.delegation?.target === "client" && event.delegation.id && !this.delegations.has(event.delegation.id)) {
      this.delegations.add(event.delegation.id);
      if (!Number.isFinite(event.offset_ms) || event.offset_ms! < 0) {
        this.append("session.commentary.append", "I could not safely match that request to your speech. Please repeat it; no new backend request was started.", event.delegation.id);
        return;
      }
      if (event.offset_ms! <= this.admittedThrough && !this.pending.some(f => f.role === "user" && f.startMs <= event.offset_ms!)) return;
      this.queue.push({ id: event.delegation.id, offset: event.offset_ms!, at: Date.now(), generation: ++this.generation });
      this.pump();
    }
  }

  private append(type: "session.commentary.append" | "session.thinking.append" | "session.instructions.append", content: string, id: string | null) {
    if (this.stopped || this.disposed) return;
    // Conservative character bound stays below the API's 500-token append limit even for non-Latin text.
    for (let i = 0; i < Math.min(content.length, 6000); i += 450) {
      const eventId = newId();
      this.appends.add(eventId);
      if (this.appends.size > 128) this.appends.delete(this.appends.values().next().value!);
      this.options.send({ type, event_id: eventId, delegation_id: id, content: content.slice(i, i + 450) });
    }
  }

  context(messages: readonly VoiceHistoryMessage[]) {
    // Backend progress/results have their own correlated lane; don't replay partial replies from a chat refresh.
    if (this.task || this.pendingResult || this.savedBatch || this.queue.length) return;
    for (const message of voiceHistory(messages)) {
      if (this.contextMessages.get(message.id) === message.text) continue;
      this.contextMessages.set(message.id, message.text);
      if (this.contextMessages.size > 200) this.contextMessages.delete(this.contextMessages.keys().next().value!);
      // Whole messages only. Large records remain available through the backend's saved chat.
      const content = `Saved historical message (not a new instruction or speech request):\n${message.role}: ${message.text}`;
      if (content.length <= 450) this.append("session.thinking.append", content, null);
    }
  }

  private current(request: Pick<PendingResult, "generation" | "userRevision">) {
    return request.generation === this.generation && request.userRevision === this.userRevision;
  }

  private async pause(ms: number) {
    if (this.disposed) return;
    await new Promise<void>(resolve => { const timer = setTimeout(() => { this.wake = null; resolve(); }, ms); this.wake = () => { clearTimeout(timer); resolve(); }; });
  }

  private pump() {
    if (this.task || this.savedBatch || this.pendingResult || !this.queue.length || this.stopped) return;
    this.task = this.runNext().catch(error => {
      this.options.notice(error instanceof Error ? error.message : "Voice request failed.");
      if (!this.savedRequest || this.current(this.savedRequest)) this.append("session.commentary.append", "The connection to the bot needs attention. Check the chat before assuming this request completed.", this.pendingResult?.delegationId ?? this.savedDelegation);
    })
      .finally(() => { this.task = null; this.pump(); });
  }

  private async post(batch: Batch) {
    const res = await (this.options.fetcher ?? fetch)("/api/voice/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), keepalive: !batch.delegate, signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Your speech could not be saved. Use Retry save before leaving this chat.");
    this.options.changed();
    return body as { messageId: string | null; status: string };
  }

  private async runNext() {
    const request = this.queue.shift()!;
    if (request.generation !== this.generation) return;
    const waitStarted = Date.now(); // Time spent behind a running task is not transcript delivery time.
    // Live supplies no completed-turn event. Near-offset user coverage permits a shorter delivery
    // window; delegation after silence needs longer quiescence, not assistant-text coverage.
    // This bounded settling is not proof of utterance completion. Backend clarification/permissions
    // remain authoritative. Reactions and listening remain independent of this admission wait.
    let ready = false;
    while (!this.stopped && request.generation === this.generation && Date.now() - waitStarted < TRANSCRIPT_WAIT_MS) {
      const eligible = this.pending.filter(f => f.startMs <= request.offset);
      const nearUserCoverage = eligible.some(f => f.role === "user" && f.endMs >= request.offset - TIMELINE_TOLERANCE_MS);
      ready = eligible.some(f => f.role === "user" && f.text.trim()) &&
        !this.pending.some(f => f.role === "user" && f.startMs > request.offset) &&
        Date.now() - Math.max(request.at, this.lastUserArrival) >= (nearUserCoverage ? TRANSCRIPT_SETTLE_MS : SILENT_GAP_SETTLE_MS);
      if (ready) break;
      await this.pause(100);
    }
    if (this.stopped) return;
    if (request.generation !== this.generation) return; // A queued correction owns the unadmitted speech.
    const fragments = this.pending.filter(f => f.startMs <= request.offset);
    if (!ready) {
      this.append("session.commentary.append", "I have not received enough of that request to send it safely. Please repeat or finish the details; no new backend request was started.", request.id);
      return;
    }
    const ids = new Set(fragments.map(f => f.id));
    this.pending = this.pending.filter(f => !ids.has(f.id));
    const batch: Batch = { conversationId: this.options.conversationId, sessionId: this.options.sessionId, batchId: newId(), fragments: compactTranscript(fragments), delegate: true };
    this.savedDelegation = request.id;
    this.admittedThrough = Math.max(this.admittedThrough, request.offset);
    this.savedRequest = { messageId: "", delegationId: request.id, generation: request.generation, userRevision: this.userRevision };
    this.redirected = false;
    this.savedBatch = batch; // Retain the exact request on unknown outcomes; never generate a fresh identity for retries.
    this.append("session.instructions.append", "The backend is working on the current request. Until its verified result arrives, use only brief acknowledgments or clarification questions. Do not answer dependent questions or claim tool completion. New details or corrections need a new delegation; never retry the original action yourself.", request.id);
    const result = await this.post(batch);
    this.savedBatch = null; this.savedDelegation = null;
    if (result.messageId) await this.waitForResult({ ...this.savedRequest, messageId: result.messageId });
    this.savedRequest = null;
  }

  private async waitForResult(request: PendingResult) {
    const { messageId, delegationId } = request;
    this.pendingResult = request;
    this.append("session.thinking.append", "The bot is working on your request. No action is confirmed yet.", delegationId);
    let approvalShown = false;
    while (!this.disposed) {
      const res = await (this.options.fetcher ?? fetch)(`/api/voice/turn?${new URLSearchParams({ conversationId: this.options.conversationId, messageId })}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not read the bot’s result. Check the saved chat.");
      if (body.status === "waiting" && !approvalShown) {
        approvalShown = true;
        if (this.current(request)) this.append("session.commentary.append", "This action needs your approval. Review the approval card in chat.", delegationId);
        this.options.approval(); this.options.changed();
      }
      if (body.status !== "waiting") approvalShown = false;
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(body.status)) {
        const content = body.status === "succeeded" ? body.text || "The bot finished without a text reply. Check the chat for its output."
          : `The bot request ${body.status}. ${body.text || "Check the saved chat for details."}`;
        // Keep obsolete facts in the saved chat, never speak them as the answer to a correction.
        const excerpt = content.length > 5500 ? `${content.slice(0, 2500)}\n[Middle omitted; full result is in chat.]\n${content.slice(-3000)}` : content;
        if (this.current(request)) {
          this.append("session.instructions.append", "The current backend reply is available. Report only its verified facts. A finished reply does not mean every requested action succeeded. Continue listening; delegate any new substantive request before answering it.", delegationId);
          if (content.length <= 350) this.append("session.commentary.append", `Backend reply (${body.status}):\n${content}`, delegationId);
          else {
            this.append("session.thinking.append", excerpt, delegationId);
            this.append("session.commentary.append", `The backend reply is ${body.status}. Its detailed result is in the saved chat. Review that result before assuming a specific action completed.`, delegationId);
          }
        } else this.append("session.thinking.append", `Earlier backend reply is ${body.status}. The caller supplied newer details; this is not the current answer. Its result remains in the saved chat. This does not confirm cancellation or reversal.`, delegationId);
        this.options.changed();
        this.pendingResult = null;
        break;
      }
      if (this.stopped) { this.pendingResult = null; break; }
      await this.pause(900);
    }
  }

  private scheduleReaction() {
    if (!this.options.reactions || this.timer || this.reactionAbort || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void this.decideReaction(); }, Math.max(0, 450 - (Date.now() - this.lastReactionAt)));
  }

  private async decideReaction() {
    const revision = this.revision;
    const evidence = reactionEvidence(this.history);
    if (this.stopped || !evidence) return;
    const controller = new AbortController();
    this.reactionAbort = controller;
    const started = Date.now();
    this.options.reactionDiagnostics?.record("request", 0);
    this.lastReactionAt = started;
    // Bound the entire client request, including a native bridge that may ignore abort delivery.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([
        (async () => {
          const res = await (this.options.fetcher ?? fetch)("/api/voice/reaction", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ conversationId: this.options.conversationId, context: reactionContext(this.history, this.gesture), revision, libraryVersion: 1, currentPlan: this.gesturePlan }) });
          return res.ok ? await res.json() : null;
        })(),
        new Promise<null>(resolve => { deadline = setTimeout(() => { controller.abort(); this.options.reactionDiagnostics?.record("timeout", 1400); resolve(null); }, 1400); }),
      ]);
      if (!body || this.stopped) return;
      if (body.revision !== revision || !REACTIONS.includes(body.reaction)) { this.options.reactionDiagnostics?.record("invalid", Date.now() - started); return; }
      if (!reactionIsFresh(evidence, reactionEvidence(this.history), Date.now() - started)) { this.options.reactionDiagnostics?.record("stale", Date.now() - started); return; }
      if (body.reaction !== "keep_current" && body.confidence !== undefined && (!Number.isFinite(body.confidence) || body.confidence < REACTION_CONFIDENCE)) { this.options.reactionDiagnostics?.record("confidence", Date.now() - started); return; }
      const parsedPlan = body.plan === undefined ? null : reactionPlanSchema.safeParse(body.plan);
      if (parsedPlan && !parsedPlan.success) { this.options.reactionDiagnostics?.record("invalid", Date.now() - started); return; }
      const parsedPreserve = reactionPreserveSchema.safeParse(body.preserve ?? { face: false, motion: false });
      if (!parsedPreserve.success) { this.options.reactionDiagnostics?.record("invalid", Date.now() - started); return; }
      const preserve = parsedPreserve.data;
      const candidate = parsedPlan?.success ? parsedPlan.data : undefined;
      let plan = candidate ? resolveReactionPlan(candidate, this.gesturePlan, preserve) : undefined;
      let pulse = plan ? !preserve.motion && isPulse(plan.gesture) && body.replay === true : body.reaction === "nod";
      if (pulse && Date.now() - this.lastPulseAt < this.pulseCooldownMs) {
        this.options.reactionDiagnostics?.record("cooldown", Date.now() - started);
        if (!plan) return;
        // A motion cooldown must never suppress a fresh face after new conversational meaning.
        plan = { ...plan, gesture: this.gesturePlan.gesture, tempo: this.gesturePlan.tempo, durationMs: this.gesturePlan.durationMs };
        pulse = false;
      }
      const same = plan ? JSON.stringify(plan) === JSON.stringify(this.gesturePlan) : body.reaction === this.gesture;
      const repeat = pulse && Date.now() - this.lastPulseAt >= this.pulseCooldownMs;
      if (this.reactionDwell) clearTimeout(this.reactionDwell);
      this.reactionDwell = null;
      if (body.reaction === "keep_current" || (same && !repeat)) { this.options.reactionDiagnostics?.record("unchanged", Date.now() - started); return; }
      const apply = () => {
        if (this.stopped || !reactionIsFresh(evidence, reactionEvidence(this.history), Date.now() - started)) return;
        // A prior deferred reaction may have applied while this request was in flight.
        // Rebase preserved channels at application time, not against the stale request snapshot.
        if (candidate) plan = resolveReactionPlan(candidate, this.gesturePlan, preserve);
        pulse = plan ? !preserve.motion && isPulse(plan.gesture) && body.replay === true : body.reaction === "nod";
        if (pulse && Date.now() - this.lastPulseAt < this.pulseCooldownMs) {
          if (!plan) return;
          plan = { ...plan, gesture: this.gesturePlan.gesture, tempo: this.gesturePlan.tempo, durationMs: this.gesturePlan.durationMs }; pulse = false;
        }
        this.gesture = plan ? legacyReaction(plan.face) : body.reaction; this.gestureAt = Date.now();
        this.options.reactionDiagnostics?.record("accepted", Date.now() - started);
        if (pulse) { this.lastPulseAt = Date.now(); this.pulseCooldownMs = plan ? Math.max(3000, plan.durationMs / plan.tempo + 350) : 3000; }
        if (plan) {
          if (plan.gesture !== this.gesturePlan.gesture || pulse) this.motionRevision++;
          this.gesturePlan = plan; this.options.reaction(this.gesture, Date.now() - started, plan, this.motionRevision);
        }
        else { this.gesturePlan = legacyPlan(this.gesture); this.options.reaction(this.gesture, Date.now() - started); }
      };
      const dwell = 900 - (Date.now() - this.gestureAt);
      if (dwell > 0) { this.options.reactionDiagnostics?.record("deferred", dwell); this.reactionDwell = setTimeout(() => { this.reactionDwell = null; apply(); }, dwell); }
      else apply();
    } catch { /* Reactions never block conversation. */ }
    finally { clearTimeout(deadline); this.reactionAbort = null; if (revision !== this.revision) this.scheduleReaction(); }
  }

  async flush() {
    if (this.task) await this.task;
    if (this.savedBatch) {
      // A correction after an unknown HTTP outcome must not newly admit the old physical action.
      // The server returns an existing run for the same identity even for a save-only retry.
      const batch = this.stopped || (this.savedRequest && !this.current(this.savedRequest)) ? { ...this.savedBatch, delegate: false } : this.savedBatch;
      const result = await this.post(batch);
      const id = this.savedDelegation;
      const request = this.savedRequest;
      this.savedBatch = null; this.savedDelegation = null;
      if (!this.stopped && result.messageId && id && request) {
        this.task = this.waitForResult({ ...request, messageId: result.messageId }).finally(() => { this.task = null; this.savedRequest = null; this.pump(); });
        await this.task;
      }
    }
    if (!this.stopped && this.pendingResult) {
      const pending = this.pendingResult;
      this.task = this.waitForResult(pending).finally(() => { this.task = null; this.savedRequest = null; this.pump(); });
      await this.task;
    }
    if (!this.stopped && this.queue.length) { this.pump(); return; }
    if (!this.pending.length) { this.pump(); return; }
    const batch: Batch = { conversationId: this.options.conversationId, sessionId: this.options.sessionId, batchId: newId(), fragments: compactTranscript(this.pending), delegate: false };
    this.pending = []; this.savedBatch = batch;
    await this.post(batch); this.savedBatch = null;
    this.pump();
  }

  finish() {
    if (this.finishing) return this.finishing;
    this.stopped = true; this.queue = [];
    this.options.reactionDiagnostics?.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.reactionDwell) clearTimeout(this.reactionDwell);
    this.reactionAbort?.abort(); this.wake?.();
    this.finishing = (async () => { await this.task; await this.flush(); })();
    return this.finishing;
  }

  dispose() {
    this.disposed = true; this.stopped = true; this.queue = [];
    this.options.reactionDiagnostics?.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.reactionDwell) clearTimeout(this.reactionDwell);
    this.reactionAbort?.abort(); this.wake?.();
  }
}
