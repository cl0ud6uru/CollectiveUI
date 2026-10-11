import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceBridge } from "@/lib/voice/bridge";
import { VoiceReactionDiagnostics } from "@/lib/voice/reaction-diagnostics";
const p = { face: "warm", gesture: "small_nod", intensity: 0.85, tempo: 1, durationMs: 2800 };
let bridge: VoiceBridge;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { bridge?.dispose(); vi.useRealTimers(); });
const input = (id: number) => bridge.receive({ type: "session.input_transcript.delta", event_id: String(id), delta: " details", start_ms: id * 10, end_ms: id * 10 + 1 });
function setup(replies: unknown[]) {
  const reaction = vi.fn(), approval = vi.fn(), diagnostics = new VoiceReactionDiagnostics(); diagnostics.start();
  const fetcher = vi.fn(async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json({ revision: body.revision, reaction: "smile", confidence: 0.9, ...replies.shift() as object }); }) as unknown as typeof fetch;
  bridge = new VoiceBridge({ conversationId: "conversation01", sessionId: "session01", reactions: true, send: vi.fn(), changed: vi.fn(), transcript: vi.fn(), notice: vi.fn(), approval, reaction, fetcher, reactionDiagnostics: diagnostics });
  reaction.mockClear(); return { reaction, approval, diagnostics, fetcher };
}
it("retains motion revision when the face changes, including during pulse cooldown", async () => {
  const o = setup([{ plan: p, replay: true }, { plan: { ...p, face: "sympathetic" }, replay: false, reaction: "concerned" }, { plan: { ...p, face: "curious" }, replay: true, reaction: "curious" }]);
  input(1); await vi.advanceTimersByTimeAsync(10); expect(o.reaction.mock.calls[0][3]).toBe(1);
  await vi.advanceTimersByTimeAsync(1000); input(2); await vi.advanceTimersByTimeAsync(10);
  expect(o.reaction.mock.calls[1][2].face).toBe("sympathetic"); expect(o.reaction.mock.calls[1][3]).toBe(1);
  await vi.advanceTimersByTimeAsync(1000); input(3); await vi.advanceTimersByTimeAsync(10);
  expect(o.reaction.mock.calls[2][2].face).toBe("curious"); expect(o.reaction.mock.calls[2][3]).toBe(1); expect(o.approval).not.toHaveBeenCalled();
});
it("permits repeating the same nod after cooldown, never on every transcript fragment", async () => {
  const o = setup([{ plan: p, replay: true }, { plan: p, replay: true }, { plan: p, replay: true }]);
  input(1); await vi.advanceTimersByTimeAsync(10); await vi.advanceTimersByTimeAsync(1000); input(2); await vi.advanceTimersByTimeAsync(10);
  expect(o.reaction).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000); input(3); await vi.advanceTimersByTimeAsync(10);
  expect(o.reaction).toHaveBeenCalledTimes(2); expect(o.reaction.mock.calls[1][3]).toBe(2);
});
it("rejects malformed layer plans and stops diagnostic collection on disposal", async () => {
  const o = setup([{ plan: { ...p, intensity: 3 }, replay: true }]); input(1); await vi.advanceTimersByTimeAsync(10);
  expect(o.reaction).not.toHaveBeenCalled(); expect(o.diagnostics.report().counts.invalid).toBe(1);
  bridge.dispose(); expect(o.diagnostics.enabled).toBe(false);
});
it("rebases keep-current face after a previously deferred reaction applies", async () => {
  let call = 0;
  const reaction = vi.fn();
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const index = call++;
    if (index === 2) await new Promise(resolve => setTimeout(resolve, 200));
    return Response.json({ revision: body.revision, confidence: 0.9, reaction: index === 1 ? "concerned" : "smile", replay: false,
      plan: index === 1 ? { ...p, face: "sympathetic", gesture: "attentive" } : index === 2 ? { ...p, gesture: "tilt_left" } : { ...p, gesture: "attentive" },
      preserve: { face: index === 2, motion: false } });
  }) as unknown as typeof fetch;
  bridge = new VoiceBridge({ conversationId: "conversation01", sessionId: "session01", reactions: true, send: vi.fn(), changed: vi.fn(), transcript: vi.fn(), notice: vi.fn(), approval: vi.fn(), reaction, fetcher }); reaction.mockClear();
  input(1); await vi.advanceTimersByTimeAsync(1);
  // Force an early next face candidate; it must wait for the 900ms dwell.
  await vi.advanceTimersByTimeAsync(449); input(2); await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(449); input(3); await vi.advanceTimersByTimeAsync(201);
  await vi.advanceTimersByTimeAsync(701);
  expect(reaction.mock.calls.at(-1)?.[2]).toMatchObject({ face: "sympathetic", gesture: "tilt_left" });
});
it("shares an explicit reset token with the first gesture of each new session", async () => {
  const reaction = vi.fn();
  const options = { conversationId: "conversation01", sessionId: "session01", reactions: true, send: vi.fn(), changed: vi.fn(), transcript: vi.fn(), notice: vi.fn(), approval: vi.fn(), reaction,
    fetcher: vi.fn(async (_url, init) => Response.json({ revision: JSON.parse(String(init?.body)).revision, confidence: 0.9, reaction: "smile", plan: p, replay: true })) as unknown as typeof fetch };
  bridge = new VoiceBridge(options); expect(reaction.mock.calls[0][3]).toBe(0);
  input(1); await vi.advanceTimersByTimeAsync(1); expect(reaction.mock.calls[1][3]).toBe(1);
  bridge.dispose(); bridge = new VoiceBridge({ ...options, sessionId: "session02" }); expect(reaction.mock.calls.at(-1)?.[3]).toBe(0);
  input(2); await vi.advanceTimersByTimeAsync(1); expect(reaction.mock.calls.at(-1)?.[3]).toBe(1);
});
it("stamps a pulse that crosses its cooldown during dwell and suppresses the following repeat", async () => {
  const o = setup([{ plan: p, replay: true }, { plan: { ...p, gesture: "attentive" }, replay: true }, { plan: { ...p, face: "sympathetic" }, replay: true }, { plan: { ...p, face: "sympathetic" }, replay: true }]);
  input(1); await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(2999); input(2); await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(139); input(3); await vi.advanceTimersByTimeAsync(761);
  expect(o.reaction).toHaveBeenCalledTimes(3); expect(o.reaction.mock.calls[2][2].gesture).toBe("small_nod");
  input(4); await vi.advanceTimersByTimeAsync(1000); expect(o.reaction).toHaveBeenCalledTimes(3);
});
it("waits for slow double nod duration plus settling time before replay", async () => {
  const slow = { ...p, gesture: "double_nod", tempo: 0.7, durationMs: 3200 };
  const o = setup([{ plan: slow, replay: true }, { plan: slow, replay: true }, { plan: slow, replay: true }]);
  input(1); await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(3200); input(2); await vi.advanceTimersByTimeAsync(1); expect(o.reaction).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000); input(3); await vi.advanceTimersByTimeAsync(1); expect(o.reaction).toHaveBeenCalledTimes(2);
});
