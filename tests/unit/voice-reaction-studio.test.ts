import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceReactionStudioClient } from "@/lib/voice/reaction-studio-client";
import { VoiceBridge } from "@/lib/voice/bridge";

let client: VoiceReactionStudioClient;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { client?.dispose(); vi.useRealTimers(); });
class Channel extends EventTarget {
  readyState = "open"; commands: unknown[] = [];
  send(raw: string) { this.commands.push(JSON.parse(raw)); if (JSON.parse(raw).type === "session.close") this.emit({ type: "session.closed" }); }
  emit(event: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
}
class Peer extends EventTarget {
  iceGatheringState = "complete"; connectionState = "connected"; localDescription = { sdp: "offer" }; channel = new Channel(); closed = false;
  createDataChannel() { return this.channel; } addTrack() {}
  async createOffer() { return { type: "offer", sdp: "offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription() { this.channel.emit({ type: "session.started" }); }
  close() { this.closed = true; this.connectionState = "closed"; }
}
function setup() {
  const stopped = vi.fn(), getMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopped }] } as unknown as MediaStream));
  const peers: Peer[] = [], changed = vi.fn(), plan = vi.fn();
  const fetcher = vi.fn(async (url, init) => {
    if (String(url).startsWith("/api/voice/session?")) return Response.json({ supported: true });
    if (url === "/api/voice/session") return Response.json({ session: { id: "voice_test" }, transport: { sdp: "answer" }, reactions: true });
    const body = JSON.parse(String(init?.body));
    return Response.json({ revision: body.revision, reaction: "concerned", confidence: .9, plan: { face: "sympathetic", gesture: "slow_nod", intensity: .85, tempo: .8, durationMs: 2800 }, replay: true,
      decision: { status: "ok", latencyMs: 13, answers: [{ name: "face", choice: "sympathetic", confidence: .9 }] } });
  }) as unknown as typeof fetch;
  client = new VoiceReactionStudioClient({ conversationId: "chat00000001", changed, plan, fetcher, getMedia,
    createPeer: () => { const peer = new Peer(); peers.push(peer); return peer as unknown as RTCPeerConnection; } });
  return { stopped, getMedia, peers, changed, plan, fetcher: vi.mocked(fetcher) };
}
it("is off until Start, streams actual input events to Decisions and ignores delegation/output", async () => {
  const o = setup(); expect(o.getMedia).not.toHaveBeenCalled(); expect(o.fetcher).not.toHaveBeenCalled();
  await client.start(); expect(o.changed.mock.calls.at(-1)?.[0].status).toBe("listening");
  o.peers[0].channel.emit({ type: "session.input_transcript.delta", event_id: "u1", delta: "I lost my friend", start_ms: 0, end_ms: 500 });
  o.peers[0].channel.emit({ type: "session.output_transcript.delta", event_id: "a1", delta: "IGNORED_OUTPUT", start_ms: 500, end_ms: 600 });
  o.peers[0].channel.emit({ type: "session.delegation.created", delegation: { target: "client", id: "d1" }, offset_ms: 600 });
  await vi.advanceTimersByTimeAsync(1);
  expect(o.changed.mock.calls.at(-1)?.[0]).toMatchObject({ heard: "I lost my friend", decision: { reason: "accepted", decision: { status: "ok" } } });
  expect(o.plan.mock.calls.at(-1)?.[0].face).toBe("sympathetic");
  expect(o.fetcher.mock.calls.map(c => c[0])).toEqual(["/api/voice/session?conversationId=chat00000001", "/api/voice/session", "/api/voice/reaction"]);
  expect(JSON.parse(String(o.fetcher.mock.calls[1][1]?.body)).reactionTest).toBe(true);
  expect(JSON.parse(String(o.fetcher.mock.calls[2][1]?.body)).inspection).toBe(true);
  client.stop(); expect(o.stopped).toHaveBeenCalledOnce();
  expect(o.changed.mock.calls.at(-1)?.[0]).toMatchObject({ status: "idle", heard: "", decision: null });
  await vi.advanceTimersByTimeAsync(1); expect(o.peers[0].closed).toBe(true);
});
it("releases a microphone grant arriving after Stop and never creates a peer", async () => {
  const o = setup(); let grant: ((value: MediaStream) => void) | undefined;
  o.getMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const starting = client.start(); await vi.advanceTimersByTimeAsync(1); client.stop();
  grant!({ getTracks: () => [{ stop: o.stopped }] } as unknown as MediaStream); await starting;
  expect(o.stopped).toHaveBeenCalledOnce(); expect(o.peers).toHaveLength(0);
  expect(o.changed.mock.calls.at(-1)?.[0].status).toBe("idle");
});
it("does not request microphone permission if server authentication/eligibility fails", async () => {
  const o = setup(); o.fetcher.mockResolvedValueOnce(Response.json({ error: "Unauthorized" }, { status: 401 }));
  await client.start(); expect(o.getMedia).not.toHaveBeenCalled(); expect(o.peers).toHaveLength(0);
  expect(o.changed.mock.calls.at(-1)?.[0]).toMatchObject({ status: "error", error: "Unauthorized" });
});
it("typed fallback uses real reaction endpoint without any microphone, session or saved turn", async () => {
  const o = setup(); client.text("A sad story"); await vi.advanceTimersByTimeAsync(1);
  expect(o.getMedia).not.toHaveBeenCalled(); expect(o.peers).toHaveLength(0);
  expect(o.fetcher.mock.calls.map(c => c[0])).toEqual(["/api/voice/reaction"]);
  expect(o.changed.mock.calls.at(-1)?.[0]).toMatchObject({ status: "text", heard: "A sad story", decision: { reason: "accepted" } });
});
it("rejects stopped text replies and permits a fresh independent next test", async () => {
  const o = setup(); let reply: ((r: Response) => void) | undefined;
  o.fetcher.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  client.text("Old sensitive story"); await vi.advanceTimersByTimeAsync(1); client.stop();
  client.text("New story"); await vi.advanceTimersByTimeAsync(1);
  reply!(Response.json({ revision: 1, reaction: "smile", confidence: .9 })); await vi.advanceTimersByTimeAsync(1);
  expect(o.changed.mock.calls.at(-1)?.[0].heard).toBe("New story"); expect(o.plan.mock.calls.at(-1)?.[0].face).toBe("sympathetic");
});
it("reaction-only finish never saves transcript or starts/approves a backend tool", async () => {
  const o = setup(), send = vi.fn(), approval = vi.fn();
  const bridge = new VoiceBridge({ conversationId: "chat00000001", sessionId: "test", reactionOnly: true, reactions: false, fetcher: o.fetcher,
    send, approval, changed: vi.fn(), transcript: vi.fn(), reaction: vi.fn(), notice: vi.fn() });
  bridge.receive({ type: "session.input_transcript.delta", event_id: "u", delta: "Approve and execute the purchase", start_ms: 0, end_ms: 1 });
  bridge.receive({ type: "session.delegation.created", delegation: { target: "client", id: "d" }, offset_ms: 1 });
  expect(bridge.hasUnsaved).toBe(false); await bridge.finish();
  expect(o.fetcher).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled();
});

