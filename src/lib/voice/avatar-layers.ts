import { AnimationMixer, LoopRepeat, MathUtils, Quaternion, Vector3, type AnimationClip, type Mesh, type Object3D } from "three";
import { isPulse, legacyPlan, type ReactionPlan, type FaceProfile } from "./reaction-library";
import type { Reaction } from "./policy";

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const bounded = (value: number, low: number, high: number) => Number.isFinite(value) ? MathUtils.clamp(value, low, high) : low;
const SMILE = ["mouthSmile", "mouthSmileLeft", "mouthSmileRight"];
const FROWN = ["mouthFrown", "mouthFrownLeft", "mouthFrownRight"];
const BROW = ["browInnerUp", "browInnerUpLeft", "browInnerUpRight"];
export const OPTIONAL_MORPHS = ["browOuterUpLeft", "browOuterUpRight", "browDownLeft", "browDownRight", "mouthPucker", "mouthPressLeft", "mouthPressRight", "mouthStretchLeft", "mouthStretchRight", "cheekSquintLeft", "cheekSquintRight", "noseSneerLeft", "noseSneerRight", "eyeWideLeft", "eyeWideRight", "eyeSquintLeft", "eyeSquintRight", "eyeBlink", "eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "mouthOpen"] as const;
type Binding = { name: string; index: number; weights: number[]; value: number; kind: "smile" | "frown" | "brow" | "blink" | "mouth" | "optional"; suppressed: FaceProfile[] };
type BoneLayer = { bone: Object3D; rest: Quaternion; applied: Quaternion; basis: Quaternion; inverseBasis: Quaternion };
const RECIPES: Record<FaceProfile, Record<string, number>> = {
  neutral: {}, warm: { smile: 0.75, expressionSmile: 0.75, cheekSquintLeft: 0.2, cheekSquintRight: 0.2 },
  sympathetic: { frown: 0.85, brow: 0.75, expressionConcerned: 0.7, browDownLeft: 0.1, browDownRight: 0.1 },
  curious: { brow: 0.45, expressionCurious: 0.45, browOuterUpLeft: 0.2, browOuterUpRight: 0.2, eyeWideLeft: 0.12, eyeWideRight: 0.12 },
  reassuring: { smile: 0.45, expressionSmile: 0.45, brow: 0.4, cheekSquintLeft: 0.1, cheekSquintRight: 0.1 },
  serious: { frown: 0.32, expressionConcerned: 0.3, browDownLeft: 0.4, browDownRight: 0.4, mouthPressLeft: 0.2, mouthPressRight: 0.2 },
};

/** Numeric/enum-only snapshot, bounded counters; never retains transcripts, URLs or credentials. */
export type AvatarLayerSnapshot = { version: 1; face: FaceProfile; gesture: ReactionPlan["gesture"]; frames: number; starts: number; completed: number; cancelled: number; gestureTimeMs: number; startDelayMs: number | null; renderMs: number; reduced: boolean; active: boolean; supportedBones: string[]; supportedMorphs: string[]; missingMorphs: string[]; headDegrees: number[]; bodyDegrees: number[] };

/** Three independent layers: static face, timed head gesture, quiet local posture/idle. */
export class AvatarLayers {
  private bindings: Binding[] = [];
  private bones = new Map<string, BoneLayer>();
  private mixer: AnimationMixer;
  private idle: ReturnType<AnimationMixer["clipAction"]> | null = null;
  private plan = legacyPlan("neutral");
  private revision = -1;
  private motionRevision = -1;
  private elapsed = 0;
  private clock = 0;
  private wasMoving = false;
  private consumed = true;
  private frames = 0; private starts = 0; private completed = 0; private cancelled = 0;
  private head = [0, 0, 0]; private body = [0, 0, 0];
  private axis = new Vector3(); private offset = new Quaternion(); private local = new Quaternion();
  private startDelayMs: number | null = null; private renderMs = 0; private active = false; private reduced = false;
  readonly capabilities: { bones: string[]; morphs: string[]; mouth: boolean; blink: boolean };

  constructor(private root: Object3D, clips: AnimationClip[]) {
    root.updateMatrixWorld(true);
    root.traverse(object => {
      const name = normalize(object.name);
      if (object.type === "Bone" && ["head", "neck", "chest"].includes(name) && !this.bones.has(name)) {
        const basis = object.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
        this.bones.set(name, { bone: object, rest: object.quaternion.clone(), applied: new Quaternion(), basis, inverseBasis: basis.clone().invert() });
      }
      const mesh = object as Mesh;
      if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      const names = new Map(Object.entries(mesh.morphTargetDictionary).map(([key, index]) => [normalize(key), index]));
      const used = new Set<number>();
      const add = (aliases: readonly string[], kind: Binding["kind"], suppressed: FaceProfile[] = []) => {
        for (const alias of aliases) {
          const index = names.get(normalize(alias));
          if (index === undefined || used.has(index) || index >= mesh.morphTargetInfluences!.length) continue;
          used.add(index); this.bindings.push({ name: alias, index, kind, suppressed, weights: mesh.morphTargetInfluences!, value: bounded(mesh.morphTargetInfluences![index], 0, 1) });
        }
      };
      // Paired unilateral controls replace their combined alternative to avoid applying the same deformation twice.
      for (const [aliases, kind] of [[SMILE, "smile"], [FROWN, "frown"], [BROW, "brow"]] as const) {
        const suppressed: FaceProfile[] = [];
        if (kind === "smile" && names.has(normalize("expressionSmile"))) suppressed.push("warm", "reassuring");
        if ((kind === "frown" || kind === "brow") && names.has(normalize("expressionConcerned"))) suppressed.push("sympathetic", "serious");
        if (kind === "brow" && names.has(normalize("expressionCurious"))) suppressed.push("curious");
        if (names.has(normalize(aliases[1])) && names.has(normalize(aliases[2]))) add(aliases.slice(1, 3), kind, suppressed);
        else add(aliases.filter(alias => names.has(normalize(alias))).slice(0, 1), kind, suppressed);
      }
      add(["expressionSmile", "expressionConcerned", "expressionCurious"], "optional");
      add(names.has(normalize("eyeBlinkLeft")) && names.has(normalize("eyeBlinkRight")) ? ["eyeBlinkLeft", "eyeBlinkRight"] : ["eyeBlink"], "blink");
      add(names.has(normalize("jawOpen")) ? ["jawOpen"] : ["mouthOpen"], "mouth");
      add(OPTIONAL_MORPHS.filter(name => !name.startsWith("eyeBlink") && name !== "jawOpen" && name !== "mouthOpen"), "optional");
    });
    this.capabilities = { bones: [...this.bones.keys()], morphs: [...new Set(this.bindings.map(b => b.name))], mouth: this.bindings.some(b => b.kind === "mouth"), blink: this.bindings.some(b => b.kind === "blink") };
    this.mixer = new AnimationMixer(root);
    const idle = clips.find(c => c.name.toLowerCase() === "idle" && c.duration > 0 && Number.isFinite(c.duration));
    if (idle) {
      // A foreign idle must not overwrite the local expression layer.
      const safe = idle.clone(); safe.tracks = safe.tracks.filter(track => !track.name.includes("morphTargetInfluences"));
      this.idle = this.mixer.clipAction(safe).setLoop(LoopRepeat, Infinity);
    }
  }

  private removeOffsets() {
    for (const layer of this.bones.values()) { layer.applied.invert(); layer.bone.quaternion.premultiply(layer.applied); layer.applied.identity(); }
  }
  private rotate(name: string, angles: number[]) {
    const layer = this.bones.get(name); if (!layer) return;
    this.offset.identity();
    for (let i = 0; i < 3; i++) {
      this.axis.set(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
      this.local.setFromAxisAngle(this.axis, MathUtils.degToRad(angles[i])); this.offset.multiply(this.local);
    }
    // World anatomical axes converted into the neutral parent basis; never assume Blender bone axes.
    layer.applied.copy(layer.inverseBasis).multiply(this.offset).multiply(layer.basis);
    layer.bone.quaternion.premultiply(layer.applied);
  }

  update(input: ReactionPlan | undefined, reaction: Reaction, revision: number, dt: number, reduced: boolean, active: boolean, level = 0, requestedAt = 0, motionRevision = revision) {
    const elapsed = bounded(dt, 0, 0.25), dampStep = Math.min(elapsed, 0.05);
    const next = input ?? legacyPlan(reaction);
    this.removeOffsets();
    const moving = active && !reduced; this.active = active; this.reduced = reduced;
    const newMotion = motionRevision !== this.motionRevision;
    if (newMotion) {
      if (!this.consumed && this.elapsed < this.plan.durationMs / 1000) this.cancelled = Math.min(1000000, this.cancelled + 1);
      this.elapsed = 0; this.consumed = !moving; this.motionRevision = motionRevision;
      this.startDelayMs = requestedAt > 0 ? bounded(performance.now() - requestedAt, 0, 60000) : null;
      if (moving) this.starts = Math.min(1000000, this.starts + 1);
    }
    if (revision !== this.revision) {
      // Legacy nod preserves the facial state; explicit plans select face and motion independently.
      this.plan = { ...next, face: !input && (reaction === "nod" || reaction === "keep_current") ? this.plan.face : next.face,
        intensity: bounded(next.intensity, 0.35, 1), tempo: bounded(next.tempo, 0.7, 1.35), durationMs: bounded(next.durationMs, 1200, 6000) };
      this.revision = revision;
    }
    if (!moving) {
      this.idle?.stop(); this.mixer.stopAllAction();
      for (const layer of this.bones.values()) layer.bone.quaternion.copy(layer.rest);
      if (this.wasMoving && !this.consumed) this.cancelled = Math.min(1000000, this.cancelled + 1);
      this.consumed = true;
      this.head.fill(0); this.body.fill(0);
    } else {
      if (this.idle && !this.idle.isRunning()) this.idle.reset().play();
      this.mixer.update(elapsed); this.clock += elapsed;
      if (!this.consumed) {
        this.elapsed += elapsed * this.plan.tempo;
        if (this.elapsed >= this.plan.durationMs / 1000) { this.consumed = true; this.completed = Math.min(1000000, this.completed + 1); }
      }
      const intensity = this.plan.intensity, phase = Math.min(1, this.elapsed / (this.plan.durationMs / 1000));
      const envelope = this.consumed ? 0 : Math.sin(Math.PI * phase) ** 0.7;
      const gesture = this.plan.gesture;
      // A bounded gesture returns to listening. Face persists independently throughout the story.
      let pitch = 0, yaw = 0, roll = 0, lean = 0;
      if (isPulse(gesture)) {
        const cycles = gesture === "double_nod" ? 2 : 1;
        pitch = Math.sin(Math.PI * phase * cycles) ** 2 * (gesture === "slow_nod" ? 10 : 12) * intensity;
      } else {
        roll = (gesture === "tilt_left" ? 10 : gesture === "tilt_right" ? -10 : 0) * envelope * intensity;
        yaw = (gesture === "look_left" ? 15 : gesture === "look_right" ? -15 : 0) * envelope * intensity;
        lean = (gesture === "lean_in" ? 5 : gesture === "lean_back" ? -4 : 0) * envelope * intensity;
      }
      if (this.consumed) pitch = 0;
      // Quasi-periodic micro motion, not random per-frame jitter or continual unsolicited nods.
      const t = this.clock;
      const targets = [pitch + Math.sin(t * 0.71) * 0.7, yaw + Math.sin(t * 0.43 + 0.9) * 1.4, roll + Math.sin(t * 0.31) * 0.9];
      for (let i = 0; i < 3; i++) this.head[i] = MathUtils.damp(this.head[i], targets[i], 8 * this.plan.tempo, dampStep);
      const bodyTargets = [lean + Math.sin(t * 0.8) * 0.35, Math.sin(t * 0.29) * 0.3, Math.sin(t * 0.37 + 1) * 0.35];
      for (let i = 0; i < 3; i++) this.body[i] = MathUtils.damp(this.body[i], bodyTargets[i], 5, dampStep);
      this.rotate("chest", this.body); this.rotate(this.bones.has("head") ? "head" : "neck", this.head);
    }
    this.wasMoving = moving;
    const recipe = active ? RECIPES[this.plan.face] : RECIPES.neutral;
    const blinkPhase = this.clock % 5.3;
    const blink = moving && blinkPhase > 5.12 ? Math.sin((blinkPhase - 5.12) / 0.18 * Math.PI) : 0;
    for (const binding of this.bindings) {
      const target = binding.kind === "mouth" ? (active ? bounded(level, 0, 1) * 0.65 : 0)
        : binding.kind === "blink" ? blink : binding.suppressed.includes(this.plan.face) ? 0 : (recipe[binding.kind === "optional" ? binding.name : binding.kind] ?? 0) * this.plan.intensity;
      binding.value = MathUtils.damp(binding.value, bounded(target, 0, 1), binding.kind === "mouth" ? 18 : binding.kind === "blink" ? 35 : reduced ? 3 : 7, dampStep);
      binding.weights[binding.index] = binding.value;
    }
    this.frames = Math.min(1000000, this.frames + 1);
  }
  snapshot(renderMs = 0): AvatarLayerSnapshot {
    this.renderMs = bounded(renderMs, 0, 60000);
    const recipe = RECIPES[this.plan.face];
    const missing = Object.keys(recipe).filter(key => !key.startsWith("expression") && !this.bindings.some(b => b.kind === key || b.name === key));
    return { version: 1, face: this.plan.face, gesture: this.plan.gesture, frames: this.frames, starts: this.starts, completed: this.completed, cancelled: this.cancelled,
      gestureTimeMs: Math.round(this.elapsed * 1000), startDelayMs: this.startDelayMs === null ? null : Math.round(this.startDelayMs), renderMs: this.renderMs, reduced: this.reduced, active: this.active,
      supportedBones: [...this.capabilities.bones], supportedMorphs: [...this.capabilities.morphs], missingMorphs: missing, headDegrees: [...this.head], bodyDegrees: [...this.body] };
  }
  dispose() { this.removeOffsets(); this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root); for (const b of this.bindings) b.weights[b.index] = 0; }
}
