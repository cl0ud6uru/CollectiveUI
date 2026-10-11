"use client";

import { useEffect, useRef, useState } from "react";
import { BaseBotAvatar } from "@/components/bots/blob-avatar";
import { Seedling } from "@/components/pets/pet-art";
import { avatar2DPose, type Avatar2DKind, type Avatar2DPose } from "@/lib/voice/avatar-2d";
import type { VoiceAvatarProps } from "./voice-avatar";
import "./voice-avatar-2d.css";

export type Avatar2DMetrics = { kind: Avatar2DKind; pose: Avatar2DPose; frames: number; moving: boolean; speechLevel: number };

/** One clipped image or existing vector icon. No WebGL, React frame renders, or extra raster faces. */
export function VoiceAvatar2D(props: VoiceAvatarProps) {
  const host = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const atlas = useRef<HTMLImageElement>(null);
  const live = useRef(props);
  const wake = useRef<(() => void) | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const pet = props.identity?.pet;
  const seedling = pet?.enabled && (pet.appearance === "moss" || pet.appearance === "ember");
  const sprite = pet?.spriteUrl !== failedSrc && pet?.enabled && (pet.appearance === "catalog" || pet.appearance === "custom") && pet.spriteUrl && pet.spriteVersionNumber;
  const kind: Avatar2DKind = sprite ? "sprite" : seedling ? "seedling" : "icon";
  const rows = pet?.spriteVersionNumber === 2 ? 11 : 9;
  useEffect(() => { live.current = props; wake.current?.(); }, [props]);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false, frame = 0, previous = performance.now(), paintedAt = 0, frames = 0;
    let motionMs = 0, faceMs = 0, idleMs = 0;
    let motionRevision = live.current.motionRevision ?? live.current.reactionRevision;
    let faceRevision = live.current.reactionRevision;
    let context: AudioContext | null = null, analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null, stream: MediaStream | null = null;
    const samples = new Uint8Array(256);
    const releaseAudio = () => {
      source?.disconnect(); source = null; analyser = null; stream = null;
      const old = context; context = null; void old?.close().catch(() => {});
    };
    const moving = () => live.current.active && live.current.visible && !document.hidden && !reduced.matches
      && !live.current.reduceMotion && live.current.identity?.pet?.motion !== "still";
    const paint = (now: number, dt: number) => {
      const current = live.current;
      const revision = current.motionRevision ?? current.reactionRevision;
      if (revision !== motionRevision) { motionRevision = revision; motionMs = 0; }
      if (current.reactionRevision !== faceRevision) { faceRevision = current.reactionRevision; faceMs = 0; }
      const runs = moving();
      if (runs) { motionMs += dt; faceMs += dt; idleMs += dt; }
      else { motionMs = current.plan?.durationMs ?? 6000; faceMs = 6000; idleMs = 0; releaseAudio(); }
      let level = 0;
      if (runs && current.audio && !current.audio.paused) {
        const output = current.audio.srcObject;
        // Only the already-playing output stream is sampled. Never open a microphone or connect to speakers.
        if (typeof MediaStream !== "undefined" && output instanceof MediaStream) {
          if (output !== stream) {
            releaseAudio(); stream = output;
            try {
              context = new AudioContext(); analyser = context.createAnalyser(); analyser.fftSize = 512;
              source = context.createMediaStreamSource(output); source.connect(analyser);
              void context.resume().catch(() => {});
            } catch { releaseAudio(); }
          }
          if (source && analyser) {
            analyser.getByteTimeDomainData(samples);
            level = Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length) * 5);
          }
        } else {
          releaseAudio(); level = current.audio.ended ? 0 : 0.3 + Math.sin(now / 110) ** 2 * 0.3;
        }
      } else if (stream) releaseAudio();
      // Explicit playback state is also used by the offline native/desktop QA surfaces.
      if (runs && current.speaking === true) level = 0.3 + Math.sin(now / 110) ** 2 * 0.3;
      const pose = avatar2DPose({ plan: current.plan, reaction: current.reaction, kind,
        version: current.identity?.pet?.spriteVersionNumber ?? null, motionMs, faceMs, idleMs, speechLevel: level,
        active: current.active, reduced: !runs });
      if (body.current) body.current.style.transform = `translate(${pose.x}px, ${pose.y}px) rotate(${pose.tilt}deg) scale(${pose.scale})`;
      if (atlas.current) atlas.current.style.transform = `translate(${-pose.column * 12.5}%, ${-pose.row / rows * 100}%)`;
      if (host.current) { host.current.dataset.state = pose.state; host.current.dataset.moving = String(runs); }
      frames++;
      current.on2DMetrics?.({ kind, pose, frames, moving: runs, speechLevel: level });
    };
    const tick = (now: number) => {
      frame = 0;
      if (disposed) return;
      if (!moving()) { paint(now, 0); return; }
      frame = requestAnimationFrame(tick);
      if (now - paintedAt < 1000 / 30) return;
      const dt = Math.min(now - previous, 100); previous = now; paintedAt = now;
      paint(now, dt);
    };
    const resume = () => {
      if (disposed) return;
      const now = performance.now(); previous = now;
      paint(now, 0);
      if (moving()) { if (!frame) frame = requestAnimationFrame(tick); }
      else { cancelAnimationFrame(frame); frame = 0; }
    };
    wake.current = resume;
    document.addEventListener("visibilitychange", resume); reduced.addEventListener("change", resume);
    resume();
    return () => {
      disposed = true; cancelAnimationFrame(frame); releaseAudio(); wake.current = null;
      document.removeEventListener("visibilitychange", resume); reduced.removeEventListener("change", resume);
    };
  }, [kind, rows, pet?.spriteUrl]);
  return <div ref={host} className="voice-avatar-2d" data-kind={kind} data-bot-id={props.identity?.botId} role="img" aria-label="Voice avatar">
    <div ref={body} className="voice-avatar-2d-body" aria-hidden="true">
      {sprite ? <span className="voice-avatar-2d-cell">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={atlas} src={pet!.spriteUrl!} alt="" draggable={false} style={{ height: `${rows * 100}%` }} onError={() => setFailedSrc(pet!.spriteUrl)}
          onLoad={event => { const image = event.currentTarget; if (image.naturalWidth !== 1536 || image.naturalHeight !== rows * 208) setFailedSrc(pet!.spriteUrl); }} />
      </span> : seedling ? <Seedling ember={pet!.appearance === "ember"} /> : <BaseBotAvatar value={props.identity?.icon} size={220} />}
    </div>
  </div>;
}
