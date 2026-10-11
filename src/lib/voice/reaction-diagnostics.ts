import type { AvatarLayerSnapshot } from "./avatar-layers";
export type ReactionMetricReason = "request" | "accepted" | "stale" | "invalid" | "confidence" | "unchanged" | "timeout" | "unavailable" | "deferred" | "cooldown";
const REASONS: readonly ReactionMetricReason[] = ["request", "accepted", "stale", "invalid", "confidence", "unchanged", "timeout", "unavailable", "deferred", "cooldown"];
const ms = (value: number) => Number.isFinite(value) ? Math.round(Math.min(60000, Math.max(0, value))) : 0;
/** Opt-in bounded numeric/enum-only capture. No transcript, raw provider response or session identity. */
export class VoiceReactionDiagnostics {
  private capturing = false;
  private until = 0;
  private counts = Object.fromEntries(REASONS.map(r => [r, 0])) as Record<ReactionMetricReason, number>;
  private samples: { reason: ReactionMetricReason; elapsedMs: number }[] = [];
  private motion: AvatarLayerSnapshot | null = null;
  get enabled() { if (this.capturing && Date.now() > this.until) this.stop(); return this.capturing; }
  start() { this.clear(); this.capturing = true; this.until = Date.now() + 180000; return true; }
  stop() { this.capturing = false; return true; }
  clear() { this.counts = Object.fromEntries(REASONS.map(r => [r, 0])) as Record<ReactionMetricReason, number>; this.samples = []; this.motion = null; return true; }
  record(reason: ReactionMetricReason, elapsedMs: number) {
    if (!this.enabled || !REASONS.includes(reason)) return;
    this.counts[reason] = Math.min(1000000, this.counts[reason] + 1);
    this.samples.push({ reason, elapsedMs: ms(elapsedMs) }); this.samples = this.samples.slice(-128);
  }
  frame(snapshot: AvatarLayerSnapshot) { if (this.enabled) this.motion = structuredClone(snapshot); }
  report() { return { version: 1, enabled: this.enabled, counts: { ...this.counts }, samples: this.samples.map(s => ({ ...s })), motion: this.motion ? structuredClone(this.motion) : null }; }
  dispose() { this.stop(); this.clear(); }
}
