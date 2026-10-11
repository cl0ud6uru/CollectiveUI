import { createRoot } from "react-dom/client";
import { VoiceAvatar } from "../../src/components/chat/voice-avatar";
import { VoiceBridge } from "../../src/lib/voice/bridge";
import { waitForIceGathering, waitForVoiceEvent, type VoiceTarget } from "../../src/lib/voice/client";
import { type Reaction } from "../../src/lib/voice/policy";
import { type VoiceHistoryMessage } from "../../src/lib/voice/history";

declare global {
  interface Window {
    webkit: { messageHandlers: {
      voiceAPI: { postMessage: (request: unknown) => Promise<{ status: number; body: unknown }> };
      voiceEvents: { postMessage: (event: unknown) => void };
    } };
    voice: { start: typeof start; end: typeof end; mute: typeof mute; retry: typeof retry;
      visible: (value: boolean) => void; context: (messages: VoiceHistoryMessage[]) => void };
  }
}
const emit = (type: string, data: Record<string, unknown> = {}) => window.webkit.messageHandlers.voiceEvents.postMessage({ type, ...data });
const nativeFetch: typeof fetch = async (input, init) => {
  if (init?.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const request = window.webkit.messageHandlers.voiceAPI.postMessage({ path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
  // Native requests have their own bounded deadline. Abort only abandons delivery, never retries a mutation.
  const result = await request;
  if (init?.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
};
const root = createRoot(document.getElementById("root")!);
const audio = document.createElement("audio");
audio.autoplay = true;
audio.setAttribute("playsinline", "");
document.body.append(audio);
let reaction: Reaction = "neutral", revision = 0, modelUrl: string | null = null, visible = true;
let pc: RTCPeerConnection | null = null, channel: RTCDataChannel | null = null, stream: MediaStream | null = null;
let abort: AbortController | null = null, bridge: VoiceBridge | null = null;
let closing: Promise<void> | null = null, active = false, demo = false;
let inputAudio: AudioContext | null = null, inputTimer: ReturnType<typeof setInterval> | null = null, muted = false;
function monitorInput(captured: MediaStream) {
  try {
    inputAudio = new AudioContext();
    const analyser = inputAudio.createAnalyser(); analyser.fftSize = 512;
    inputAudio.createMediaStreamSource(captured).connect(analyser);
    const samples = new Float32Array(512);
    void inputAudio.resume().catch(() => {});
    inputTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      emit("level", { value: muted ? 0 : Math.min(1, rms * 7) });
    }, 100);
  } catch { /* The meter must never interrupt audio capture. */ }
}
function render() { root.render(<VoiceAvatar reaction={reaction} reactionRevision={revision} modelUrl={modelUrl} audio={audio} active={active} visible={visible} />); }
function status(value: string) { emit("status", { value }); }
function notice(error: unknown) { emit("notice", { message: error instanceof Error ? error.message : String(error) }); }
function release() {
  if (inputTimer) clearInterval(inputTimer); inputTimer = null;
  void inputAudio?.close(); inputAudio = null; emit("level", { value: 0 });
  abort?.abort(); abort = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  channel?.close(); channel = null; pc?.close(); pc = null;
  audio.pause(); audio.srcObject = null; active = false; render();
}
async function start(config: { target: VoiceTarget; chatId: string; demo: boolean }) {
  if (active || abort || closing) return;
  if (bridge?.hasUnsaved) { notice("Save your previous speech before starting again."); return; }
  bridge?.dispose(); bridge = null;
  reaction = "neutral"; revision++; muted = false; render();
  demo = config.demo; status("connecting");
  if (demo) {
    active = true; status("connected"); render();
    // A clearly labeled offline preview exercises the same native visualization.
    inputTimer = setInterval(() => emit("level", { value: muted ? 0 : 0.25 + Math.sin(Date.now() / 220) ** 2 * 0.45 }), 100);
    return;
  }
  const current = new AbortController(); abort = current;
  const ensureCurrent = () => { if (current.signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  try {
    const available = await nativeFetch(`/api/voice/session?${new URLSearchParams(config.target)}`, { signal: current.signal });
    const eligibility = await available.json();
    if (!available.ok || !eligibility.supported) throw new Error(eligibility.reason || eligibility.error || "Voice is unavailable.");
    ensureCurrent();
    const captured = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (current.signal.aborted) { captured.getTracks().forEach(track => track.stop()); return; }
    stream = captured; monitorInput(captured);
    const peer = new RTCPeerConnection(); pc = peer;
    stream.getTracks().forEach(track => peer.addTrack(track, captured));
    const events = peer.createDataChannel("oai-events"); channel = events;
    peer.ontrack = event => { if (current.signal.aborted || peer !== pc || closing) return; audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); void audio.play().catch(() => notice("Audio playback paused. End voice and start again.")); };
    peer.onconnectionstatechange = () => {
      if (peer !== pc || closing) return;
      if (peer.connectionState === "failed" || peer.connectionState === "disconnected") { notice("Voice connection was interrupted. Your chat is still saved."); void end(); }
    };
    events.addEventListener("message", message => {
      try {
        const event = JSON.parse(message.data);
        const handled = bridge?.receive(event);
        if (event.type === "error" && !handled) { notice(event.error?.message || "Voice connection failed."); void end(); }
        if (event.type === "session.closed" && !closing) { notice("The voice session ended."); void end(); }
      } catch { /* Ignore unrelated data-channel messages. */ }
    });
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGathering(peer, current.signal);
    const response = await nativeFetch("/api/voice/session", { method: "POST", signal: current.signal,
      body: JSON.stringify({ ...config.target, chatId: config.chatId, sdp: peer.localDescription?.sdp }) });
    const session = await response.json();
    if (!response.ok) throw new Error(session.error || "Could not start voice.");
    ensureCurrent();
    bridge = new VoiceBridge({ conversationId: config.chatId, sessionId: session.session.id, reactions: session.reactions, history: session.history,
      fetcher: nativeFetch,
      send: event => { if (events.readyState === "open") events.send(JSON.stringify(event)); },
      changed: () => emit("changed"),
      transcript: () => {}, // Speech remains in the bridge and saved chat, not on the voice screen.
      reaction: value => { reaction = value; revision++; render(); }, notice,
      approval: () => emit("approval"),
    });
    const started = waitForVoiceEvent(events, "session.started", current.signal, 20000);
    void started.catch(() => {});
    await peer.setRemoteDescription({ type: "answer", sdp: session.transport.sdp });
    await started; ensureCurrent();
    active = true; status("connected"); emit("changed"); render();
    if (session.avatarUrl) {
      // Native bearer stays in URLSession. Only self-contained GLBs are supported on mobile.
      void window.webkit.messageHandlers.voiceAPI.postMessage({ path: `/api/voice/avatar?conversationId=${encodeURIComponent(config.chatId)}`, method: "GET" })
        .then(result => {
          if (current.signal.aborted || result.status !== 200) return;
          const bytes = Uint8Array.from(atob(String(result.body)), character => character.charCodeAt(0));
          if (modelUrl) URL.revokeObjectURL(modelUrl);
          modelUrl = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" })); render();
        }).catch(() => notice("Your custom avatar is unavailable. Using the default avatar."));
    }
  } catch (error) {
    if (!current.signal.aborted) notice(error);
    release();
    try { await bridge?.finish(); } catch (error) { notice(error); }
    status("ended"); emit("saved", { unsaved: bridge?.hasUnsaved ?? false });
  }
}
function mute(value: boolean) { muted = value; if (value) emit("level", { value: 0 }); stream?.getAudioTracks().forEach(track => { track.enabled = !value; }); }
function end() {
  if (closing) return closing;
  status("ending"); mute(true); audio.pause();
  // Stop physical capture immediately, including while the close acknowledgement is pending.
  stream?.getTracks().forEach(track => track.stop());
  closing = (async () => {
    try {
      if (channel?.readyState === "open" && active && abort) {
        const closed = waitForVoiceEvent(channel, "session.closed", abort.signal, 3000);
        channel.send(JSON.stringify({ type: "session.close" }));
        await closed;
      }
    } catch { /* Capture has stopped; session finalization is best effort on mobile. */ }
    release();
    try { await bridge?.finish(); } catch (error) { notice(error); }
    status("ended"); emit("saved", { unsaved: bridge?.hasUnsaved ?? false });
  })().finally(() => { closing = null; });
  return closing;
}
async function retry() {
  emit("saving", { value: true });
  try { await bridge?.flush(); emit("saved", { unsaved: bridge?.hasUnsaved ?? false }); }
  catch (error) { notice(error); }
  finally { emit("saving", { value: false }); }
}
window.voice = { start, end, mute, retry, context: text => bridge?.context(text), visible: value => { visible = value; render(); } };
render(); emit("ready", { secure: window.isSecureContext, media: !!navigator.mediaDevices?.getUserMedia });
