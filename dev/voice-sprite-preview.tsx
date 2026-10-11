import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceAvatar } from "@/components/chat/voice-avatar";
import { REACTION_LIBRARY, legacyReaction, type ReactionPlan } from "@/lib/voice/reaction-library";
import type { Avatar2DMetrics } from "@/components/chat/voice-avatar-2d";
import type { VoiceAvatarIdentity } from "@/lib/voice/avatar-2d";

const pets = ["hermes", "hermes-assimilated", "the-queen", "nimbus"];
const icons = ["blob:circle:purple", "blob:triangle:orange", "blob:egg:pink", "blob:hexagon:blue", "blob:ghost:teal", "blob:drop:yellow", "blob:pill:red", "🤖"];
const choices = [...pets, "moss", "ember", ...icons, "missing", "invalid", "legacy", "still"];
let metrics: Avatar2DMetrics | null = null;
const identity = (id: string): VoiceAvatarIdentity => ({ botId: `fixture-${id}`, icon: id.startsWith("blob:") || id === "🤖" ? id : "blob:ghost:teal",
  pet: pets.includes(id) || ["missing", "invalid", "legacy", "still"].includes(id) ? { enabled: true, appearance: "catalog", motion: id === "still" ? "still" : "auto",
    spriteVersionNumber: id === "legacy" ? 1 : 2, spriteUrl: id === "missing" ? "/sprites/missing.webp" : id === "invalid" ? "/invalid.png" : `/sprites/${id === "still" ? "hermes" : id}.webp` }
    : id === "moss" || id === "ember" ? { enabled: true, appearance: id, motion: "auto", spriteUrl: null, spriteVersionNumber: null } : null });
declare global { interface Window { spritePreview: { play: (id: string) => void; select: (id: string) => void; metrics: () => Avatar2DMetrics | null } } }
function App() {
  const [selected, select] = useState("hermes");
  const [preset, setPreset] = useState(REACTION_LIBRARY.find(p => p.id === "neutral:attentive")!);
  const [revision, setRevision] = useState(0), [motion, setMotion] = useState(0);
  const [active, setActive] = useState(true), [visible, setVisible] = useState(true), [speaking, setSpeaking] = useState(false), [reduced, setReduced] = useState(false);
  const play = useCallback((id: string) => { const next = REACTION_LIBRARY.find(p => p.id === id); if (!next) return; setPreset(next); setActive(true); setRevision(value => value + 1); setMotion(value => value + 1); }, []);
  useEffect(() => { window.spritePreview = { play, select, metrics: () => metrics }; }, [play]);
  return <main><header><span>COLLECTIVEUI · VOICE AVATARS</span><h1>Same companion. More presence.</h1><p>Offline voice and reaction preview · microphone off</p></header>
    <div className="studio"><section className="stage"><div className="avatar">
      <VoiceAvatar identity={identity(selected)} reaction={legacyReaction(preset.plan.face)} reactionRevision={revision} motionRevision={motion} plan={preset.plan as ReactionPlan}
        modelUrl={null} active={active} visible={visible} audio={null} speaking={speaking} reduceMotion={reduced} on2DMetrics={value => { metrics = value; }} />
      </div><div className="caption"><strong>{selected}</strong><span>{active ? speaking ? "Speaking · body pulse" : "Listening" : "Stopped"}</span></div></section>
      <section className="controls"><label>Companion<select id="companion" value={selected} onChange={event => { select(event.target.value); setRevision(value => value + 1); setMotion(value => value + 1); }}>{choices.map(id => <option key={id}>{id}</option>)}</select></label>
        <label>Shared reaction intent<select id="preset" value={preset.id} onChange={event => play(event.target.value)}>{REACTION_LIBRARY.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <div className="reactions">{["neutral:attentive", "warm:small_nod", "curious:tilt_left", "serious:lean_in", "neutral:look_left", "neutral:look_right"].map(id => <button key={id} onClick={() => play(id)}>{REACTION_LIBRARY.find(p => p.id === id)!.label}</button>)}</div>
        <div className="actions"><button onClick={() => play(preset.id)}>Replay</button><button onClick={() => { setActive(false); setSpeaking(false); }}>Stop</button></div>
        <label className="check"><input type="checkbox" checked={speaking} onChange={event => setSpeaking(event.target.checked)} />Mock speaking</label>
        <label className="check"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />Visible</label>
        <label className="check"><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />Reduce motion</label>
        <p className="limits">Real idle, wave, review and left/right look cells. Sprites keep their existing faces; icons use body motion. Speech pulses indicate output activity, without lip-sync.</p>
        <a href="/native">Bundled iOS engine fixture</a>
      </section></div></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
