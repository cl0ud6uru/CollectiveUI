"use client";
import { useEffect, useRef, useState } from "react";
import { VoiceReactionStudioClient, type LiveStudioState } from "@/lib/voice/reaction-studio-client";
import type { ReactionPlan } from "@/lib/voice/reaction-library";
import type { AvatarLayerSnapshot } from "@/lib/voice/avatar-layers";

export function VoiceReactionLivePanel({ conversationId, setupMessage, rendered, onPlan, onActiveChange }: {
  conversationId?: string; setupMessage?: string; rendered: AvatarLayerSnapshot | null;
  onPlan: (plan: ReactionPlan, motionEpoch: number) => void; onActiveChange: (active: boolean, running: boolean, mode: LiveStudioState["status"]) => void;
}) {
  const [state, setState] = useState<LiveStudioState>({ status: "idle", heard: "", decision: null, error: null });
  const [text, setText] = useState("");
  const callbacks = useRef({ onPlan, onActiveChange });
  const clientRef = useRef<VoiceReactionStudioClient | null>(null);
  useEffect(() => { callbacks.current = { onPlan, onActiveChange }; }, [onPlan, onActiveChange]);
  useEffect(() => {
    let mounted = true;
    const client = new VoiceReactionStudioClient({ conversationId: conversationId ?? "", changed: value => {
      if (!mounted) return;
      setState(value);
      callbacks.current.onActiveChange(["listening", "text"].includes(value.status), ["connecting", "listening", "text"].includes(value.status), value.status);
    }, plan: (plan, epoch) => { if (mounted) callbacks.current.onPlan(plan, epoch); } });
    clientRef.current = client;
    const stop = () => { client.stop(); setText(""); }; window.addEventListener("pagehide", stop);
    return () => { mounted = false; clientRef.current = null; window.removeEventListener("pagehide", stop); client.dispose(); };
  }, [conversationId]);
  const running = ["connecting", "listening", "text"].includes(state.status);
  return <section className="live-panel" aria-label="Live Decisions test">
    <h2>Live Decisions test</h2>
    <p>Default off. Speaking or typed text goes to the configured OpenAI connection and uses provider usage. Text stays in this page until Stop or leaving; this test saves no chat turns, executes no bot tools and has no speech output.</p>
    {!conversationId && <p className="setup" role="status">{setupMessage ?? "This localhost renderer has no signed-in app session. Open Reaction studio from a chat’s voice window in the authenticated app to use live testing."}</p>}
    <div className="actions"><button disabled={!conversationId || running} onClick={() => { setText(""); void clientRef.current?.start(); }}>Start listening</button><button disabled={!running} onClick={() => { clientRef.current?.stop(); setText(""); }}>Stop listening</button></div>
    <p role="status" aria-live="polite"><strong>{state.status === "listening" ? "● Microphone active · real provider" : state.status === "connecting" ? "Connecting · awaiting permission or provider" : state.status === "text" ? "Typed text · real Decisions" : "Microphone off"}</strong></p>
    {state.error && <p role="alert">{state.error}</p>}
    <label htmlFor="studio-text">Typed text fallback (real Decisions when signed in)</label>
    <textarea id="studio-text" rows={3} maxLength={4000} value={text} disabled={state.status === "connecting" || state.status === "listening"} onChange={e => setText(e.target.value)} placeholder="Describe a story to test…"/>
    <button disabled={!conversationId || !text.trim() || state.status === "connecting" || state.status === "listening"} onClick={() => clientRef.current?.text(text)}>Test text with Decisions</button>
    <h3>{state.status === "text" ? "Typed test text" : "Heard text"}</h3><pre aria-label="Recognized transcript">{state.heard || "No transcript yet."}</pre>
    <h3>Real Decisions result</h3>
    <p>Application: <strong>{state.decision?.reason ?? "No request yet"}</strong>{state.decision ? ` · ${Math.round(state.decision.latencyMs)}ms client latency` : ""}</p>
    {state.decision?.motionDropReason && <p>Motion held: {state.decision.motionDropReason}</p>}
    {state.decision?.decision && <><p>Decisions: {state.decision.decision.status} · {Math.round(state.decision.decision.latencyMs)}ms</p><ul aria-label="Decision choices">{state.decision.decision.answers.map(a => <li key={a.name}>{a.name}: <strong>{a.choice}</strong> · confidence {Math.round(a.confidence * 100)}%</li>)}</ul></>}
    <p aria-label="Rendered reaction">Actually rendered: {rendered ? `${rendered.face} / ${rendered.gesture}${rendered.reduced ? " · Reduce Motion" : ""}${rendered.active ? "" : " · paused"}` : "model loading"}</p>
    <p>Manual library buttons and Showcase are manually selected reactions. They are separate from recognized speech and provider choices.</p>
  </section>;
}
