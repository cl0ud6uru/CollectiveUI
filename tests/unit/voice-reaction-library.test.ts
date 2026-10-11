import { describe, expect, it, vi } from "vitest";
import { Bone, Group, Mesh, Quaternion } from "three";
import { AvatarLayers } from "@/lib/voice/avatar-layers";
import { REACTION_LIBRARY, reactionPlanSchema, type ReactionPlan } from "@/lib/voice/reaction-library";
import { VoiceReactionDiagnostics } from "@/lib/voice/reaction-diagnostics";

function fixture(names = ["mouthSmile", "mouthFrown", "browInnerUp"], rig = true) {
  const root = new Group(), chest = new Bone(), head = new Bone(); chest.name = "chest"; head.name = "head";
  if (rig) { root.add(chest); chest.add(head); }
  const mesh = new Mesh(); mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i])); mesh.morphTargetInfluences = names.map(() => 0); root.add(mesh);
  return { root, chest, head, weights: mesh.morphTargetInfluences, layers: new AvatarLayers(root, []) };
}
const plan = (face: ReactionPlan["face"] = "sympathetic", gesture: ReactionPlan["gesture"] = "small_nod"): ReactionPlan => ({ face, gesture, intensity: 0.85, tempo: 1, durationMs: 2800 });
const step = (layers: AvatarLayers, p: ReactionPlan, revision: number, seconds: number, reduced = false, active = true, motion = revision) => {
  for (let i = 0; i < seconds * 60; i++) layers.update(p, "neutral", revision, 1 / 60, reduced, active, 0, 0, motion);
};

