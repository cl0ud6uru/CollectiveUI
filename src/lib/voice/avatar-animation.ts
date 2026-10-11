import { AnimationMixer, AnimationUtils, LoopOnce, LoopRepeat, MathUtils, Vector3, type AnimationAction, type AnimationClip, type Box3, type Mesh, type Object3D } from "three";
import type { Reaction } from "./policy";

type Binding = { weights: number[]; index: number; value: number; smile: number; concerned: number; curious: number; mouth: boolean; blink: boolean };
const normalized = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A named head bone gives a reliable bust focus; unknown models keep their full bounds. */
export function avatarFraming(root: Object3D, bounds: Box3): { target: Vector3; distance: number } | null {
  let head: Object3D | undefined;
  root.traverse(object => { if (object.type === "Bone" && normalized(object.name) === "head") head = object; });
  if (!head || bounds.isEmpty()) return null;
  const target = head.getWorldPosition(new Vector3());
  if (!bounds.containsPoint(target)) return null;
  const height = bounds.max.y - bounds.min.y;
  target.y += height * 0.02;
  return { target, distance: Math.max(1, height * 0.55) };
}

/** Cache supported channels once. Never invent a facial expression from a whole-model rotation. */
export class AvatarFace {
  private bindings: Binding[] = [];
  private expression: Reaction = "neutral";
  readonly capabilities: { smile: boolean; concerned: boolean; curious: boolean; mouth: boolean; blink: boolean };

  constructor(root: Object3D) {
    root.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
      const dictionary = new Map(Object.entries(mesh.morphTargetDictionary).map(([name, index]) => [normalized(name), index]));
      const used = new Set<number>();
      const has = (name: string) => dictionary.has(normalized(name));
      const add = (names: string[], targets: Partial<Omit<Binding, "weights" | "index" | "value">>) => {
        const index = names.map(name => dictionary.get(normalized(name))).find(index => index !== undefined);
        if (index === undefined || used.has(index) || index >= mesh.morphTargetInfluences!.length) return;
        used.add(index);
        this.bindings.push({ weights: mesh.morphTargetInfluences!, index, value: mesh.morphTargetInfluences![index], smile: 0, concerned: 0, curious: 0, mouth: false, blink: false, ...targets });
      };
      add(["expressionSmile"], { smile: 0.65 });
      if (!has("expressionSmile")) {
        add(["mouthSmile", "mouthSmileLeft"], { smile: 0.6 });
        if (!has("mouthSmile")) add(["mouthSmileRight"], { smile: 0.6 });
      }
      add(["expressionConcerned"], { concerned: 0.7 });
      if (!has("expressionConcerned")) {
        add(["mouthFrown", "mouthFrownLeft"], { concerned: 0.65 });
        if (!has("mouthFrown")) add(["mouthFrownRight"], { concerned: 0.65 });
      }
      add(["expressionCurious"], { curious: 0.45 });
      add(["browInnerUp"], { concerned: has("expressionConcerned") ? 0 : 0.6, curious: has("expressionCurious") ? 0 : 0.25 });
      add(["mouthOpen", "jawOpen"], { mouth: true });
      add(["eyeBlink", "eyeBlinkLeft"], { blink: true });
      if (!has("eyeBlink")) add(["eyeBlinkRight"], { blink: true });
    });
    this.capabilities = {
      smile: this.bindings.some(b => b.smile > 0), concerned: this.bindings.some(b => b.concerned > 0),
      curious: this.bindings.some(b => b.curious > 0), mouth: this.bindings.some(b => b.mouth), blink: this.bindings.some(b => b.blink),
    };
  }

  update(reaction: Reaction, level: number, blink: number, dt: number, reduced: boolean, active: boolean) {
    if (!active) this.expression = "neutral";
    else if (reaction !== "nod" && reaction !== "keep_current") this.expression = reaction;
    for (const binding of this.bindings) {
      const target = binding.mouth ? (active ? level : 0) : binding.blink ? (active && !reduced ? blink : 0)
        : this.expression === "smile" ? binding.smile : this.expression === "concerned" ? binding.concerned : this.expression === "curious" ? binding.curious : 0;
      // A static contextual face remains available with Reduce Motion; suppress repetitive blink/body motion.
      binding.value = MathUtils.damp(binding.value, MathUtils.clamp(target, 0, 1), binding.mouth ? 18 : binding.blink ? 35 : reduced ? 3 : 7, dt);
      binding.weights[binding.index] = binding.value;
    }
  }
}

/** Body clips have their own lifetime. Expressions hold; a nod completes once without looping. */
export class AvatarMotion {
  readonly mixer: AnimationMixer;
  private actions = new Map<string, AnimationAction>();
  private action: AnimationAction | undefined;
  private reaction: Reaction | undefined;
  private revision = -1;
  private moving = true;
  private nodFinished = false;
  private finished = (event: { action: AnimationAction }) => {
    if (event.action === this.action && this.reaction === "nod") {
      this.nodFinished = true;
      this.transition(undefined);
    }
  };

  constructor(private root: Object3D, clips: AnimationClip[]) {
    this.mixer = new AnimationMixer(root);
    for (const clip of clips) {
      const name = clip.name.toLowerCase();
      if (!["idle", "nod", "curious", "smile", "concerned"].includes(name) || !Number.isFinite(clip.duration) || clip.duration <= 0) continue;
      // Clip frame zero is the neutral reference. Layer body reactions over breathing/attentive idle.
      const action = this.mixer.clipAction(name === "idle" ? clip : AnimationUtils.makeClipAdditive(clip.clone()));
      action.setLoop(name === "idle" ? LoopRepeat : LoopOnce, name === "idle" ? Infinity : 1);
      action.clampWhenFinished = name !== "idle";
      this.actions.set(name, action);
    }
    this.mixer.addEventListener("finished", this.finished);
  }

  private transition(next: AnimationAction | undefined) {
    if (next === this.action) return;
    this.action?.fadeOut(0.35);
    next?.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.35).play();
    this.action = next;
  }

  hasClip(name: string) { return this.actions.has(name); }

  update(reaction: Reaction, revision: number, dt: number, reduced: boolean, active: boolean) {
    if (reduced || !active) {
      if (this.moving) { this.mixer.stopAllAction(); this.action = undefined; }
      this.moving = false;
      this.reaction = reaction; this.revision = revision;
      // Never replay a nod received while motion was disabled.
      this.nodFinished = true;
      return;
    }
    const resumed = !this.moving;
    this.moving = true;
    const idle = this.actions.get("idle");
    if (idle && !idle.isRunning()) idle.reset().play();
    const changed = reaction !== this.reaction || (reaction === "nod" && revision !== this.revision);
    if (resumed || changed) {
      if (!resumed || changed) this.nodFinished = false;
      this.reaction = reaction; this.revision = revision;
      if (reaction !== "keep_current") this.transition(reaction === "neutral" || (reaction === "nod" && this.nodFinished) ? undefined : this.actions.get(reaction));
    }
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.removeEventListener("finished", this.finished);
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root);
  }
}
