"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Headphones, Loader2, Mic, MicOff, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { appendVoiceTranscript, checkVoiceAvailability, type VoiceLine, type VoiceStatus, type VoiceTarget, voiceSessionUrl, waitForIceGathering, waitForVoiceEvent } from "@/lib/voice/client";

type LiveResources = { pc: RTCPeerConnection; channel: RTCDataChannel; stream: MediaStream; abort: AbortController; readinessTimer?: ReturnType<typeof setTimeout>; closePromise?: Promise<void> };

export function VoiceControl({ target, disabled = false, onActiveChange }: { target: VoiceTarget; disabled?: boolean; onActiveChange?: (active: boolean) => void }) {
  const [availabilityState, setAvailabilityState] = useState<{ key: string; value: { supported: boolean; reason?: string } } | null>(null);
  const [availabilityErrorState, setAvailabilityErrorState] = useState<{ key: string; value: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState<VoiceLine[]>([]);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const resources = useRef<LiveResources | null>(null);
  const pendingAbort = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const active = status === "connecting" || status === "connected" || status === "ending";
  const { appId, botId, conversationId } = target;
  const targetKey = `${appId ?? ""}:${botId ?? ""}:${conversationId ?? ""}`;
  const availability = availabilityState?.key === targetKey ? availabilityState.value : null;
  const availabilityError = availabilityErrorState?.key === targetKey ? availabilityErrorState.value : null;

  useEffect(() => {
    const abort = new AbortController();
    const requestTarget = { appId, botId, conversationId };
    checkVoiceAvailability(requestTarget, abort.signal).then((result) => {
      if (!abort.signal.aborted) setAvailabilityState({ key: targetKey, value: result });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setAvailabilityErrorState({ key: targetKey, value: cause instanceof Error ? cause.message : "Voice availability could not be checked" });
    });
    return () => abort.abort();
  }, [appId, botId, conversationId, targetKey]);

  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

  const cleanup = useCallback((expected?: LiveResources) => {
    const current = expected ?? resources.current;
    if (!current) return;
    if (resources.current === current) resources.current = null;
    if (current.readinessTimer) clearTimeout(current.readinessTimer);
    current.abort.abort();
    current.stream.getTracks().forEach((track) => track.stop());
    try { current.channel.close(); } catch { /* already closed */ }
    try { current.pc.close(); } catch { /* already closed */ }
    if (audioRef.current) audioRef.current.srcObject = null;
    setMuted(false);
    setStatus("idle");
  }, []);

  const end = useCallback(async () => {
    const current = resources.current;
    if (!current) { pendingAbort.current?.abort(); pendingAbort.current = null; setStatus("idle"); return; }
    if (status === "connecting") {
      cleanup(current);
      return;
    }
    setStatus("ending");
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
    if (!confirmed) {
      setError("Voice ended locally; final session usage could not be confirmed.");
      setStatus("error");
    }
  }, [cleanup, status]);

  useEffect(() => () => {
    pendingAbort.current?.abort();
    pendingAbort.current = null;
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
    setOpen(true);
    setError(null);
    setTranscript([]);
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
        try {
          const event = JSON.parse(message.data) as { type?: string; delta?: string; error?: { message?: string } };
          if (event.type === "session.started") { if (startTimer) clearTimeout(startTimer); startedResolve(); }
          else if (event.type === "session.closed") {
            if (startTimer) clearTimeout(startTimer);
            if (resources.current === current && !current.closePromise) {
              cleanup(current);
              setError("Voice session ended unexpectedly");
              setStatus("error");
            }
          }
          else if (event.type === "error") {
            if (resources.current === current) {
              cleanup(current);
              setError(event.error?.message || "Voice session reported an error");
              setStatus("error");
            }
          }
          else if (event.type === "session.input_transcript.delta" && event.delta) setTranscript((lines) => appendVoiceTranscript(lines, "you", event.delta!));
          else if (event.type === "session.output_transcript.delta" && event.delta) setTranscript((lines) => appendVoiceTranscript(lines, "assistant", event.delta!));
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
        if (!audioRef.current) return;
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
        body: JSON.stringify({ sdp: pc.localDescription.sdp, ...target }),
      });
      const body = await response.json() as { transport?: { type?: string; sdp?: string }; error?: string };
      if (!response.ok || body.transport?.type !== "webrtc" || !body.transport.sdp) throw new Error(body.error || "Voice session could not be created");
      if (abort.signal.aborted) return;
      startTimer = setTimeout(() => startedReject(new Error("Voice session did not become ready")), 20_000);
      current.readinessTimer = startTimer;
      await pc.setRemoteDescription({ type: "answer", sdp: body.transport.sdp });
      await started;
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
  }, [availability?.supported, cleanup, target]);

  const toggleMute = () => {
    const current = resources.current;
    if (!current) return;
    const nextMuted = !muted;
    current.stream.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    setMuted(nextMuted);
  };

  const canStart = !disabled && availability?.supported === true && status !== "connecting" && status !== "connected" && status !== "ending";
  const reason = availabilityError || availability?.reason;

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label="Voice conversation" aria-expanded={open}
        title={reason || "Start a voice conversation"}
        className={cn("flex h-9 w-9 items-center justify-center rounded-full hover:bg-hover", active && "bg-accent/10 text-accent", !availability?.supported && "text-muted")}
        data-testid="voice-control">
        {status === "connecting" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Headphones className="h-5 w-5" />}
      </button>
      {open && <section className="absolute bottom-full right-0 z-30 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-4 shadow-xl" aria-label="Voice conversation panel">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="flex items-center gap-2 text-sm font-semibold"><AudioLines className="h-4 w-4" /> Voice conversation</h2>
            <p className="mt-1 text-xs text-muted" role="status">{status === "connecting" ? "Connecting…" : status === "connected" ? "Connected" : status === "ending" ? "Ending session…" : status === "error" ? "Could not connect" : availability?.supported ? "Start a separate, temporary voice session." : "Voice is unavailable for this target."}</p>
          </div>
          <button type="button" className="rounded-full p-1 hover:bg-hover" aria-label="Close voice panel" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
        </div>
        {reason && <p className="mt-3 rounded-lg bg-hover p-2 text-xs text-muted">{reason}</p>}
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex gap-2">
          {status === "connected" ? <>
            <button type="button" onClick={toggleMute} className="flex items-center gap-2 rounded-full border border-border px-3 py-2 text-sm hover:bg-hover" aria-label={muted ? "Unmute microphone" : "Mute microphone"}>
              {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}{muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" onClick={() => void end()} className="flex items-center gap-2 rounded-full bg-fg px-3 py-2 text-sm text-bg"><Square className="h-3.5 w-3.5 fill-current" /> End</button>
          </> : <button type="button" onClick={() => status === "connecting" ? void end() : void start()} disabled={!canStart && status !== "connecting"}
            className="rounded-full bg-fg px-4 py-2 text-sm text-bg disabled:opacity-40">{status === "connecting" ? "Cancel" : "Start voice"}</button>}
        </div>
        {transcript.length > 0 && <div className="mt-4 max-h-44 space-y-2 overflow-y-auto border-t border-border pt-3" aria-label="Temporary voice transcript">
          {transcript.map((line, index) => <p key={`${index}:${line.role}`} className="text-xs"><span className="font-semibold">{line.role === "you" ? "You" : "Assistant"}: </span>{line.text}</p>)}
          <p className="text-[11px] text-subtle">This transcript is temporary and is not saved to chat.</p>
        </div>}
      </section>}
      <audio ref={audioRef} autoPlay controls={audioBlocked} className={cn("mt-2 w-full", !audioBlocked && "hidden")} aria-label="Voice response audio" />
    </div>
  );
}
