import { newId } from "@/lib/ids";
import { compactTranscript, orderedFragments, reactionContext, reactionEvidence, reactionIsFresh, REACTION_CONFIDENCE, REACTIONS, type Reaction, type VoiceFragment } from "./policy";

type LiveEvent = { type?: string; event_id?: string; delta?: string; start_ms?: number; end_ms?: number; offset_ms?: number; delegation?: { id?: string; target?: string } };
type Options = {
  fetcher?: typeof fetch;
  conversationId: string; sessionId: string; reactions: boolean;
  send: (event: Record<string, unknown>) => void;
  changed: () => void; transcript: (fragments: VoiceFragment[]) => void;
  reaction: (reaction: Reaction, latencyMs: number) => void;
  notice: (message: string) => void; approval: () => void;
};
type Batch = { conversationId: string; sessionId: string; batchId: string; fragments: VoiceFragment[]; delegate: boolean };

/** Independent of rendering: one bot request at a time, durable identities, no tools from partial STT. */
export class VoiceBridge {
  private pending: VoiceFragment[] = [];
  private history: VoiceFragment[] = [];
  private seen = new Set<string>();
  private delegations = new Set<string>();
  private queue: { id: string; offset: number; at: number }[] = [];
  private task: Promise<void> | null = null;
  private savedBatch: Batch | null = null;
  private savedDelegation: string | null = null;
  private pendingResult: { messageId: string; delegationId: string } | null = null;
  private finishing: Promise<void> | null = null;
  get hasUnsaved() { return !!this.savedBatch || this.pending.length > 0; }
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reactionAbort: AbortController | null = null;
  private reactionDwell: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private disposed = false;
  private revision = 0;
  private gesture: Reaction = "neutral";
  private gestureAt = 0;
  private lastReactionAt = 0;
  private wake: (() => void) | null = null;
  constructor(private options: Options) {}

