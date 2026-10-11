import { describe, expect, it } from "vitest";
import { avatar2DPose, nativeAvatarIdentity, voicePetIdentity } from "@/lib/voice/avatar-2d";
import { legacyPlan, REACTION_LIBRARY } from "@/lib/voice/reaction-library";
import { DEFAULT_PET } from "@/lib/pets/shared";

const input = { reaction: "neutral" as const, kind: "sprite" as const, version: 2 as const,
  motionMs: 1400, faceMs: 1400, idleMs: 400, speechLevel: 0, active: true, reduced: false };
describe("capability-aware 2D voice poses", () => {
  it("uses only available rows/cells for every shared intent on v1 and v2", () => {
    for (const preset of REACTION_LIBRARY) for (const version of [1, 2] as const) for (const ms of [0, 350, 700, 1400, 4000, 10000]) {
      const pose = avatar2DPose({ ...input, plan: preset.plan, version, motionMs: ms, faceMs: ms });
      expect(pose.row).toBeLessThan(version === 2 ? 11 : 9);
      expect(pose.column).toBeLessThan(pose.row === 3 ? 4 : pose.row <= 8 ? 6 : 8);
      expect([0, 3, 8, 9, 10]).toContain(pose.row);
      expect(Math.abs(pose.tilt)).toBeLessThanOrEqual(7);
      expect(pose.scale).toBeGreaterThanOrEqual(0.95);
      expect(pose.scale).toBeLessThanOrEqual(1.05);
    }
  });
  it("maps positive warmth to one real wave and then returns to idle", () => {
    const plan = legacyPlan("smile");
    expect(avatar2DPose({ ...input, plan, faceMs: 350 }).row).toBe(3);
    expect(avatar2DPose({ ...input, plan, faceMs: 900 }).row).toBe(0);
  });
  it("uses the real v2 left/right cells and a restrained v1 orientation fallback", () => {
    const plan = { ...legacyPlan("neutral"), gesture: "look_left" as const };
    expect(avatar2DPose({ ...input, plan })).toMatchObject({ row: 10, column: 4, state: "look" });
    expect(avatar2DPose({ ...input, plan: { ...plan, gesture: "look_right" } })).toMatchObject({ row: 9, column: 4 });
    expect(avatar2DPose({ ...input, plan, version: 1 })).toMatchObject({ row: 0, state: "idle" });
  });
  it("honors intensity, tempo, expiry, Reduce Motion, and stopped state", () => {
    const plan = { ...legacyPlan("curious"), gesture: "tilt_left" as const, intensity: 1 };
    const strong = avatar2DPose({ ...input, plan });
    expect(strong.tilt).toBe(-7);
    expect(avatar2DPose({ ...input, plan: { ...plan, intensity: 0.35 } }).tilt).toBeCloseTo(-2.45);
    expect(avatar2DPose({ ...input, plan: { ...plan, tempo: 0.7 } }).tilt).not.toBe(strong.tilt);
    for (const override of [{ reduced: true }, { active: false }]) expect(avatar2DPose({ ...input, plan, ...override })).toEqual({ row: 0, column: 0, state: "idle", x: 0, y: 0, tilt: 0, scale: 1 });
    expect(avatar2DPose({ ...input, plan, motionMs: 10000 }).tilt).toBeCloseTo(0);
  });
  it("pulses the body without changing atlas frames or the original icon", () => {
    const still = avatar2DPose({ ...input, kind: "icon" });
    const speaking = avatar2DPose({ ...input, kind: "icon", speechLevel: 1 });
    expect(speaking.scale - still.scale).toBeCloseTo(0.025);
    expect(speaking.row).toBe(still.row);
    expect(voicePetIdentity({ ...DEFAULT_PET, enabled: true, motion: "still" })).toMatchObject({ motion: "still", spriteUrl: null });
  });
});
describe("native identity input", () => {
  it("keeps the original icon and accepts bounded PNG bytes only", () => {
    const identity = { botId: "bot1", icon: "blob:ghost:teal", pet: { enabled: true, appearance: "catalog", motion: "auto", spriteVersionNumber: 2, spriteUrl: "data:image/png;base64,iVBORw==" } };
    expect(nativeAvatarIdentity(identity)).toEqual(identity);
    for (const spriteUrl of ["https://other.example/pet.png", "/api/bots/other/pet/avatar", "data:image/svg+xml,<svg/>", "data:image/png;base64," + "a".repeat(5_600_000)]) {
      expect(nativeAvatarIdentity({ ...identity, pet: { ...identity.pet, spriteUrl } })?.pet?.spriteUrl).toBeNull();
    }
    expect(nativeAvatarIdentity(null)).toBeNull();
  });
});
