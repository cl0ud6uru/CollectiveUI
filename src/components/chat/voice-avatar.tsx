"use client";

import { useEffect, useRef, useState } from "react";
import type { Reaction } from "@/lib/voice/policy";

export type VoiceAvatarProps = { reaction: Reaction; reactionRevision: number; audio: HTMLAudioElement | null; modelUrl: string | null; active: boolean; visible: boolean };

/** Optional body clips and facial morphs are discovered at load; voice never waits for the rig. */
export function VoiceAvatar(props: VoiceAvatarProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  const wake = useRef<(() => void) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { live.current = props; wake.current?.(); }, [props]);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const THREE = await import("three");
      const { AvatarFace, AvatarMotion, avatarFraming, avatarFramingDistance } = await import("@/lib/voice/avatar-animation");
      if (cancelled) return;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      element.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      camera.position.set(0, 0.2, 5.5);
      scene.add(new THREE.HemisphereLight(0xe4f8ff, 0x392852, 1.2));
      const key = new THREE.DirectionalLight(0xffffff, 2.8); key.position.set(3, 4, 5); scene.add(key);
      const rim = new THREE.DirectionalLight(0x86dcff, 1.7); rim.position.set(-3, 1, -1); scene.add(rim);
      const root = new THREE.Group(); scene.add(root);
      const material = new THREE.MeshStandardMaterial({ color: 0xb7d7eb, roughness: 0.3, metalness: 0.15 });
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 32), material);
      head.scale.set(1, 1.1, 0.85); root.add(head);
      const dark = new THREE.MeshStandardMaterial({ color: 0x183045, roughness: 0.45 });
      const eyes = [-0.26, 0.26].map(x => {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.072, 20, 12), dark);
        eye.position.set(x, 0.11, 0.65); root.add(eye); return eye;
      });
      const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), dark);
      mouth.position.set(0, -0.23, 0.66); mouth.scale.set(1, 0.18, 0.2); root.add(mouth);
      const torso = new THREE.Mesh(new THREE.SphereGeometry(0.57, 32, 24), material);
      torso.position.y = -1.0; torso.scale.set(1.05, 0.5, 0.7); root.add(torso);
      const placeholder = [...root.children];
      let model: import("three").Object3D | null = null;
      let face: InstanceType<typeof AvatarFace> | null = null;
      let motion: InstanceType<typeof AvatarMotion> | null = null;
      let lastGesture = "";
      let gestureTime = 0;
      let framing: ReturnType<typeof avatarFraming> = null;
      const frameCamera = () => {
        if (!framing) return;
        camera.position.copy(framing.target).add(new THREE.Vector3(0, 0, avatarFramingDistance(framing, camera.aspect, camera.fov)));
        camera.lookAt(framing.target);
      };
      const disposeObject = (object: import("three").Object3D) => object.traverse(child => {
        const mesh = child as import("three").Mesh;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const m of materials) {
          for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
          m.dispose();
        }
      });
      const resize = new ResizeObserver(() => {
        const width = element.clientWidth, height = element.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); frameCamera();
      });
      resize.observe(element);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      let audioContext: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let sourceStream: MediaStream | null = null;
      let frame = 0, previous = performance.now(), renderedAt = 0;
      const samples = new Uint8Array(256);
      const animate = (now: number) => {
        frame = 0;
        if (cancelled) return;
        const current = live.current;
        // Hidden/minimized surfaces suspend frame work, but the bridge and audio continue independently.
        if (!current.visible || document.hidden) { previous = now; return; }
        frame = requestAnimationFrame(animate);
        if (now - renderedAt < 1000 / 30) return;
        renderedAt = now;
        const elapsed = (now - previous) / 1000;
        const dt = Math.min(elapsed, 0.05); previous = now;
        const stream = current.audio?.srcObject;
        if (stream !== sourceStream) {
          source?.disconnect(); source = null; sourceStream = stream instanceof MediaStream ? stream : null;
          try {
            if (sourceStream) {
              audioContext ??= new AudioContext();
              analyser ??= audioContext.createAnalyser(); analyser.fftSize = 512;
              source = audioContext.createMediaStreamSource(sourceStream); source.connect(analyser);
              void audioContext.resume().catch(() => {});
            }
          } catch { /* Audio playback remains independent of the visualization. */ }
        }
        let level = 0;
        if (analyser && source && current.active && current.audio && !current.audio.paused) {
          analyser.getByteTimeDomainData(samples);
          level = Math.min(1, Math.sqrt(samples.reduce((n, s) => n + ((s - 128) / 128) ** 2, 0) / samples.length) * 5);
        }
        const t = now / 1000;
        if (lastGesture !== `${current.reaction}:${current.reactionRevision}`) {
          lastGesture = `${current.reaction}:${current.reactionRevision}`; gestureTime = t;
        }
        const moving = current.active && !reduced.matches;
        const nod = moving && !motion?.hasClip("nod") && current.reaction === "nod" && t - gestureTime < 1.2 ? Math.sin((t - gestureTime) * 10) * 0.12 : 0;
        root.rotation.x = THREE.MathUtils.damp(root.rotation.x, nod, 12, dt);
        root.rotation.z = THREE.MathUtils.damp(root.rotation.z, moving && !motion?.hasClip("curious") && current.reaction === "curious" ? 0.12 : 0, 5, dt);
        root.position.y = moving && !motion?.hasClip("idle") ? Math.sin(t * 1.5) * 0.018 : 0;
        const blink = t % 4.7 > 4.55 ? 1 : 0;
        if (!model) {
          mouth.scale.y = THREE.MathUtils.damp(mouth.scale.y, 0.16 + level * 2, 18, dt);
          mouth.scale.x = THREE.MathUtils.damp(mouth.scale.x, current.active && current.reaction === "smile" ? 1.4 : 1, 7, dt);
          for (const eye of eyes) eye.scale.y = THREE.MathUtils.damp(eye.scale.y, moving && blink ? 0.12 : 1, 35, dt);
        } else {
          // Clips follow elapsed time even on a slow rig/device; damping keeps its bounded step.
          motion?.update(current.reaction, current.reactionRevision, elapsed, reduced.matches, current.active);
          face?.update(current.reaction, level, blink, dt, reduced.matches, current.active);
        }
        renderer.render(scene, camera);
      };
      const resume = () => {
        if (!frame && !cancelled && live.current.visible && !document.hidden) { previous = performance.now(); frame = requestAnimationFrame(animate); }
      };
      wake.current = resume;
      document.addEventListener("visibilitychange", resume);
      resume();
      dispose = () => {
        cancelAnimationFrame(frame); resize.disconnect(); source?.disconnect(); void audioContext?.close();
        document.removeEventListener("visibilitychange", resume); wake.current = null;
        motion?.dispose();
        disposeObject(scene); renderer.dispose(); renderer.domElement.remove();
      };
      if (props.modelUrl) {
        try {
          const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
          const manager = new THREE.LoadingManager();
          manager.setURLModifier(url => {
            if (url.startsWith("blob:") || url.startsWith("data:")) return url;
            const resolved = new URL(url, window.location.href);
            if (resolved.origin !== window.location.origin || !resolved.pathname.startsWith("/avatars/")) throw new Error("Avatar resources must be self-hosted in /avatars.");
            return resolved.href;
          });
          const gltf = await new GLTFLoader(manager).loadAsync(props.modelUrl);
          if (cancelled) { disposeObject(gltf.scene); return; }
          model = gltf.scene;
          const box = new THREE.Box3().setFromObject(model);
          if (box.isEmpty()) { disposeObject(model); model = null; throw new Error("The avatar has no visible geometry."); }
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const scale = 2.4 / Math.max(size.x, size.y, size.z, 0.01);
          model.scale.multiplyScalar(scale); model.position.sub(center.multiplyScalar(scale));
          for (const object of placeholder) { root.remove(object); disposeObject(object); }
          root.add(model);
          framing = avatarFraming(model, new THREE.Box3().setFromObject(model));
          frameCamera();
          face = new AvatarFace(model); motion = new AvatarMotion(model, gltf.animations);
          setError("");
        } catch { if (!cancelled) setError("Avatar model unavailable. Using the placeholder."); }
      }
    })().catch(() => { if (!cancelled) setError("3D is unavailable on this device. Voice still works."); });
    return () => { cancelled = true; dispose?.(); };
  }, [props.modelUrl]);
  return <div className="relative h-full w-full"><div ref={host} className="h-full w-full" role="img" aria-label="Animated voice avatar" />
    {error && <p role="status" className="absolute inset-x-4 bottom-2 text-center text-xs text-white/60">{error}</p>}
  </div>;
}
