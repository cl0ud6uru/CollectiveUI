import type { PetView } from "@/lib/pets/shared";
import { legacyPlan, type ReactionPlan } from "./reaction-library";
import type { Reaction } from "./policy";

export type VoicePetIdentity = {
  enabled: boolean; appearance: string; motion: string;
  spriteUrl: string | null; spriteVersionNumber: 1 | 2 | null;
};
export type VoiceAvatarIdentity = { botId?: string; icon?: string | null; pet?: VoicePetIdentity | null };
export function voicePetIdentity(pet?: PetView): VoicePetIdentity | null {
  return pet ? { enabled: pet.enabled, appearance: pet.appearance, motion: pet.motion,
    spriteUrl: pet.spriteUrl, spriteVersionNumber: pet.custom?.spriteVersionNumber ?? null } : null;
}

/** Native receives artwork bytes from its authenticated APIClient, never credentials or arbitrary URLs. */
export function nativeAvatarIdentity(value: unknown): VoiceAvatarIdentity | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const result: VoiceAvatarIdentity = {};
  if (typeof input.botId === "string" && input.botId.length <= 200) result.botId = input.botId;
  if (typeof input.icon === "string" && input.icon.length <= 100) result.icon = input.icon;
  if (input.pet && typeof input.pet === "object") {
    const pet = input.pet as Record<string, unknown>;
    const version = pet.spriteVersionNumber === 1 || pet.spriteVersionNumber === 2 ? pet.spriteVersionNumber : null;
    if (pet.enabled === true && ["moss", "ember", "custom", "catalog"].includes(String(pet.appearance))) {
      result.pet = { enabled: true, appearance: String(pet.appearance), motion: pet.motion === "still" ? "still" : "auto",
        spriteVersionNumber: version, spriteUrl: version && typeof pet.spriteUrl === "string"
          && pet.spriteUrl.length <= 5_600_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(pet.spriteUrl) ? pet.spriteUrl : null };
    }
  }
  return result;
}

export type Avatar2DKind = "sprite" | "seedling" | "icon";
export type Avatar2DPose = { row: number; column: number; state: "idle" | "wave" | "review" | "look";
  x: number; y: number; tilt: number; scale: number };
const rows = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  wave: { row: 3, durations: [140, 140, 140, 280] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
} as const;
function frameAt(durations: readonly number[], milliseconds: number): number {
  const duration = durations.reduce((sum, value) => sum + value, 0);
  let time = Math.max(0, milliseconds) % duration;
  for (let i = 0; i < durations.length; i++) { if (time < durations[i]) return i; time -= durations[i]; }
  return 0;
}

/** Real atlas presentations, plus bounded whole-body gestures. No fabricated facial/blink frames. */
export function avatar2DPose(input: { plan?: ReactionPlan; reaction: Reaction; kind: Avatar2DKind; version: 1 | 2 | null;
  motionMs: number; faceMs: number; idleMs: number; speechLevel: number; active: boolean; reduced: boolean }): Avatar2DPose {
  const plan = input.plan ?? legacyPlan(input.reaction);
  const still: Avatar2DPose = { row: 0, column: 0, state: "idle", x: 0, y: 0, tilt: 0, scale: 1 };
  if (!input.active || input.reduced) return still;
  const intensity = Math.max(0.35, Math.min(1, plan.intensity));
  const tempo = Math.max(0.7, Math.min(1.35, plan.tempo));
  const motionMs = input.motionMs * tempo;
  const progress = Math.max(0, Math.min(1, motionMs / plan.durationMs));
  // Every posture returns to neutral, including tilt/look/lean. Reaction changes can cancel it immediately.
  const envelope = Math.sin(Math.PI * progress) ** 2;
  const pose = { ...still, column: frameAt(rows.idle.durations, input.idleMs) };
  if (input.kind === "sprite") {
    const faceMs = input.faceMs * tempo;
    if ((plan.face === "warm" || plan.face === "reassuring") && faceMs < 700) {
      pose.state = "wave"; pose.row = rows.wave.row; pose.column = frameAt(rows.wave.durations, faceMs);
    } else if (["curious", "sympathetic", "serious"].includes(plan.face) && faceMs < 1030) {
      pose.state = "review"; pose.row = rows.review.row; pose.column = frameAt(rows.review.durations, faceMs);
    }
    if (input.version === 2 && envelope > 0.15 && (plan.gesture === "look_left" || plan.gesture === "look_right")) {
      // Canonical v2 direction cells: 270° screen-left and 90° screen-right. v1 has no look rows.
      pose.state = "look"; pose.row = plan.gesture === "look_left" ? 10 : 9; pose.column = 4;
    }
  }
  const strength = intensity * envelope;
  switch (plan.gesture) {
    case "small_nod": case "slow_nod": case "double_nod": {
      const cycles = plan.gesture === "double_nod" ? 2 : 1;
      const pulse = (1 - Math.cos(progress * Math.PI * 2 * cycles)) / 2;
      pose.y += 4.5 * intensity * pulse; pose.scale -= 0.012 * intensity * pulse; break;
    }
    case "tilt_left": pose.tilt = -7 * strength; break;
    case "tilt_right": pose.tilt = 7 * strength; break;
    case "look_left": pose.x = -3 * strength; if (input.version !== 2 || input.kind !== "sprite") pose.tilt = -3 * strength; break;
    case "look_right": pose.x = 3 * strength; if (input.version !== 2 || input.kind !== "sprite") pose.tilt = 3 * strength; break;
    case "lean_in": pose.scale += 0.045 * strength; break;
    case "lean_back": pose.scale -= 0.03 * strength; break;
  }
  // Output amplitude drives a body pulse; there is no claimed lip-sync or speaking mouth in the atlases/icons.
  const speech = Math.max(0, Math.min(1, input.speechLevel));
  pose.scale += speech * 0.025;
  if (input.kind !== "sprite") pose.y -= Math.sin(input.idleMs / 1700) * 0.65;
  return pose;
}
