"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceAvatar } from "@/components/chat/voice-avatar";
import { FACE_LABELS, FACE_PROFILES, REACTION_LIBRARY, legacyReaction, type ReactionPlan } from "@/lib/voice/reaction-library";
import type { AvatarLayerSnapshot } from "@/lib/voice/avatar-layers";

declare global { interface Window { reactionPreview?: { play: (id: string) => void; stop: () => void; metrics: () => AvatarLayerSnapshot | null } } }
import type { LiveStudioState } from "@/lib/voice/reaction-studio-client";
import { VoiceReactionLivePanel } from "./voice-reaction-live-panel";
import { STUDIO_CSS } from "./voice-reaction-studio-style";

export function VoiceReactionStudio({ initialModelUrl = "/avatars/preview.glb", conversationId, setupMessage, modelOptions }: { initialModelUrl?: string | null; conversationId?: string; setupMessage?: string; modelOptions?: { label: string; url: string }[] }) {
  const [selected, setSelected] = useState(REACTION_LIBRARY[0]);
  const [plan, setPlan] = useState<ReactionPlan>(selected.plan);
  const [revision, setRevision] = useState(0);
  const [motionRevision, setMotionRevision] = useState(0);
  const lastProviderMotion = useRef(-1);
  const [requestedAt, setRequestedAt] = useState(0);
  const [modelUrl, setModelUrl] = useState<string | null>(initialModelUrl);
  const [metrics, setMetrics] = useState<AvatarLayerSnapshot | null>(null);
  const [reduced, setReduced] = useState(false);
  const [active, setActive] = useState(true);
  const [showcase, setShowcase] = useState(false);
  const [liveRunning, setLiveRunning] = useState(false);
  const [mode, setMode] = useState<LiveStudioState["status"]>("idle");
  const [showMetrics, setShowMetrics] = useState(false);
  const play = useCallback((id: string) => {
    const preset = REACTION_LIBRARY.find(p => p.id === id); if (!preset) return;
    setSelected(preset); setPlan(preset.plan); setRequestedAt(performance.now()); setRevision(v => v + 1); setMotionRevision(v => v + 1); setActive(true);
  }, []);
  useEffect(() => {
    window.reactionPreview = { play, stop: () => { setActive(false); setShowcase(false); }, metrics: () => metrics };
    return () => { delete window.reactionPreview; };
  }, [metrics, play]);
  useEffect(() => {
    if (!showcase) return;
    const ids = ["warm:small_nod", "curious:tilt_left", "sympathetic:slow_nod", "reassuring:lean_in", "serious:look_right", "warm:double_nod"];
    let index = 0;
    const timer = setInterval(() => { play(ids[index++ % ids.length]); }, 3600);
    return () => clearInterval(timer);
  }, [showcase, play]);
  useEffect(() => () => { if (modelUrl?.startsWith("blob:")) URL.revokeObjectURL(modelUrl); }, [modelUrl]);
  const adjust = (key: "intensity" | "tempo" | "durationMs", value: number) => {
    setPlan(p => ({ ...p, [key]: value })); setRequestedAt(performance.now()); setRevision(v => v + 1); setMotionRevision(v => v + 1); setActive(true);
  };
  const providerPlan = useCallback((value: ReactionPlan, epoch: number) => {
    setShowcase(false); setPlan(value); setRequestedAt(performance.now()); setRevision(v => v + 1);
    if (epoch !== lastProviderMotion.current) { lastProviderMotion.current = epoch; setMotionRevision(v => v + 1); }
    const preset = REACTION_LIBRARY.find(p => p.plan.face === value.face && p.plan.gesture === value.gesture); if (preset) setSelected(preset);
  }, []);
  const listening = useCallback((value: boolean, running: boolean, nextMode: LiveStudioState["status"]) => { setActive(value); setLiveRunning(running); setMode(nextMode); setShowcase(false); }, []);
  const manualControls = (
      <fieldset disabled={liveRunning}><legend>Manual reactions</legend>
      <label className="label" htmlFor="preset">Reaction library</label><select id="preset" value={selected.id} onChange={e => { setShowcase(false); play(e.target.value); }}>{REACTION_LIBRARY.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      <div className="faces" role="group" aria-label="Facial recipe">{FACE_PROFILES.map(face => <button key={face} aria-pressed={plan.face === face} onClick={() => { setShowcase(false); play(`${face}:${plan.gesture}`); }}>{FACE_LABELS[face]}</button>)}</div>
      <div className="motions">{REACTION_LIBRARY.filter(p => p.plan.face === plan.face).map(p => <button key={p.id} aria-pressed={plan.gesture === p.plan.gesture} onClick={() => { setShowcase(false); play(p.id); }}>{p.label.replace(FACE_LABELS[plan.face] + " ", "")}</button>)}</div>
      <label>Intensity <output>{plan.intensity.toFixed(2)}</output><input aria-label="Intensity" type="range" min="0.35" max="1" step="0.05" value={plan.intensity} onChange={e => adjust("intensity", +e.target.value)}/></label>
      <label>Tempo <output>{plan.tempo.toFixed(2)}×</output><input aria-label="Tempo" type="range" min="0.7" max="1.35" step="0.05" value={plan.tempo} onChange={e => adjust("tempo", +e.target.value)}/></label>
      <label>Gesture duration <output>{(plan.durationMs / 1000).toFixed(1)}s</output><input aria-label="Gesture duration" type="range" min="1200" max="6000" step="100" value={plan.durationMs} onChange={e => adjust("durationMs", +e.target.value)}/></label>
      <div className="actions"><button className="primary" onClick={() => { setRequestedAt(performance.now()); setRevision(v => v + 1); setMotionRevision(v => v + 1); setActive(true); }}>Replay</button><button onClick={() => { setActive(false); setShowcase(false); }}>Stop</button><button aria-pressed={showcase} onClick={() => { setShowcase(v => !v); setActive(true); }}>Showcase</button></div>
      </fieldset>
  );
  const livePanel = <VoiceReactionLivePanel key={conversationId} conversationId={conversationId} setupMessage={setupMessage} rendered={metrics} onPlan={providerPlan} onActiveChange={listening}/>;
  return <div className={`reaction-studio-shell${conversationId ? " authenticated-studio" : ""}`}><style>{STUDIO_CSS}</style><main>
    <header><div className="eyebrow">COLLECTIVEUI · REACTION STUDIO</div><h1>Borg Hermes, listening.</h1><p>60 named face and motion combinations. Explore manually, or explicitly start an authenticated live Decisions test.</p></header>
    <div className="studio"><section className="stage" aria-label="Avatar preview">
      <div className="avatar"><VoiceAvatar reaction={legacyReaction(plan.face)} reactionRevision={revision} motionRevision={motionRevision} plan={plan} planRequestedAt={requestedAt} audio={null} modelUrl={modelUrl} active={active} visible={true} onMotionMetrics={setMetrics} reduceMotion={reduced}/></div>
      <div className="caption"><span className="dot"/><strong>{selected.label}</strong><span>{mode === "listening" ? "Live microphone · Decisions" : mode === "text" ? "Typed text · Decisions" : mode === "connecting" ? "Connecting live test" : active ? "Manual preview" : "Manual preview · paused"}</span></div>
    </section><section className="controls" aria-label="Reaction controls">
      {conversationId && livePanel}
      {conversationId ? <details className="manual-library"><summary>Manual reaction library</summary>{manualControls}</details> : manualControls}
      <label className="check"><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)}/>Reduce motion (system preference also applies)</label>
      <label className="check"><input type="checkbox" checked={showMetrics} onChange={e => setShowMetrics(e.target.checked)}/>Show local numeric diagnostics</label>
      {!conversationId && livePanel}
      {modelOptions && <label>Preview asset (explicit selection)<select disabled={liveRunning} value={modelUrl ?? ""} onChange={e => { setModelUrl(e.target.value); setMetrics(null); }}>{modelOptions.map(m => <option key={m.url} value={m.url}>{m.label}</option>)}</select></label>}
      <details><summary>Model capabilities</summary><p>Six facial recipes share the available morphs. Head glances rotate the head; eye gaze, blink and speech mouth appear only when supported. Missing controls are omitted.</p><p>{metrics ? `Bones: ${metrics.supportedBones.join(", ") || "none"}. Morphs: ${metrics.supportedMorphs.join(", ") || "none"}. Missing for this face: ${metrics.missingMorphs.join(", ") || "none"}.` : "Loading model…"}</p><label>Load a local GLB<input type="file" disabled={liveRunning} accept=".glb" onChange={e => { const file = e.target.files?.[0]; if (file) { setModelUrl(URL.createObjectURL(file)); setMetrics(null); } }}/></label></details>
      {showMetrics && metrics && <pre aria-label="Local motion diagnostics">{JSON.stringify(metrics, null, 2)}</pre>}
    </section></div><footer>Face holds independently as gestures settle. Manual preview uses no audio. Live test is explicit, ephemeral and uses the existing authorized connection.</footer>
  </main></div>;
}
