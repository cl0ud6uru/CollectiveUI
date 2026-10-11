"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Headphones, Loader2, Mic, MicOff, Square, Minimize2, Captions } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { VoiceAvatar } from "./voice-avatar";
import { VoiceBridge } from "@/lib/voice/bridge";
import { legacyPlan, type ReactionPlan } from "@/lib/voice/reaction-library";
import type { Reaction, VoiceFragment } from "@/lib/voice/policy";
import type { VoiceHistoryMessage } from "@/lib/voice/history";
import { VoiceAudioDiagnostics } from "@/lib/voice/audio-diagnostics";
import { VoiceAudioDiagnosticsControls } from "./voice-audio-diagnostics";
import { VoiceReactionDiagnostics } from "@/lib/voice/reaction-diagnostics";
import { VoiceReactionDiagnosticsControls } from "./voice-reaction-diagnostics";
import { cn } from "@/lib/utils";
import { checkVoiceAvailability, type VoiceStatus, type VoiceTarget, voiceSessionUrl, waitForIceGathering, waitForVoiceEvent } from "@/lib/voice/client";

type LiveResources = { pc: RTCPeerConnection; channel: RTCDataChannel; stream: MediaStream; abort: AbortController; readinessTimer?: ReturnType<typeof setTimeout>; closePromise?: Promise<void> };

