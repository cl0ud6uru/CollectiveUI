/** Local, opt-in metadata only. This observes playback; it never changes the audio graph. */
export type AudioDiagnosticContextRole = "input" | "output";
export type AudioDiagnosticEventKind = "avatar-fetch" | "avatar-decode" | "avatar-load";
type Timing = { epoch: number; at: number };
type Numbers = Record<string, number>;
type ContextSample = { state: "running" | "suspended" | "closed" | "interrupted" | "unknown"; sampleRate?: number; baseLatencyMs?: number; outputLatencyMs?: number };
export type AudioDiagnosticSample = {
  elapsedMs: number;
  stats: "available" | "unavailable" | "no-peer";
  inbound?: Numbers;
  playout?: Numbers;
  codec?: { mime: "audio/opus" | "audio/pcmu" | "audio/pcma" | "audio/g722" | "other"; clockRate?: number };
  contexts: Partial<Record<AudioDiagnosticContextRole, ContextSample>>;
  player?: { paused: boolean; readyState: number };
  renderer?: Numbers;
};
export type AudioDiagnosticReport = {
  schemaVersion: 1; recording: boolean; samples: AudioDiagnosticSample[];
  events: { elapsedMs: number; kind: AudioDiagnosticEventKind; durationMs: number }[];
};
type StatsRow = Record<string, unknown>;
type Peer = { getStats(): Promise<{ forEach(callback: (row: StatsRow) => void): void }> };
type Context = Pick<AudioContext, "state" | "sampleRate" | "baseLatency"> & { outputLatency?: number };
type Options = { peer: () => Peer | null; audio: () => Pick<HTMLAudioElement, "paused" | "readyState"> | null; now?: () => number; maxSamples?: number };

const inboundCounters = {
  packetsReceived: "packetsReceivedDelta", packetsLost: "packetsLostDelta", packetsDiscarded: "packetsDiscardedDelta",
  concealedSamples: "concealedSamplesDelta", concealmentEvents: "concealmentEventsDelta", totalSamplesReceived: "totalSamplesReceivedDelta",
  insertedSamplesForDeceleration: "insertedSamplesForDecelerationDelta", removedSamplesForAcceleration: "removedSamplesForAccelerationDelta",
} as const;
const playoutCounters = { synthesizedSamplesDuration: "synthesizedMsDelta", synthesizedSamplesEvents: "synthesisEventsDelta", totalSamplesDuration: "samplesMsDelta" } as const;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
const positive = (value: unknown): value is number => finite(value) && value >= 0;
const numeric = (target: Numbers, key: string, value: unknown, scale = 1) => { if (finite(value) && finite(value * scale)) target[key] = value * scale; };
const delta = (row: StatsRow, previous: StatsRow | undefined, key: string, signed = false): number | undefined => {
  const value = row[key], old = previous?.[key];
  if (!finite(value) || !finite(old)) return;
  const difference = value - old;
  // New/reset counters have no meaningful interval delta. packetsLost can decrease on late arrivals.
  if (!finite(difference) || (!signed && difference < 0)) return;
  return difference;
};
const add = (target: Numbers, key: string, value: number | undefined, scale = 1) => {
  if (value !== undefined) numeric(target, key, (target[key] ?? 0) + value * scale);
};
const retainedCounters = [...Object.keys(inboundCounters), ...Object.keys(playoutCounters), "jitterBufferDelay", "jitterBufferEmittedCount", "totalPlayoutDelay", "totalSamplesCount"];