describe("rich avatar reaction layers", () => {
  it("has sixty unique, bounded, physically honest combinations", () => {
    expect(REACTION_LIBRARY).toHaveLength(60); expect(new Set(REACTION_LIBRARY.map(p => p.id)).size).toBe(60);
    for (const preset of REACTION_LIBRARY) expect(reactionPlanSchema.safeParse(preset.plan).success).toBe(true);
    expect(REACTION_LIBRARY.filter(p => p.description.includes("Glances rotate the head"))).toHaveLength(60);
    expect(reactionPlanSchema.safeParse({ ...plan(), intensity: Infinity }).success).toBe(false);
    expect(reactionPlanSchema.safeParse({ ...plan(), approve: true }).success).toBe(false);
  });
  it("finishes a visible nod, holds the face, then permits an explicit replay", () => {
    const f = fixture(); step(f.layers, plan(), 1, 1.4);
    expect(f.layers.snapshot().headDegrees[0]).toBeGreaterThan(8); expect(f.weights[1]).toBeGreaterThan(0.7);
    step(f.layers, plan(), 1, 3); expect(f.layers.snapshot().completed).toBe(1); expect(Math.abs(f.layers.snapshot().headDegrees[0])).toBeLessThan(1);
    expect(f.weights[1]).toBeGreaterThan(0.7);
    step(f.layers, plan(), 2, 1.4); expect(f.layers.snapshot().starts).toBe(2); expect(f.layers.snapshot().headDegrees[0]).toBeGreaterThan(8);
  });
  it("changes the face without restarting a completed or running gesture", () => {
    const f = fixture(); step(f.layers, plan("warm"), 1, 3.5, false, true, 1);
    step(f.layers, plan("sympathetic"), 2, 1, false, true, 1);
    expect(f.layers.snapshot().starts).toBe(1); expect(f.layers.snapshot().completed).toBe(1); expect(f.weights[1]).toBeGreaterThan(0.7);
    step(f.layers, plan("curious"), 3, 1, false, true, 2);
    const elapsed = f.layers.snapshot().gestureTimeMs;
    step(f.layers, plan("warm"), 4, 0.5, false, true, 2);
    expect(f.layers.snapshot().gestureTimeMs).toBeGreaterThan(elapsed); expect(f.layers.snapshot().starts).toBe(2);
  });
  it("cancels smoothly, never accumulates quaternion offsets, and releases on disposal", () => {
    const f = fixture(); step(f.layers, plan("curious", "tilt_left"), 1, 1.4);
    expect(f.layers.snapshot().headDegrees[2]).toBeGreaterThan(7);
    step(f.layers, plan("neutral", "look_right"), 2, 5);
    expect(f.layers.snapshot().cancelled).toBe(1); expect(f.weights.every(w => w < 0.001)).toBe(true);
    step(f.layers, plan("neutral", "attentive"), 3, 100);
    expect(f.head.quaternion.length()).toBeCloseTo(1, 10);
    f.layers.dispose(); expect(f.head.quaternion.angleTo(new Quaternion())).toBeLessThan(0.000001);
  });
  it("separates head and body posture and respects tempo", () => {
    const f = fixture(); step(f.layers, plan("warm", "lean_in"), 1, 1.4);
    expect(f.layers.snapshot().bodyDegrees[0]).toBeGreaterThan(3); expect(Math.abs(f.layers.snapshot().headDegrees[0])).toBeLessThan(1);
    const slow = fixture(), fast = fixture(); step(slow.layers, { ...plan(), tempo: 0.7 }, 1, 2.5); step(fast.layers, { ...plan(), tempo: 1.35 }, 1, 2.5);
    expect(slow.layers.snapshot().completed).toBe(0); expect(fast.layers.snapshot().completed).toBe(1);
  });
  it("suppresses movement with Reduce Motion and never replays an old gesture on resume", () => {
    const f = fixture(); step(f.layers, plan(), 1, 3, true);
    expect(f.head.quaternion.angleTo(new Quaternion())).toBe(0); expect(f.weights[1]).toBeGreaterThan(0.7);
    step(f.layers, plan(), 1, 1.4, false);
    expect(Math.abs(f.layers.snapshot().headDegrees[0])).toBeLessThan(1); expect(f.layers.snapshot().starts).toBe(0);
    step(f.layers, plan(), 2, 1.4); expect(f.layers.snapshot().headDegrees[0]).toBeGreaterThan(8);
    step(f.layers, plan(), 2, 3, false, false); expect(f.weights[1]).toBeLessThan(0.001);
  });
  it("omits missing bones/morphs and never invents a talking mouth", () => {
    const f = fixture([], false); step(f.layers, plan(), 1, 4);
    expect(f.layers.capabilities).toMatchObject({ bones: [], morphs: [], mouth: false, blink: false });
    expect(f.root.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(f.layers.snapshot().missingMorphs).toContain("frown");
  });
  it("uses unilateral pairs without double applying combined alternatives", () => {
    const f = fixture(["mouthSmile", "mouthSmileLeft", "mouthSmileRight"]); step(f.layers, plan("warm", "attentive"), 1, 2);
    expect(f.weights[0]).toBe(0); expect(f.weights[1]).toBeCloseTo(0.6375); expect(f.weights[2]).toBeCloseTo(0.6375);
  });
  it("keeps complete expression fallbacks specific to their face", () => {
    const f = fixture(["expressionCurious", "expressionConcerned", "browInnerUp", "mouthFrown"]);
    step(f.layers, plan(), 1, 2);
    expect(f.weights[0]).toBe(0); expect(f.weights[1]).toBeCloseTo(0.595); expect(f.weights[2]).toBe(0); expect(f.weights[3]).toBe(0);
    step(f.layers, plan("curious"), 2, 2);
    expect(f.weights[0]).toBeCloseTo(0.3825); expect(f.weights[2]).toBeLessThan(0.001);
  });
  it("maps anatomical rotations through a rotated neutral parent without changing its rest", () => {
    const root = new Group(), head = new Bone(); head.name = "head"; root.rotation.z = Math.PI / 2; root.add(head);
    const layers = new AvatarLayers(root, []); step(layers, plan(), 1, 1.4);
    expect(Math.abs(head.quaternion.y)).toBeGreaterThan(0.05); expect(Math.abs(head.quaternion.x)).toBeLessThan(0.02);
    step(layers, plan(), 1, 0.1, true); expect(head.quaternion.angleTo(new Quaternion())).toBe(0);
  });
});

describe("opt-in reaction diagnostics", () => {
  it("defaults off, bounds data and expires without storing input or identities", () => {
    vi.useFakeTimers(); const d = new VoiceReactionDiagnostics(); d.record("accepted", 100); expect(d.report().samples).toEqual([]);
    d.start(); for (let i = 0; i < 300; i++) d.record("accepted", i);
    d.record("api-key-secret" as never, 12); d.record("invalid", Infinity);
    expect(d.report().samples).toHaveLength(128); expect(d.report().counts.accepted).toBe(300);
    expect(JSON.stringify(d.report())).not.toContain("api-key-secret");
    vi.advanceTimersByTime(180001); expect(d.enabled).toBe(false); d.record("accepted", 99); expect(d.report().counts.accepted).toBe(300);
    const report = d.report(); report.samples[0].elapsedMs = 123456; expect(d.report().samples[0].elapsedMs).toBeLessThan(60001);
    d.dispose(); expect(d.report().samples).toEqual([]); vi.useRealTimers();
  });
});
