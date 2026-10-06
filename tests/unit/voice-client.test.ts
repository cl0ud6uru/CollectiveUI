import { describe, expect, it } from "vitest";
import { appendVoiceTranscript, voiceSessionUrl, waitForIceGathering, waitForVoiceEvent } from "@/lib/voice/client";

describe("voice client helpers", () => {
  it("builds session query parameters and bounds transcript history without mutating state", () => {
    expect(voiceSessionUrl({ appId: "app 1", conversationId: "chat" })).toBe("/api/voice/session?appId=app+1&conversationId=chat");
    const previous = [{ role: "you" as const, text: "hello" }];
    const next = appendVoiceTranscript(previous, "you", " there");
    expect(next).toEqual([{ role: "you", text: "hello there" }]);
    expect(previous[0].text).toBe("hello");
  });

  it("waits for ICE completion and aborts cleanly", async () => {
    class Peer extends EventTarget { iceGatheringState = "gathering"; }
    const pc = new Peer();
    const abort = new AbortController();
    const waiting = waitForIceGathering(pc as unknown as RTCPeerConnection, abort.signal, 100);
    pc.iceGatheringState = "complete";
    pc.dispatchEvent(new Event("icegatheringstatechange"));
    await expect(waiting).resolves.toBeUndefined();

    pc.iceGatheringState = "gathering";
    const abortGather = new AbortController();
    const second = waitForIceGathering(pc as unknown as RTCPeerConnection, abortGather.signal, 100);
    abortGather.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
  });

  it("waits for the explicit started/closed lifecycle event", async () => {
    class Channel extends EventTarget { readyState = "open"; }
    const channel = new Channel();
    const controller = new AbortController();
    const waiting = waitForVoiceEvent(channel as unknown as RTCDataChannel, "session.started", controller.signal, 100);
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.started" }) }));
    await expect(waiting).resolves.toMatchObject({ type: "session.started" });
  });
});