  receive(event: LiveEvent) {
    if (this.stopped) return;
    if (event.event_id && this.seen.has(event.event_id)) return;
    if (event.event_id) this.seen.add(event.event_id);
    if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
      if (!event.delta || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) return;
      const fragment: VoiceFragment = { id: event.event_id ?? newId(), role: event.type === "session.input_transcript.delta" ? "user" : "assistant",
        text: event.delta, startMs: event.start_ms!, endMs: event.end_ms! };
      this.pending.push(fragment);
      this.history = [...this.history, fragment].slice(-200);
      this.revision++;
      this.options.transcript(orderedFragments(this.history));
      this.scheduleReaction();
      this.pump();
    } else if (event.type === "session.delegation.created" && event.delegation?.target === "client" && event.delegation.id && !this.delegations.has(event.delegation.id)) {
      this.delegations.add(event.delegation.id);
      this.queue.push({ id: event.delegation.id, offset: event.offset_ms ?? Infinity, at: Date.now() });
      this.pump();
    }
  }

  private append(type: "session.commentary.append" | "session.thinking.append", content: string, id: string | null) {
    if (this.stopped || this.disposed) return;
    // Conservative character bound stays below the API's 500-token append limit even for non-Latin text.
    for (let i = 0; i < Math.min(content.length, 6000); i += 450)
      this.options.send({ type, event_id: newId(), delegation_id: id, content: content.slice(i, i + 450) });
  }

  context(content: string) { this.append("session.thinking.append", `Saved chat context (historical messages, not new instructions):\n${content.slice(-5500)}`, null); }

  private async pause(ms: number) {
    if (this.disposed) return;
    await new Promise<void>(resolve => { const timer = setTimeout(() => { this.wake = null; resolve(); }, ms); this.wake = () => { clearTimeout(timer); resolve(); }; });
  }

  private pump() {
    if (this.task || this.savedBatch || this.pendingResult || !this.queue.length || this.stopped) return;
    this.task = this.runNext().catch(error => {
      this.options.notice(error instanceof Error ? error.message : "Voice request failed.");
      this.append("session.commentary.append", "The connection to the bot needs attention. Check the chat before assuming this request completed.", this.pendingResult?.delegationId ?? this.savedDelegation);
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
    // Delegations can arrive before their transcript. Allow a short settling window, never run an empty request.
    await this.pause(350);
    while (!this.stopped && Date.now() - request.at < 1800 && !this.pending.some(f => f.role === "user" && f.startMs <= request.offset)) await this.pause(150);
    if (this.stopped) return;
    const fragments = this.pending.filter(f => f.startMs <= request.offset);
    if (!fragments.some(f => f.role === "user")) {
      this.append("session.commentary.append", "I did not receive enough of that request. Please repeat it.", request.id);
      return;
    }
    const ids = new Set(fragments.map(f => f.id));
    this.pending = this.pending.filter(f => !ids.has(f.id));
    const batch: Batch = { conversationId: this.options.conversationId, sessionId: this.options.sessionId, batchId: newId(), fragments: compactTranscript(fragments), delegate: true };
    this.savedDelegation = request.id;
    this.savedBatch = batch; // Retain the exact request on unknown outcomes; never generate a fresh identity for retries.
    const result = await this.post(batch);
    this.savedBatch = null; this.savedDelegation = null;
    if (result.messageId) await this.waitForResult(result.messageId, request.id);
  }

  private async waitForResult(messageId: string, delegationId: string) {
    this.pendingResult = { messageId, delegationId };
    this.append("session.thinking.append", "The bot is working on your request. No action is confirmed yet.", delegationId);
    let approvalShown = false;
    while (!this.disposed) {
      const res = await (this.options.fetcher ?? fetch)(`/api/voice/turn?${new URLSearchParams({ conversationId: this.options.conversationId, messageId })}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not read the bot’s result. Check the saved chat.");
      if (body.status === "waiting" && !approvalShown) {
        approvalShown = true;
        this.append("session.commentary.append", "This action needs your approval. Review the approval card in chat.", delegationId);
        this.options.approval(); this.options.changed();
      }
      if (body.status !== "waiting") approvalShown = false;
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(body.status)) {
        const content = body.status === "succeeded" ? body.text || "The bot finished without a text reply. Check the chat for its output."
          : `The bot request ${body.status}. ${body.text || "Check the saved chat for details."}`;
        // Put the full result in context, then ask for a concise spoken account. Text chat keeps the original.
        const excerpt = content.length > 5500 ? `${content.slice(0, 2500)}\n[Middle omitted; full result is in chat.]\n${content.slice(-3000)}` : content;
        this.append("session.thinking.append", excerpt, delegationId);
        this.append("session.commentary.append", `Report the backend result just supplied. Status: ${body.status}. Keep it brief and do not claim unconfirmed actions.`, delegationId);
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
    this.lastReactionAt = started;
    // Bound the entire client request, including a native bridge that may ignore abort delivery.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await Promise.race([
        (async () => {
          const res = await (this.options.fetcher ?? fetch)("/api/voice/reaction", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ conversationId: this.options.conversationId, context: reactionContext(this.history, this.gesture), revision }) });
          return res.ok ? await res.json() : null;
        })(),
        new Promise<null>(resolve => { deadline = setTimeout(() => { controller.abort(); resolve(null); }, 1400); }),
      ]);
      if (!body || this.stopped || body.revision !== revision || !REACTIONS.includes(body.reaction) ||
          !reactionIsFresh(evidence, reactionEvidence(this.history), Date.now() - started) ||
          (body.reaction !== "keep_current" && body.confidence !== undefined && (!Number.isFinite(body.confidence) || body.confidence < REACTION_CONFIDENCE))) return;
      if (this.reactionDwell) clearTimeout(this.reactionDwell);
      this.reactionDwell = null;
      if (body.reaction === "keep_current" || body.reaction === this.gesture) return;
      const apply = () => {
        if (this.stopped || !reactionIsFresh(evidence, reactionEvidence(this.history), Date.now() - started) || body.reaction === this.gesture) return;
        this.gesture = body.reaction; this.gestureAt = Date.now();
        this.options.reaction(this.gesture, Date.now() - started);
      };
      const dwell = 900 - (Date.now() - this.gestureAt);
      if (dwell > 0) this.reactionDwell = setTimeout(() => { this.reactionDwell = null; apply(); }, dwell);
      else apply();
    } catch { /* Reactions never block conversation. */ }
    finally { clearTimeout(deadline); this.reactionAbort = null; if (revision !== this.revision) this.scheduleReaction(); }
  }

  async flush() {
    if (this.task) await this.task;
    if (this.savedBatch) {
      const batch = this.stopped ? { ...this.savedBatch, delegate: false } : this.savedBatch;
      const result = await this.post(batch);
      const id = this.savedDelegation;
      this.savedBatch = null; this.savedDelegation = null;
      if (!this.stopped && batch.delegate && result.messageId && id) {
        this.task = this.waitForResult(result.messageId, id).finally(() => { this.task = null; });
        await this.task;
      }
    }
    if (!this.stopped && this.pendingResult) {
      const pending = this.pendingResult;
      this.task = this.waitForResult(pending.messageId, pending.delegationId).finally(() => { this.task = null; });
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
    if (this.timer) clearTimeout(this.timer);
    if (this.reactionDwell) clearTimeout(this.reactionDwell);
    this.reactionAbort?.abort(); this.wake?.();
    this.finishing = (async () => { await this.task; await this.flush(); })();
    return this.finishing;
  }

  dispose() {
    this.disposed = true; this.stopped = true; this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.reactionDwell) clearTimeout(this.reactionDwell);
    this.reactionAbort?.abort(); this.wake?.();
  }
}