export function VoiceControl({ target, conversationId, name, disabled = false, onActiveChange, onConversationChange, chatContext }: {
  target: VoiceTarget; conversationId: string; name: string; disabled?: boolean;
  onActiveChange?: (active: boolean) => void; onConversationChange: () => void; chatContext: readonly VoiceHistoryMessage[];
}) {
  const [availabilityState, setAvailabilityState] = useState<{ key: string; value: { supported: boolean; reason?: string } } | null>(null);
  const [availabilityErrorState, setAvailabilityErrorState] = useState<{ key: string; value: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState<VoiceFragment[]>([]);
  const [reaction, setReaction] = useState<Reaction>("neutral");
  const [reactionPlan, setReactionPlan] = useState<ReactionPlan>(legacyPlan("neutral"));
  const [motionRevision, setMotionRevision] = useState(0);
  const [reactionRequestedAt, setReactionRequestedAt] = useState(0);
  const [reactionRevision, setReactionRevision] = useState(0);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [captions, setCaptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const bridge = useRef<VoiceBridge | null>(null);
  const callbacks = useRef({ onConversationChange });
  useEffect(() => { callbacks.current = { onConversationChange }; }, [onConversationChange]);
  useEffect(() => { bridge.current?.context(chatContext); }, [chatContext]);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const resources = useRef<LiveResources | null>(null);
  const pendingAbort = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioDiagnostics] = useState(() => new VoiceAudioDiagnostics({ peer: () => null, audio: () => null }));
  const [reactionDiagnostics] = useState(() => new VoiceReactionDiagnostics());
  const [motionCapture, setMotionCapture] = useState(false);
  const recordMotion = useCallback((value: Parameters<VoiceReactionDiagnostics["frame"]>[0]) => reactionDiagnostics.frame(value), [reactionDiagnostics]);
  useEffect(() => () => reactionDiagnostics.dispose(), [reactionDiagnostics]);
  useEffect(() => {
    audioDiagnostics.setSources({ peer: () => resources.current?.pc ?? null, audio: () => audioRef.current });
    return () => audioDiagnostics.dispose();
  }, [audioDiagnostics]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bindAudio = useCallback((element: HTMLAudioElement | null) => { audioRef.current = element; setAudioElement(element); }, []);
  const active = status === "connecting" || status === "connected" || status === "ending";
  const { appId, botId, conversationId: targetConversationId } = target;
  const targetKey = `${appId ?? ""}:${botId ?? ""}:${targetConversationId ?? ""}`;
  const availability = availabilityState?.key === targetKey ? availabilityState.value : null;
  const availabilityError = availabilityErrorState?.key === targetKey ? availabilityErrorState.value : null;

  useEffect(() => {
    const abort = new AbortController();
    const requestTarget = { appId, botId, conversationId: targetConversationId };
    checkVoiceAvailability(requestTarget, abort.signal).then((result) => {
      if (!abort.signal.aborted) setAvailabilityState({ key: targetKey, value: result });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setAvailabilityErrorState({ key: targetKey, value: cause instanceof Error ? cause.message : "Voice availability could not be checked" });
    });
    return () => abort.abort();
  }, [appId, botId, targetConversationId, targetKey]);

  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

  const cleanup = useCallback((expected?: LiveResources) => {
    const current = expected ?? resources.current;
    if (!current) return;
    const ownsSession = resources.current === current;
    if (ownsSession) { reactionDiagnostics.stop(); audioDiagnostics.stop(); resources.current = null; }
    if (current.readinessTimer) clearTimeout(current.readinessTimer);
    if (current.channel.readyState === "open" && !current.closePromise) {
      try { current.channel.send(JSON.stringify({ type: "session.close" })); } catch { /* Transport already closed. */ }
    }
    const closingBridge = ownsSession ? bridge.current : null;
    if (closingBridge) {
      setSaving(true);
      void closingBridge.finish().catch(cause => { setError(cause instanceof Error ? cause.message : "Speech could not be saved."); setOpen(true); }).finally(() => setSaving(false));
    }
    current.abort.abort();
    current.stream.getTracks().forEach((track) => track.stop());
    try { current.channel.close(); } catch { /* already closed */ }
    try { current.pc.close(); } catch { /* already closed */ }
    if (!ownsSession) return;
    if (audioRef.current) audioRef.current.srcObject = null;
    setMuted(false);
    setStatus("idle");
  }, [audioDiagnostics, reactionDiagnostics]);

  const end = useCallback(async () => {
    const current = resources.current;
    if (!current) { pendingAbort.current?.abort(); pendingAbort.current = null; setStatus("idle"); return; }
    if (status === "connecting") {
      cleanup(current);
      return;
    }
    setStatus("ending");
    current.stream.getAudioTracks().forEach(track => { track.enabled = false; });
    audioRef.current?.pause();
    audioDiagnostics.stop(); reactionDiagnostics.stop();
    if (!current.closePromise) {
      current.closePromise = (async () => {
        const closed = waitForVoiceEvent(current.channel, "session.closed", current.abort.signal, 15_000);
        if (current.channel.readyState === "open") current.channel.send(JSON.stringify({ type: "session.close" }));
        await closed;
      })();
    }
    let confirmed = true;
    try { await current.closePromise; } catch { confirmed = false; }
    cleanup(current);
    setSaving(true);
    try { await bridge.current?.finish(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Speech could not be saved. Retry before leaving."); }
    finally { setSaving(false); }
    if (!confirmed) {
      setError("Voice ended locally; final session usage could not be confirmed.");
      setStatus("error");
    }
  }, [audioDiagnostics, reactionDiagnostics, cleanup, status]);

  useEffect(() => () => {
    pendingAbort.current?.abort();
    pendingAbort.current = null;
    const closingBridge = bridge.current;
    if (closingBridge) void closingBridge.finish().catch(() => {}).finally(() => closingBridge.dispose());
    const current = resources.current;
    if (current) {
      current.abort.abort();
      if (current.readinessTimer) clearTimeout(current.readinessTimer);
      if (current.channel.readyState === "open") {
        try { current.channel.send(JSON.stringify({ type: "session.close" })); } catch { /* Page is closing. */ }
      }
      current.stream.getTracks().forEach((track) => track.stop());
      try { current.channel.close(); } catch { /* already closed */ }
      try { current.pc.close(); } catch { /* already closed */ }
    }
  }, []);

  const start = useCallback(async () => {
    if (!availability?.supported || resources.current || pendingAbort.current) return;
    if (bridge.current?.hasUnsaved) {
      setError("Your previous voice transcript still needs saving. Use Retry save before starting again.");
      return;
    }
    bridge.current?.dispose();
    bridge.current = null;
    setOpen(true);
    setError(null);
    setTranscript([]);
    setReaction("neutral");
    setReactionPlan(legacyPlan("neutral")); setMotionRevision(value => value + 1);
    setReactionRevision(revision => revision + 1);
    setAudioBlocked(false);
    setStatus("connecting");
    const abort = new AbortController();
    pendingAbort.current = abort;
    let stream: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;
    let channel: RTCDataChannel | null = null;
    let session: LiveResources | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (abort.signal.aborted) { stream.getTracks().forEach((track) => track.stop()); if (pendingAbort.current === abort) pendingAbort.current = null; return; }
      pc = new RTCPeerConnection();
      stream.getTracks().forEach((track) => pc!.addTrack(track, stream!));
      channel = pc.createDataChannel("oai-events");
      const current: LiveResources = { pc, channel, stream, abort };
      session = current;
      resources.current = current;

      let startedResolve!: () => void;
      let startedReject!: (cause: Error) => void;
      const started = new Promise<void>((resolve, reject) => { startedResolve = resolve; startedReject = reject; });
      void started.catch(() => {});
      const abortStarted = () => startedReject(new DOMException("Voice connection cancelled", "AbortError"));
      abort.signal.addEventListener("abort", abortStarted, { once: true });
      let startTimer: ReturnType<typeof setTimeout> | null = null;
      channel.addEventListener("message", (message: MessageEvent<string>) => {
        if (resources.current !== current) return;
        try {
          const event = JSON.parse(message.data) as { type?: string; delta?: string; error?: { message?: string } };
          const handled = bridge.current?.receive(event);
          if (event.type === "session.started") { if (startTimer) clearTimeout(startTimer); startedResolve(); }
          else if (event.type === "session.closed") {
            if (startTimer) clearTimeout(startTimer);
            if (resources.current === current && !current.closePromise) {
              cleanup(current);
              setError("Voice session ended unexpectedly");
              setStatus("error");
            }
          }
          else if (event.type === "error" && !handled) {
            if (resources.current === current) {
              cleanup(current);
              setError(event.error?.message || "Voice session reported an error");
              setStatus("error");
            }
          }

        } catch { /* Ignore unknown event payloads. */ }
      });
      channel.addEventListener("open", () => { /* Session commands are gated on session.started. */ });
      channel.addEventListener("error", () => startedReject(new Error("Voice event channel failed")));
      channel.addEventListener("close", () => {
        if (startTimer) clearTimeout(startTimer);
        if (resources.current === current) {
          cleanup(current);
          setError("Voice connection was closed");
          setStatus("error");
        }
      });
      pc.addEventListener("track", (event) => {
        if (!audioRef.current || resources.current !== current) return;
        audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audioRef.current.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc?.connectionState === "failed" || pc?.connectionState === "closed" || pc?.connectionState === "disconnected") {
          if (startTimer) clearTimeout(startTimer);
          startedReject(new Error("Voice connection was interrupted"));
          if (resources.current === current) {
            cleanup(current);
            setError("Voice connection was interrupted");
            setStatus("error");
          }
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, abort.signal, 10_000);
      if (abort.signal.aborted || !pc.localDescription?.sdp) throw new DOMException("Voice connection cancelled", "AbortError");
      const response = await fetch(voiceSessionUrl(target), {
        method: "POST", signal: abort.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, ...target, chatId: conversationId }),
      });
      const body = await response.json() as { session?: { id: string }; transport?: { type?: string; sdp?: string }; error?: string; history?: VoiceHistoryMessage[]; avatarUrl?: string | null; reactions?: boolean };
      if (!response.ok || body.transport?.type !== "webrtc" || !body.transport.sdp || !body.session?.id) throw new Error(body.error || "Voice session could not be created");
      if (abort.signal.aborted) return;
      startTimer = setTimeout(() => startedReject(new Error("Voice session did not become ready")), 20_000);
      current.readinessTimer = startTimer;
      setAvatarUrl(body.avatarUrl ?? null);
      bridge.current = new VoiceBridge({ conversationId, sessionId: body.session!.id, reactions: body.reactions === true, history: body.history, reactionDiagnostics,
        send: event => { if (channel?.readyState === "open") channel.send(JSON.stringify(event)); },
        changed: () => callbacks.current.onConversationChange(), transcript: setTranscript,
        reaction: (value, _latency, plan, motion) => { setReactionRequestedAt(performance.now()); setMotionRevision(previous => motion ?? previous + 1); setReactionPlan(plan ?? legacyPlan(value)); setReaction(value); setReactionRevision(revision => revision + 1); }, notice: message => { setError(message); setOpen(true); }, approval: () => setOpen(false),
      });
      await pc.setRemoteDescription({ type: "answer", sdp: body.transport.sdp });
      await started;
      callbacks.current.onConversationChange();
      clearTimeout(startTimer);
      abort.signal.removeEventListener("abort", abortStarted);
      if (pendingAbort.current === abort) pendingAbort.current = null;
      if (resources.current === current) setStatus("connected");
    } catch (cause) {
      const cancelled = abort.signal.aborted;
      if (pendingAbort.current === abort) pendingAbort.current = null;
      if (stream && !session) stream.getTracks().forEach((track) => track.stop());
      if (session && resources.current === session) cleanup(session);
      if (!cancelled && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Voice could not start");
        setStatus("error");
      }
    }
  }, [availability?.supported, cleanup, target, conversationId, reactionDiagnostics]);

  const toggleMute = () => {
    const current = resources.current;
    if (!current) return;
    const nextMuted = !muted;
    current.stream.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  };

  const canStart = !saving && !disabled && availability?.supported === true && status !== "connecting" && status !== "connected" && status !== "ending";
  const reason = availabilityError || availability?.reason;

  return (
    <div className="relative">
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)} aria-label={active ? "Expand voice conversation" : "Voice conversation"} aria-expanded={open}
        title={reason || "Start a voice conversation"}
        className={cn("flex h-9 w-9 items-center justify-center rounded-full hover:bg-hover", active && "bg-accent/10 text-accent", !availability?.supported && "text-muted")}
        data-testid="voice-control">
        {status === "connecting" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Headphones className="h-5 w-5" />}
      </button>
      {active && !open && <button type="button" onClick={() => void end()} className="absolute top-full right-0 z-30 mt-2 whitespace-nowrap rounded-full border border-border bg-surface px-3 py-2 text-xs shadow" aria-label="End voice">End voice</button>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent hideClose title={<span className="sr-only">Voice with {name}</span>} description="Speak with the same bot. Your conversation is saved in chat."
          onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}
          className="inset-0 left-0 top-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none bg-[#101822] p-0 text-white [&>p]:sr-only [&>div]:mt-0">
          <div className="relative flex h-dvh flex-col pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]">
            <header className="z-10 flex items-start justify-between px-6 md:px-10">
              <div><p className="text-lg font-medium">{name}</p><p className="mt-1 text-sm text-white/55" role="status">{saving ? "Saving conversation…" : status === "connecting" ? "Connecting…" : status === "connected" ? muted ? "Microphone muted" : "Listening" : status === "ending" ? "Ending voice…" : "Your conversation, out loud"}</p></div>
              <button type="button" className="rounded-full p-3 hover:bg-white/10" aria-label="Minimize voice" onClick={() => setOpen(false)}><Minimize2 className="h-5 w-5" /></button>
            </header>
            <div className="relative min-h-0 flex-1" style={{ background: "radial-gradient(ellipse at 50% 48%, #38505a55, transparent 65%)" }}>
              <VoiceAvatar planRequestedAt={reactionRequestedAt} plan={reactionPlan} motionRevision={motionRevision} reaction={reaction} reactionRevision={reactionRevision} audio={audioElement} modelUrl={avatarUrl} active={status === "connected"} visible={open} diagnostics={audioDiagnostics} onMotionMetrics={motionCapture ? recordMotion : undefined} />
            </div>
            <div className="z-10 mx-auto max-h-[45dvh] w-full max-w-xl space-y-4 overflow-y-auto px-6 pb-1 text-center">
              {captions && <div className="max-h-36 overflow-y-auto rounded-2xl bg-white/5 p-4 text-left" aria-label="Live captions">
                {(["user", "assistant"] as const).map(role => {
                  const text = transcript.filter(line => line.role === role).slice(-14).map(line => line.text).join("");
                  return text ? <p key={role} className={cn("text-sm", role === "user" ? "text-white/65" : "mt-2 text-white")}><span className="mr-2 font-medium">{role === "user" ? "You" : name}</span>{text}</p> : null;
                })}
              </div>}
              {reason && <p className="text-sm text-white/60">{reason}</p>}
              {error && <div role="alert" className="rounded-xl bg-white/10 p-3 text-sm"><p>{error}</p>
                {transcript.length > 0 && <button className="mt-2 underline" disabled={saving} onClick={() => {
                  const current = bridge.current; if (!current) return;
                  setSaving(true); void current.flush().then(() => setError(null)).catch(cause => setError(cause.message)).finally(() => setSaving(false));
                }}>Retry save</button>}
              </div>}
              <div className="flex items-center justify-center gap-4">
                <button type="button" className="rounded-full bg-white/10 p-4 hover:bg-white/20" aria-label="Toggle captions" aria-pressed={captions} onClick={() => setCaptions(value => !value)}><Captions className="h-5 w-5" /></button>
                {status === "connected" ? <>
                  <button type="button" onClick={toggleMute} className={cn("rounded-full p-4", muted ? "bg-white text-black" : "bg-white/10 hover:bg-white/20")} aria-label={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted}>
                    {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </button>
                  <button type="button" onClick={() => void end()} className="flex items-center gap-2 rounded-full bg-white px-6 py-4 text-sm font-medium text-black"><Square className="h-4 w-4 fill-current" /> End voice</button>
                </> : <button type="button" onClick={() => status === "connecting" ? void end() : void start()} disabled={!canStart && status !== "connecting"}
                  className="rounded-full bg-white px-6 py-4 text-sm font-medium text-black disabled:opacity-40">{status === "connecting" ? "Cancel" : status === "ending" ? "Ending…" : "Start voice"}</button>}
              </div>
              <p className="text-xs text-white/40">Voice and text share this chat. You can minimize voice to type or review approvals.</p>
              <VoiceAudioDiagnosticsControls diagnostics={audioDiagnostics} active={status === "connected"} />
              <VoiceReactionDiagnosticsControls diagnostics={reactionDiagnostics} active={status === "connected"} onCaptureChange={setMotionCapture} />
              {audioBlocked && <button className="text-sm underline" onClick={() => void audioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => setError("Tap again to enable audio playback."))}>Enable voice audio</button>}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <audio ref={bindAudio} autoPlay className="hidden" aria-label="Voice response audio" />
    </div>
  );
}