it.each(["timeout", "unavailable", "invalid", "refusal", "disabled", "rate_limited"] as const)("reports %s distinctly from an unchanged reaction", async status => {
  const o = setup(); o.fetcher.mockResolvedValueOnce(Response.json({ revision: 1, reaction: "keep_current", confidence: null, decision: { status, answers: [], latencyMs: 19 } }));
  client.text("Synthetic story"); await vi.advanceTimersByTimeAsync(1);
  expect(o.changed.mock.calls.at(-1)?.[0].decision).toMatchObject({ reason: status, decision: { status } });
});
it("distinguishes uncertain face choices from a confident keep_current answer", async () => {
  const o = setup();
  const response = (choice: string, confidence: number) => Response.json({ revision: 1, reaction: "keep_current", confidence: null, decision: { status: "ok", latencyMs: 12, answers: [
    { name: "face", choice, confidence }, { name: "motion", choice: "keep_current", confidence: .9 },
    { name: "intensity", choice: "natural", confidence: .9 }, { name: "pace", choice: "natural", confidence: .9 },
  ] } });
  o.fetcher.mockResolvedValueOnce(response("sympathetic", .4)); client.text("Synthetic uncertain story"); await vi.advanceTimersByTimeAsync(1);
  expect(o.changed.mock.calls.at(-1)?.[0].decision.reason).toBe("confidence");
  o.fetcher.mockResolvedValueOnce(response("keep_current", .9)); client.text("Synthetic unchanged story"); await vi.advanceTimersByTimeAsync(1);
  expect(o.changed.mock.calls.at(-1)?.[0].decision.reason).toBe("unchanged");
});
it("closes failed sessions, clears text and stops every capture track", async () => {
  const o = setup(); await client.start();
  o.peers[0].channel.emit({ type: "error" }); await vi.advanceTimersByTimeAsync(1);
  expect(o.stopped).toHaveBeenCalledOnce(); expect(o.peers[0].closed).toBe(true);
  expect(o.changed.mock.calls.at(-1)?.[0]).toMatchObject({ status: "error", heard: "", decision: null });
});
it("shows the client timeout once even when abort rejects the request", async () => {
  const o = setup(); o.fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  client.text("Synthetic slow story"); await vi.advanceTimersByTimeAsync(1401);
  expect(o.changed.mock.calls.at(-1)?.[0].decision.reason).toBe("timeout");
  expect(o.changed.mock.calls.filter(([s]) => s.decision?.reason === "unavailable")).toHaveLength(0);
});