export class VoiceAudioDiagnostics {
  private recording = false;
  private samples: AudioDiagnosticSample[] = [];
  private events: AudioDiagnosticReport["events"] = [];
  private contexts: Partial<Record<AudioDiagnosticContextRole, Context>> = {};
  private previous = new Map<string, StatsRow>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private epoch = 0;
  private startedAt = 0;
  private pending: Promise<AudioDiagnosticSample | null> | null = null;
  private frames = { count: 0, gapTotal: 0, gapMax: 0, workTotal: 0, workMax: 0, slow: 0 };
  private readonly now: () => number;
  private readonly maxSamples: number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.now());
    this.maxSamples = Math.max(1, Math.min(180, Math.floor(options.maxSamples ?? 180) || 180));
  }
  get enabled() { return this.recording; }
  get count() { return this.samples.length; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) { try { listener(); } catch { /* Diagnostics cannot interrupt voice. */ } } }
  /** Native supplies the one-second clock with sample(); web uses the automatic timer. */
  start(automatic = true) {
    if (this.recording) return true;
    this.clear(); this.recording = true; this.startedAt = this.now();
    if (automatic) this.timer = setInterval(() => { void this.sample(); }, 1000);
    this.changed(); return true;
  }
  stop() {
    this.recording = false; this.epoch++; this.pending = null;
    this.previous.clear();
    if (this.timer !== null) clearInterval(this.timer); this.timer = null;
    this.changed(); return true;
  }
  clear() {
    this.stop(); this.samples = []; this.events = []; this.previous.clear(); this.resetFrames(); this.changed(); return true;
  }
  dispose() { this.clear(); this.contexts = {}; this.listeners.clear(); }
  setContext(role: AudioDiagnosticContextRole, context: Context | null) {
    if (context) this.contexts[role] = context; else delete this.contexts[role];
  }
  releaseContext(role: AudioDiagnosticContextRole, context: Context | null) {
    if (this.contexts[role] === context) delete this.contexts[role];
  }
  recordDuration(kind: AudioDiagnosticEventKind, durationMs: number) {
    if (!this.recording || !positive(durationMs) || !["avatar-fetch", "avatar-decode", "avatar-load"].includes(kind)) return;
    if (this.events.length < 32) this.events.push({ elapsedMs: this.elapsed(), kind, durationMs });
  }
  beginTiming(): Timing | null { return this.recording ? { epoch: this.epoch, at: this.now() } : null; }
  endTiming(kind: AudioDiagnosticEventKind, timing: Timing | null) {
    if (timing && timing.epoch === this.epoch) this.recordDuration(kind, this.now() - timing.at);
  }
  recordFrame(gapMs: number, workMs: number) {
    if (!this.recording || !positive(gapMs) || !positive(workMs)) return;
    this.frames.count++; this.frames.gapTotal += gapMs; this.frames.workTotal += workMs;
    this.frames.gapMax = Math.max(this.frames.gapMax, gapMs); this.frames.workMax = Math.max(this.frames.workMax, workMs);
    if (gapMs > 50) this.frames.slow++;
  }
  /** Copies only the schema constructed below, never a browser stats report or error string. */
  report(): AudioDiagnosticReport {
    return structuredClone({ schemaVersion: 1, recording: this.recording, samples: this.samples, events: this.events });
  }
  sample(): Promise<AudioDiagnosticSample | null> {
    if (!this.recording) return Promise.resolve(null);
    if (this.pending) return this.pending;
    if (this.elapsed() >= 180_000 || this.samples.length >= this.maxSamples) { this.stop(); return Promise.resolve(null); }
    const epoch = this.epoch;
    const pending = this.collect(epoch);
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = null; });
    return pending;
  }
  private elapsed() { return Math.max(0, this.now() - this.startedAt); }
  private resetFrames() { this.frames = { count: 0, gapTotal: 0, gapMax: 0, workTotal: 0, workMax: 0, slow: 0 }; }
  private async collect(epoch: number): Promise<AudioDiagnosticSample | null> {
    const sample: AudioDiagnosticSample = { elapsedMs: this.elapsed(), stats: "no-peer", contexts: {} };
    let stats: Awaited<ReturnType<Peer["getStats"]>> | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const peer = this.options.peer();
      if (peer) {
        sample.stats = "unavailable";
        stats = await Promise.race([peer.getStats(), new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 750); })]);
      }
    } catch { /* Unsupported/failed stats are metadata, never provider error messages. */ }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
    if (!this.recording || epoch !== this.epoch) return null;
    if (stats) {
      try { this.readStats(stats, sample); sample.stats = "available"; }
      catch { sample.stats = "unavailable"; delete sample.inbound; delete sample.playout; delete sample.codec; }
    }
    for (const role of ["input", "output"] as const) {
      const context = this.contexts[role]; if (!context) continue;
      try {
        const state = String(context.state);
        const value: ContextSample = { state: ["running", "suspended", "closed", "interrupted"].includes(state) ? state as ContextSample["state"] : "unknown" };
        if (positive(context.sampleRate)) value.sampleRate = context.sampleRate;
        if (positive(context.baseLatency)) value.baseLatencyMs = context.baseLatency * 1000;
        if (positive(context.outputLatency)) value.outputLatencyMs = context.outputLatency * 1000;
        sample.contexts[role] = value;
      } catch { /* Closed/disappearing contexts may not expose metrics. */ }
    }
    try {
      const player = this.options.audio();
      if (player && typeof player.paused === "boolean" && positive(player.readyState) && player.readyState <= 4) sample.player = { paused: player.paused, readyState: player.readyState };
    } catch { /* Detached players do not affect capture. */ }
    const f = this.frames;
    if (f.count) sample.renderer = { frames: f.count, meanFrameGapMs: f.gapTotal / f.count, maxFrameGapMs: f.gapMax, gapsOver50Ms: f.slow, meanWorkMs: f.workTotal / f.count, maxWorkMs: f.workMax };
    this.resetFrames(); this.samples.push(sample);
    if (this.samples.length >= this.maxSamples || this.elapsed() >= 180_000) this.stop(); else this.changed();
    return structuredClone(sample);
  }
  private readStats(stats: NonNullable<Awaited<ReturnType<Peer["getStats"]>>>, sample: AudioDiagnosticSample) {
    const inbound: Numbers = {}, playout: Numbers = {}, next = new Map<string, StatsRow>();
    let bufferDelay = 0, bufferSamples = 0, playoutDelay = 0, playoutSamples = 0;
    const codecs = new Map<string, StatsRow>();
    const codecIds: string[] = [];
    stats.forEach(row => {
      if (row.type === "codec" && typeof row.id === "string") { if (codecs.size < 8) codecs.set(row.id, row); return; }
      if ((row.kind ?? row.mediaType) !== "audio" || (row.type !== "inbound-rtp" && row.type !== "media-playout") || typeof row.id !== "string") return;
      if (next.size >= 8) return;
      const old = this.previous.get(row.id);
      // Retain numeric counters only. No SSRC, ICE addresses, session IDs, SDP, URLs or names.
      const counters: StatsRow = {};
      for (const key of retainedCounters) if (finite(row[key])) counters[key] = row[key];
      next.set(row.id, counters);
      if (row.type === "inbound-rtp") {
        for (const [key, label] of Object.entries(inboundCounters)) add(inbound, label, delta(row, old, key, key === "packetsLost"));
        if (positive(row.jitter)) inbound.jitterMs = Math.max(inbound.jitterMs ?? 0, row.jitter * 1000);
        const delay = delta(row, old, "jitterBufferDelay"), count = delta(row, old, "jitterBufferEmittedCount");
        if (delay !== undefined && count !== undefined) { bufferDelay += delay; bufferSamples += count; }
        if (typeof row.codecId === "string") codecIds.push(row.codecId);
      } else {
        for (const [key, label] of Object.entries(playoutCounters)) add(playout, label, delta(row, old, key), key.endsWith("Duration") ? 1000 : 1);
        const delay = delta(row, old, "totalPlayoutDelay"), count = delta(row, old, "totalSamplesCount");
        if (delay !== undefined && count !== undefined) { playoutDelay += delay; playoutSamples += count; }
      }
    });
    this.previous = next;
    if (bufferSamples > 0) numeric(inbound, "meanJitterBufferMs", bufferDelay / bufferSamples, 1000);
    if (playoutSamples > 0) numeric(playout, "meanPlayoutDelayMs", playoutDelay / playoutSamples, 1000);
    if (Object.keys(inbound).length) sample.inbound = inbound;
    if (Object.keys(playout).length) sample.playout = playout;
    const codec = codecs.get(codecIds[0]);
    if (codec) {
      const mime = typeof codec.mimeType === "string" ? codec.mimeType.toLowerCase() : "";
      sample.codec = { mime: ["audio/opus", "audio/pcmu", "audio/pcma", "audio/g722"].includes(mime) ? mime as NonNullable<AudioDiagnosticSample["codec"]>["mime"] : "other" };
      if (positive(codec.clockRate)) sample.codec.clockRate = codec.clockRate;
    }
  }
}
