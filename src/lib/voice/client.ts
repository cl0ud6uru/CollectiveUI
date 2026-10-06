export type VoiceTarget = { appId?: string; botId?: string; conversationId?: string };
export type VoiceAvailability = { supported: boolean; reason?: string };
export type VoiceStatus = "idle" | "connecting" | "connected" | "ending" | "error";
export type VoiceLine = { role: "you" | "assistant"; text: string };

export function voiceSessionUrl(target: VoiceTarget) {
  const query = new URLSearchParams();
  if (target.appId) query.set("appId", target.appId);
  if (target.botId) query.set("botId", target.botId);
  if (target.conversationId) query.set("conversationId", target.conversationId);
  return `/api/voice/session?${query.toString()}`;
}

export async function checkVoiceAvailability(target: VoiceTarget, signal: AbortSignal): Promise<VoiceAvailability> {
  const response = await fetch(voiceSessionUrl(target), { signal, cache: "no-store" });
  const body = await response.json() as VoiceAvailability;
  if (!response.ok) throw new Error((body as VoiceAvailability & { error?: string }).error || "Voice availability could not be checked");
  return body;
}

const MAX_TRANSCRIPT_LINES = 40;
const MAX_LINE_LENGTH = 4_000;

export function appendVoiceTranscript(lines: VoiceLine[], role: VoiceLine["role"], delta: string): VoiceLine[] {
  if (!delta) return lines;
  const next = [...lines];
  const last = next.at(-1);
  if (last?.role === role) next[next.length - 1] = { role, text: (last.text + delta).slice(-MAX_LINE_LENGTH) };
  else next.push({ role, text: delta.slice(-MAX_LINE_LENGTH) });
  return next.slice(-MAX_TRANSCRIPT_LINES);
}

export function waitForIceGathering(pc: RTCPeerConnection, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onState);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onState = () => { if (pc.iceGatheringState === "complete") finish(); };
    const onAbort = () => finish(new DOMException("Voice connection cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Timed out waiting for ICE gathering")), timeoutMs);
    pc.addEventListener("icegatheringstatechange", onState);
    signal.addEventListener("abort", onAbort, { once: true });
    if (pc.iceGatheringState === "complete") finish();
    if (signal.aborted) onAbort();
  });
}

export function waitForVoiceEvent(channel: RTCDataChannel, type: string, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, event?: Record<string, unknown>) => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(event!);
    };
    const onMessage = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as Record<string, unknown>;
        if (event.type === type) finish(undefined, event);
      } catch { /* Ignore malformed or non-JSON data-channel messages. */ }
    };
    const onClose = () => finish(new Error("Voice connection closed"));
    const onAbort = () => finish(new DOMException("Voice connection cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    channel.addEventListener("message", onMessage);
    channel.addEventListener("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
