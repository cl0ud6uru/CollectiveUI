import { VoiceBridge } from "./bridge";
import { voiceSessionUrl, waitForIceGathering, waitForVoiceEvent } from "./client";
import { legacyPlan, type ReactionPlan } from "./reaction-library";
import type { ReactionDecisionView } from "./reaction-inspection";
import { reactionUtterances, type VoiceFragment } from "./policy";

export type LiveStudioState = {
  status: "idle" | "connecting" | "listening" | "text" | "error";
  heard: string; decision: ReactionDecisionView | null; error: string | null;
};
type Context = { abort: AbortController; bridge?: VoiceBridge; stream?: MediaStream; peer?: RTCPeerConnection; events?: RTCDataChannel };
type Options = { conversationId: string; changed: (state: LiveStudioState) => void; plan: (plan: ReactionPlan, motionEpoch: number) => void;
  fetcher?: typeof fetch; getMedia?: () => Promise<MediaStream>; createPeer?: () => RTCPeerConnection };

/** User-started listening/typed test. No audio output, saved turns, backend delegation or persistence. */
export class VoiceReactionStudioClient {
  private current: Context | null = null;
  private state: LiveStudioState = { status: "idle", heard: "", decision: null, error: null };
  private motionEpoch = 0;
  constructor(private options: Options) {}
  private publish(patch: Partial<LiveStudioState>) { this.state = { ...this.state, ...patch }; this.options.changed({ ...this.state }); }
  private fetcher() { return this.options.fetcher ?? fetch; }
  private ensure(current: Context) { if (this.current !== current || current.abort.signal.aborted) throw new DOMException("Cancelled", "AbortError"); }
  private attach(current: Context, sessionId: string) {
    let priorMotion = -1;
    current.bridge = new VoiceBridge({ conversationId: this.options.conversationId, sessionId, reactions: true, reactionOnly: true,
      fetcher: this.fetcher(), send: () => {}, changed: () => {}, notice: () => {}, approval: () => {},
      transcript: (fragments: VoiceFragment[]) => { if (this.current === current) this.publish({ heard: reactionUtterances(fragments).map(f => f.text).join("\n").slice(-8000) }); },
      onReactionDecision: decision => { if (this.current === current) this.publish({ decision }); },
      reaction: (reaction, _latency, plan, motion = 0) => {
        if (this.current !== current) return;
        if (motion !== priorMotion) { this.motionEpoch++; priorMotion = motion; }
        this.options.plan(plan ?? legacyPlan(reaction), this.motionEpoch);
      },
    });
  }
  async start() {
    if (this.current) return;
    const current: Context = { abort: new AbortController() }; this.current = current;
    this.publish({ status: "connecting", heard: "", decision: null, error: null });
    try {
      const available = await this.fetcher()(voiceSessionUrl({ conversationId: this.options.conversationId }), { signal: current.abort.signal, cache: "no-store" });
      const availability = await available.json(); this.ensure(current);
      if (!available.ok || !availability.supported) throw new Error(availability.reason || availability.error || "Sign in to the app and check its voice connection.");
      const stream = await (this.options.getMedia?.() ?? navigator.mediaDevices.getUserMedia({ audio: true }));
      // getUserMedia cannot be aborted; a late grant after Stop must immediately release its tracks.
      if (this.current !== current || current.abort.signal.aborted) { stream.getTracks().forEach(t => t.stop()); return; }
      current.stream = stream;
      const peer = this.options.createPeer?.() ?? new RTCPeerConnection(); current.peer = peer;
      const events = peer.createDataChannel("voice-events"); current.events = events;
      events.addEventListener("message", message => {
        if (this.current !== current) return;
        try {
          const event = JSON.parse(String(message.data));
          if (event.type === "session.closed") { this.stop(); return; }
          if (event.type === "error") { this.stop(); this.publish({ status: "error", error: "The voice test session reported an error." }); return; }
          current.bridge?.receive(event);
        } catch { /* Ignore malformed provider frames. */ }
      });
      events.addEventListener("close", () => { if (this.current === current) this.stop(); });
      peer.addEventListener("connectionstatechange", () => {
        if (this.current === current && ["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          this.stop(); this.publish({ status: "error", error: "The voice test connection ended." });
        }
      });
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      await peer.setLocalDescription(await peer.createOffer()); this.ensure(current);
      await waitForIceGathering(peer, current.abort.signal); this.ensure(current);
      const response = await this.fetcher()("/api/voice/session", { method: "POST", signal: current.abort.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: this.options.conversationId, chatId: this.options.conversationId, sdp: peer.localDescription?.sdp, reactionTest: true }) });
      const session = await response.json(); this.ensure(current);
      if (!response.ok) throw new Error(session.error || "Could not start the voice test.");
      if (!session.reactions) throw new Error("Enable avatar Decisions in Voice & avatar before testing live reactions.");
      if (typeof session.session?.id !== "string" || typeof session.transport?.sdp !== "string") throw new Error("The voice test returned an invalid session.");
      this.attach(current, session.session.id);
      const started = waitForVoiceEvent(events, "session.started", current.abort.signal, 20000);
      void started.catch(() => {}); // Remote-description failure may abort this waiter before it is awaited.
      await peer.setRemoteDescription({ type: "answer", sdp: session.transport.sdp });
      await started; this.ensure(current); this.publish({ status: "listening" });
    } catch (error) {
      if (this.current !== current) return;
      this.stop(); this.publish({ status: "error", error: error instanceof Error ? error.message.slice(0, 240) : "Could not start listening." });
    }
  }
  text(value: string) {
    if (!value.trim()) return;
    this.stop(); const current: Context = { abort: new AbortController() }; this.current = current;
    this.publish({ status: "text", heard: "", decision: null, error: null }); this.attach(current, "local-text-test");
    current.bridge!.receive({ type: "session.input_transcript.delta", event_id: "typed-test", delta: value.slice(0, 4000), start_ms: 0, end_ms: 1 });
  }
  stop() {
    const current = this.current; this.current = null;
    // Capture stops synchronously; cleanup and old replies cannot mutate a subsequent test.
    current?.stream?.getTracks().forEach(track => track.stop());
    current?.abort.abort(); current?.bridge?.dispose();
    if (current) this.options.plan(legacyPlan("neutral"), ++this.motionEpoch);
    this.publish({ status: "idle", heard: "", decision: null, error: null });
    if (!current) return;
    const close = () => { current.events?.close(); current.peer?.close(); };
    if (current.events?.readyState === "open") {
      const ack = waitForVoiceEvent(current.events, "session.closed", new AbortController().signal, 1000).catch(() => {});
      try { current.events.send(JSON.stringify({ type: "session.close" })); } catch { /* Already closing. */ }
      void ack.finally(close);
    } else close();
  }
  dispose() { this.stop(); }
}
