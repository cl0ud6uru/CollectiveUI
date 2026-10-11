import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceAudioDiagnostics } from "@/lib/voice/audio-diagnostics";

type Row = Record<string, unknown>;
const stats = (rows: Row[]) => ({ forEach: (callback: (row: Row) => void) => rows.forEach(callback) });
const inbound = (extra: Row = {}) => ({ type: "inbound-rtp", kind: "audio", id: "audio-1", packetsReceived: 100, packetsLost: 2, packetsDiscarded: 1, concealedSamples: 480, concealmentEvents: 1, totalSamplesReceived: 48_000, jitter: 0.003, jitterBufferDelay: 100, jitterBufferEmittedCount: 48_000, ...extra });
function fixture(maxSamples = 180) {
  let now = 0;
  const getStats = vi.fn(async () => stats([inbound()]));
  const diagnostics = new VoiceAudioDiagnostics({ peer: () => ({ getStats }), audio: () => ({ paused: false, readyState: 4 }), now: () => now, maxSamples });
  return { diagnostics, getStats, time: (value: number) => { now = value; } };
}
afterEach(() => { vi.useRealTimers(); });

describe("local voice audio diagnostics", () => {
  it("installs deferred source getters without reading or enabling them, and stops replaced capture", async () => {
    const diagnostics = new VoiceAudioDiagnostics({ peer: () => null, audio: () => null });
    const peer = vi.fn(() => ({ getStats: async () => stats([inbound()]) }));
    const audio = vi.fn(() => ({ paused: false, readyState: 4 }));
    diagnostics.setSources({ peer, audio });
    expect(peer).not.toHaveBeenCalled(); expect(audio).not.toHaveBeenCalled(); expect(diagnostics.enabled).toBe(false);
    diagnostics.start(false); expect((await diagnostics.sample())?.stats).toBe("available");
    diagnostics.setSources({ peer: () => null, audio: () => null });
    expect(diagnostics.enabled).toBe(false); expect(await diagnostics.sample()).toBeNull();
    diagnostics.start(false); expect((await diagnostics.sample())?.stats).toBe("no-peer"); diagnostics.dispose();
  });
  it("is opt-in and never reads stats while disabled; stopping removes automatic work", async () => {
    vi.useFakeTimers(); const { diagnostics, getStats } = fixture();
    expect(await diagnostics.sample()).toBeNull(); expect(getStats).not.toHaveBeenCalled();
    diagnostics.start(); await vi.advanceTimersByTimeAsync(1000); expect(getStats).toHaveBeenCalledOnce();
    diagnostics.stop(); await vi.advanceTimersByTimeAsync(3000);
    expect(getStats).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(diagnostics.report().samples).toHaveLength(1); diagnostics.clear(); expect(diagnostics.count).toBe(0);
  });
  it("computes interval deltas and weighted buffer delay without reporting cumulative counts", async () => {
    const { diagnostics, getStats, time } = fixture(); diagnostics.start(false); await diagnostics.sample();
    getStats.mockResolvedValue(stats([inbound({ packetsReceived: 150, packetsLost: 3, packetsDiscarded: 4, concealedSamples: 960, concealmentEvents: 3, totalSamplesReceived: 96_000, jitter: 0.008, jitterBufferDelay: 580, jitterBufferEmittedCount: 96_000 })]));
    time(1000); const row = await diagnostics.sample();
    expect(row?.elapsedMs).toBe(1000);
    expect(row?.inbound).toEqual({ packetsReceivedDelta: 50, packetsLostDelta: 1, packetsDiscardedDelta: 3, concealedSamplesDelta: 480, concealmentEventsDelta: 2, totalSamplesReceivedDelta: 48_000, jitterMs: 8, meanJitterBufferMs: 10 });
    expect(diagnostics.report().samples[0].inbound).toEqual({ jitterMs: 3 }); diagnostics.stop();
  });
  it("handles replaced/reset counters, missing metrics, and signed packet loss", async () => {
    const { diagnostics, getStats } = fixture(); diagnostics.start(false); await diagnostics.sample();
    getStats.mockResolvedValue(stats([inbound({ packetsReceived: 1, packetsLost: 1, concealedSamples: undefined, jitter: NaN, jitterBufferDelay: undefined })]));
    const row = await diagnostics.sample();
    expect(row?.inbound?.packetsReceivedDelta).toBeUndefined(); expect(row?.inbound?.concealedSamplesDelta).toBeUndefined();
    expect(row?.inbound?.jitterMs).toBeUndefined(); expect(row?.inbound?.meanJitterBufferMs).toBeUndefined(); expect(row?.inbound?.packetsLostDelta).toBe(-1);
    getStats.mockResolvedValue(stats([inbound({ id: "new-stream", packetsReceived: 900 })]));
    expect((await diagnostics.sample())?.inbound?.packetsReceivedDelta).toBeUndefined(); diagnostics.stop();
  });
  it("accepts supported playout counters and a fixed codec enum", async () => {
    const { diagnostics, getStats } = fixture();
    const rows = (amount: number) => [inbound({ codecId: "codec-secret" }), { type: "codec", id: "codec-secret", mimeType: "audio/opus", clockRate: 48_000 },
      { type: "media-playout", kind: "audio", id: "playout", synthesizedSamplesDuration: amount * 0.024, synthesizedSamplesEvents: amount, totalSamplesDuration: amount, totalPlayoutDelay: amount * 1440, totalSamplesCount: amount * 48_000 }];
    getStats.mockResolvedValue(stats(rows(1))); diagnostics.start(false); await diagnostics.sample();
    getStats.mockResolvedValue(stats(rows(2))); const row = await diagnostics.sample();
    expect(row?.playout).toEqual({ synthesizedMsDelta: 24, synthesisEventsDelta: 1, samplesMsDelta: 1000, meanPlayoutDelayMs: 30 });
    expect(row?.codec).toEqual({ mime: "audio/opus", clockRate: 48_000 }); diagnostics.stop();
  });
  it("omits unsupported values and redacts secrets even when stats and errors contain them", async () => {
    const { diagnostics, getStats } = fixture();
    getStats.mockResolvedValue(stats([inbound({ id: "private-session", codecId: "private-codec", transcript: "PRIVATE", address: "10.0.0.1", sdp: "PRIVATE", jitter: Infinity }),
      { type: "candidate-pair", id: "PRIVATE", localAddress: "10.0.0.1" }, { type: "codec", id: "private-codec", mimeType: "PRIVATE", clockRate: "PRIVATE" }]));
    diagnostics.setContext("input", { state: "running", sampleRate: 48_000, baseLatency: 0.01 });
    diagnostics.start(false); const row = await diagnostics.sample();
    expect(row?.contexts.input).toEqual({ state: "running", sampleRate: 48_000, baseLatencyMs: 10 }); expect(row?.codec).toEqual({ mime: "other" });
    getStats.mockRejectedValue(new Error("PRIVATE token/password/transcript"));
    expect((await diagnostics.sample())?.stats).toBe("unavailable");
    const text = JSON.stringify(diagnostics.report()); expect(text).not.toMatch(/PRIVATE|private-session|private-codec|10\.0\.0\.1|password|transcript|sdp/);
    diagnostics.stop();
  });
  it("times out unsupported/hung stats and rejects late work after stop, clear, or restart", async () => {
    vi.useFakeTimers(); const { diagnostics, getStats } = fixture();
    let resolve!: (value: ReturnType<typeof stats>) => void;
    getStats.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    diagnostics.start(false); const pending = diagnostics.sample(); expect(diagnostics.sample()).toBe(pending);
    diagnostics.clear(); diagnostics.start(false); resolve(stats([inbound()])); expect(await pending).toBeNull(); expect(diagnostics.count).toBe(0);
    getStats.mockImplementationOnce(() => new Promise(() => {})); const hung = diagnostics.sample();
    await vi.advanceTimersByTimeAsync(750); expect((await hung)?.stats).toBe("unavailable");
    diagnostics.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds samples/events, stops after three minutes, and exports defensive copies", async () => {
    const { diagnostics, time } = fixture(3); diagnostics.start(false);
    for (let index = 0; index < 100; index++) diagnostics.recordDuration("avatar-decode", 12);
    for (let index = 0; index < 3; index++) await diagnostics.sample();
    expect(diagnostics.enabled).toBe(false); expect(diagnostics.count).toBe(3); expect(diagnostics.report().events).toHaveLength(32);
    const report = diagnostics.report(); report.samples[0].elapsedMs = 999; report.events.length = 0;
    expect(diagnostics.report().samples[0].elapsedMs).toBe(0); expect(diagnostics.report().events).toHaveLength(32);
    diagnostics.clear(); diagnostics.start(false); time(180_000); expect(await diagnostics.sample()).toBeNull(); expect(diagnostics.enabled).toBe(false);
  });
  it("reports frame pressure by sampling interval and never operates a context", async () => {
    const { diagnostics } = fixture();
    const old = { state: "running" as const, sampleRate: 48_000, baseLatency: 0.01 }, current = { ...old, baseLatency: 0.02 };
    diagnostics.setContext("output", old); diagnostics.setContext("output", current); diagnostics.releaseContext("output", old);
    diagnostics.recordFrame(99, 99); diagnostics.start(false); diagnostics.recordFrame(33, 5); diagnostics.recordFrame(67, 15); diagnostics.recordFrame(NaN, 10);
    diagnostics.recordDuration("invalid" as "avatar-load", 10); diagnostics.recordDuration("avatar-load", Infinity);
    const row = await diagnostics.sample();
    expect(row?.contexts.output?.baseLatencyMs).toBe(20);
    expect(row?.renderer).toEqual({ frames: 2, meanFrameGapMs: 50, maxFrameGapMs: 67, gapsOver50Ms: 1, meanWorkMs: 10, maxWorkMs: 15 });
    expect((await diagnostics.sample())?.renderer).toBeUndefined(); expect(diagnostics.report().events).toHaveLength(0);
    diagnostics.releaseContext("output", current); expect((await diagnostics.sample())?.contexts.output).toBeUndefined(); diagnostics.dispose();
  });
  it("rejects load timings from a stopped/replaced capture", () => {
    const { diagnostics, time } = fixture(); expect(diagnostics.beginTiming()).toBeNull(); diagnostics.start(false);
    const old = diagnostics.beginTiming(); time(100); diagnostics.stop(); diagnostics.start(false);
    diagnostics.endTiming("avatar-load", old); expect(diagnostics.report().events).toEqual([]);
    const current = diagnostics.beginTiming(); time(150);
    diagnostics.endTiming("avatar-decode", current);
    expect(diagnostics.report().events).toEqual([{ elapsedMs: 50, kind: "avatar-decode", durationMs: 50 }]); diagnostics.stop();
  });
});
