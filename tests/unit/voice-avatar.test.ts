import { describe, expect, it } from "vitest";
import { AnimationClip, Bone, Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, NumberKeyframeTrack, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from "three";
import { AvatarFace, AvatarMotion, avatarFraming, avatarFramingDistance } from "@/lib/voice/avatar-animation";

const step = (callback: () => void, seconds = 1) => { for (let i = 0; i < seconds * 60; i++) callback(); };
function faceFixture(names = ["browInnerUp", "mouthFrown", "mouthSmile"]) {
  const mesh = new Mesh();
  mesh.morphTargetDictionary = Object.fromEntries(names.map((name, i) => [name, i]));
  mesh.morphTargetInfluences = names.map(() => 0);
  return { mesh, face: new AvatarFace(mesh), weights: mesh.morphTargetInfluences };
}
const clip = (name: string, value: number, duration = 1) => new AnimationClip(name, duration, [new NumberKeyframeTrack(".rotation[x]", [0, duration], [0, value])]);

function framingRig(headMin: Vector3, headMax: Vector3, pivot: number) {
  const root = new Group(), geometry = new BufferGeometry();
  const points = [-0.9, -1.2, -0.4, 0.9, 1.2, 0.4];
  for (const x of [headMin.x, headMax.x]) for (const y of [headMin.y, headMax.y]) for (const z of [headMin.z, headMax.z]) points.push(x, y, z);
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(points.flatMap((_, i) => i % 3 === 0 ? [i < 6 ? 0 : 1, 0, 0, 0] : []), 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(points.flatMap((_, i) => i % 3 === 0 ? [1, 0, 0, 0] : []), 4));
  const mesh = new SkinnedMesh(geometry), base = new Bone(), head = new Bone();
  head.name = "head"; head.position.y = pivot; base.add(head); mesh.add(base); root.add(mesh);
  root.updateMatrixWorld(true); mesh.bind(new Skeleton([base, head]));
  return { root, mesh, bounds: new Box3().setFromObject(root) };
}

describe("capability-aware voice avatar", () => {
  it("frames a known head rig for visible reactions and retains full-model framing for unknown rigs", () => {
    const root = new Group(); const head = new Bone(); head.name = "Head"; head.position.y = 0.9; root.add(head);
    const bounds = new Box3(new Vector3(-0.5, -1.2, -0.4), new Vector3(0.5, 1.2, 0.4));
    const framing = avatarFraming(root, bounds)!;
    expect(framing.target.y).toBeCloseTo(0.948); expect(framing.distance).toBeCloseTo(1.32);
    expect(avatarFraming(new Group(), bounds)).toBeNull();
    head.position.y = 8; expect(avatarFraming(root, bounds)).toBeNull();
  });

  it("fits a head-heavy bust on square and portrait canvases without moving its anatomical bone", () => {
    const { root, bounds } = framingRig(new Vector3(-0.8, -0.25, -0.3), new Vector3(0.8, 1.2, 0.4), -0.3);
    const framing = avatarFraming(root, bounds)!;
    expect(framing.fitBounds).toBeDefined(); expect(framing.target.y).toBeCloseTo(0.523);
    let squareDistance = 0;
    for (const aspect of [1, 390 / 650]) {
      const distance = avatarFramingDistance(framing, aspect, 35);
      if (aspect === 1) squareDistance = distance;
      else expect(distance).toBeGreaterThan(squareDistance);
      const vertical = Math.tan(35 * Math.PI / 360);
      for (const x of [-0.8, 0.8]) for (const y of [-0.25, 1.2]) for (const z of [-0.3, 0.4]) {
        const depth = framing.target.z + distance - z;
        expect(Math.abs(x - framing.target.x) / (depth * vertical * aspect)).toBeLessThan(0.9);
        expect(Math.abs(y - framing.target.y) / (depth * vertical)).toBeLessThan(0.9);
      }
    }
  });

  it("retains full-body framing with real skin weights and handles absent head geometry", () => {
    const { root, mesh, bounds } = framingRig(new Vector3(-0.25, 0.66, -0.27), new Vector3(0.27, 1.2, 0.19), 0.81);
    const framing = avatarFraming(root, bounds)!;
    expect(framing.fitBounds).toBeUndefined(); expect(framing.target.y).toBeCloseTo(0.858);
    expect(avatarFramingDistance(framing, 390 / 650, 35)).toBeCloseTo(1.32);
    mesh.geometry.deleteAttribute("skinWeight");
    expect(avatarFraming(root, bounds)!.fitBounds).toBeUndefined();
  });

  it("begins a real concerned facial deformation smoothly and holds it during a long story", () => {
    const { face, weights } = faceFixture();
    face.update("concerned", 0, 0, 1 / 60, false, true);
    expect(weights[0]).toBeGreaterThan(0); expect(weights[0]).toBeLessThan(0.6);
    expect(weights[1]).toBeGreaterThan(0); expect(weights[2]).toBe(0);
    step(() => face.update("concerned", 0, 0, 1 / 60, false, true), 6);
    expect(weights[0]).toBeCloseTo(0.6); expect(weights[1]).toBeCloseTo(0.65);
    step(() => face.update("neutral", 0, 0, 1 / 60, false, true), 2);
    expect(weights.every(weight => weight < 0.001)).toBe(true);
  });

  it("crossfades concern into a smile without restarting on repeated evidence; nod preserves the face", () => {
    const { face, weights } = faceFixture();
    step(() => face.update("concerned", 0, 0, 1 / 60, false, true));
    face.update("smile", 0, 0, 1 / 60, false, true);
    expect(weights[1]).toBeGreaterThan(0); expect(weights[2]).toBeGreaterThan(0);
    step(() => face.update("smile", 0, 0, 1 / 60, false, true));
    step(() => face.update("nod", 0, 0, 1 / 60, false, true));
    expect(weights[2]).toBeCloseTo(0.6); expect(weights[1]).toBeLessThan(0.001);
  });

  it("supports partial/case-insensitive rigs and safely leaves absent morphs alone", () => {
    const { face, weights } = faceFixture(["Mouth_Frown_Left", "mouthFrownRight", "unrelated"]);
    weights[2] = 0.3;
    step(() => face.update("concerned", 1, 1, 1 / 60, false, true));
    expect(weights[0]).toBeCloseTo(0.65); expect(weights[1]).toBeCloseTo(0.65); expect(weights[2]).toBe(0.3);
    expect(face.capabilities).toMatchObject({ concerned: true, mouth: false, blink: false });
    const empty = new AvatarFace(new Group());
    expect(() => empty.update("concerned", 1, 1, 0.05, false, true)).not.toThrow();
    expect(empty.capabilities.concerned).toBe(false);
  });

  it("respects reduced motion while retaining a static face and independent optional audio mouth", () => {
    const { face, weights } = faceFixture(["mouthFrown", "jawOpen", "eyeBlink"]);
    step(() => face.update("concerned", 0.8, 1, 1 / 60, true, true), 3);
    expect(weights[0]).toBeCloseTo(0.65); expect(weights[1]).toBeCloseTo(0.8); expect(weights[2]).toBe(0);
    step(() => face.update("concerned", 0.8, 1, 1 / 60, true, false), 3);
    expect(weights[0]).toBeLessThan(0.001); expect(weights[1]).toBeLessThan(0.001);
  });

  it("completes a nod once and returns to idle without a hard-coded three second reset", () => {
    const root = new Group(); const motion = new AvatarMotion(root, [clip("idle", 0), clip("nod", 0.3)]);
    step(() => motion.update("nod", 1, 1 / 60, false, true), 0.6);
    expect(root.rotation.x).toBeGreaterThan(0.1);
    step(() => motion.update("nod", 1, 1 / 60, false, true), 2);
    expect(root.rotation.x).toBeCloseTo(0);
    motion.dispose();
  });

  it("holds an expression clip beyond three seconds and releases it when meaning changes", () => {
    const root = new Group(); const motion = new AvatarMotion(root, [clip("idle", 0), clip("concerned", 0.2)]);
    step(() => motion.update("concerned", 1, 1 / 60, false, true), 5);
    expect(root.rotation.x).toBeCloseTo(0.2);
    step(() => motion.update("concerned", 2, 1 / 60, false, true));
    expect(root.rotation.x).toBeCloseTo(0.2);
    step(() => motion.update("neutral", 3, 1 / 60, false, true));
    expect(root.rotation.x).toBeCloseTo(0);
    motion.dispose();
  });

  it("keeps attentive idle moving beneath a held body reaction", () => {
    const root = new Group();
    const idle = new AnimationClip("idle", 1, [new NumberKeyframeTrack(".rotation[y]", [0, 1], [0, 0.1])]);
    const motion = new AvatarMotion(root, [idle, clip("concerned", 0.2)]);
    step(() => motion.update("concerned", 1, 1 / 60, false, true), 4.5);
    const first = root.rotation.y;
    step(() => motion.update("concerned", 1, 1 / 60, false, true), 0.25);
    expect(root.rotation.x).toBeCloseTo(0.2);
    expect(root.rotation.y).toBeGreaterThan(first + 0.01);
    motion.dispose();
  });

  it("suppresses body clips with reduced motion and handles missing/invalid clips", () => {
    const root = new Group(); const motion = new AvatarMotion(root, [clip("nod", 0.3), clip("concerned", 0.2), clip("idle", 0, 0)]);
    step(() => motion.update("nod", 1, 1 / 60, true, true), 2);
    expect(root.rotation.x).toBe(0);
    step(() => motion.update("nod", 1, 1 / 60, false, true), 2);
    expect(root.rotation.x).toBe(0);
    step(() => motion.update("smile", 2, 1 / 60, false, true));
    expect(root.rotation.x).toBe(0); expect(motion.hasClip("idle")).toBe(false);
    motion.dispose();
  });

  it("plays a fresh nod arriving as reduced motion is disabled, while retaining old-nod suppression", () => {
    const root = new Group(); const motion = new AvatarMotion(root, [clip("idle", 0), clip("nod", 0.3)]);
    motion.update("neutral", 0, 0.05, true, true);
    step(() => motion.update("nod", 1, 1 / 60, false, true), 0.6);
    expect(root.rotation.x).toBeGreaterThan(0.1);
    step(() => motion.update("nod", 1, 1 / 60, false, true), 2);
    expect(root.rotation.x).toBeCloseTo(0);
    motion.dispose();
  });
});
