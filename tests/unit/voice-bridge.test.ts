import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceBridge } from "@/lib/voice/bridge";
import { compactTranscript, orderedFragments, reactionContext } from "@/lib/voice/policy";

const input = (id: string, text = "Find my notes", start = 0) => ({ type: "session.input_transcript.delta", event_id: id, delta: text, start_ms: start, end_ms: start + 100 });
const delegate = (id = "d1") => ({ type: "session.delegation.created", event_id: `event-${id}`, offset_ms: 1000, delegation: { id, target: "client" } });
let bridge: VoiceBridge;
const options = () => ({ conversationId: "conversation01", sessionId: "live01", reactions: false,
  send: vi.fn(), changed: vi.fn(), transcript: vi.fn(), reaction: vi.fn(), notice: vi.fn(), approval: vi.fn() });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { bridge?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("voice bridge", () => {
  it("uses the native request transport without falling back to browser credentials", async () => {
    const ambient = vi.fn(); vi.stubGlobal("fetch", ambient);
    const native = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ messageId: null, status: "saved" }));
    bridge = new VoiceBridge({ ...options(), fetcher: native });
    bridge.receive(input("native-fragment"));
    await bridge.finish();
    expect(native).toHaveBeenCalledOnce();
    expect(ambient).not.toHaveBeenCalled();
    expect(JSON.parse(native.mock.calls[0]?.[1]?.body as string).delegate).toBe(false);
  });

  it("does not run a bot for partial transcripts; duplicate delegations start one durable request", async () => {
    const o = options(); bridge = new VoiceBridge(o);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "POST" ? { messageId: "reply01" } : { status: "succeeded", text: "Found your notes." }));
    vi.stubGlobal("fetch", fetch);
    bridge.receive(input("u1")); bridge.receive(input("u1"));
    await vi.advanceTimersByTimeAsync(1000); expect(fetch).not.toHaveBeenCalled();
    bridge.receive(delegate()); bridge.receive(delegate());
    await vi.advanceTimersByTimeAsync(400);
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string).fragments).toHaveLength(1);
    expect(o.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session.thinking.append", delegation_id: "d1", content: "Found your notes." }));
  });

  it("waits for a transcript delivered after its delegation", async () => {
    bridge = new VoiceBridge(options());
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "POST" ? { messageId: "reply01" } : { status: "succeeded", text: "Done" }));
    vi.stubGlobal("fetch", fetch);
    bridge.receive(delegate()); await vi.advanceTimersByTimeAsync(400); expect(fetch).not.toHaveBeenCalled();
    bridge.receive(input("u1")); await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalled();
  });

  it("keeps the same batch identity after an unknown outcome and does not start work after End", async () => {
    const o = options(); bridge = new VoiceBridge(o);
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Network lost")).mockResolvedValue(Response.json({ messageId: null, status: "saved" }));
    vi.stubGlobal("fetch", fetch);
    bridge.receive(input("u1")); bridge.receive(delegate()); await vi.advanceTimersByTimeAsync(400);
    expect(o.notice).toHaveBeenCalledWith("Network lost");
    await bridge.finish();
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    const retry = JSON.parse(fetch.mock.calls[1][1].body);
    expect(retry.batchId).toBe(first.batchId); expect(retry.fragments).toEqual(first.fragments);
    expect(retry.delegate).toBe(false);
    expect(bridge.hasUnsaved).toBe(false);
  });

  it("opens approval cards and never submits an approval on spoken yes", async () => {
    const o = options(); bridge = new VoiceBridge(o);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "POST" ? { messageId: "reply01" } : { status: "waiting", text: "" }));
    vi.stubGlobal("fetch", fetch);
    bridge.receive(input("u1")); bridge.receive(delegate()); await vi.advanceTimersByTimeAsync(400);
    bridge.receive(input("u2", "yes", 1100)); await vi.advanceTimersByTimeAsync(1000);
    expect(o.approval).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetch.mock.calls.every(([url]) => !url.includes("approval"))).toBe(true);
  });

  it("drops stale reaction results while keeping speech independent", async () => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    bridge.receive(input("u1")); await vi.advanceTimersByTimeAsync(1);
    for (let i = 2; i < 8; i++) bridge.receive(input(`u${i}`, " more", i * 100));
    resolve(Response.json({ revision: 1, reaction: "smile" })); await vi.advanceTimersByTimeAsync(1);
    expect(o.reaction).not.toHaveBeenCalled();
    expect(o.transcript).toHaveBeenCalledTimes(7);
  });

  it("preserves overlapping speakers and timestamps in reaction context", () => {
    const fragments = [{ id: "a", role: "assistant" as const, text: "Okay", startMs: 100, endMs: 300 }, { id: "u", role: "user" as const, text: "My request", startMs: 0, endMs: 200 }];
    expect(orderedFragments(fragments).map(f => f.id)).toEqual(["u", "a"]);
    expect(reactionContext(fragments, "neutral")).toContain("user: My request\nassistant: Okay");
  });

  it("compacts hundreds of tiny speech fragments without dropping text", () => {
    const fragments = Array.from({ length: 500 }, (_, i) => ({ id: `fragment${i}`, role: "user" as const, text: ` word${i}`, startMs: i, endMs: i + 1 }));
    const packed = compactTranscript(fragments);
    expect(packed).toHaveLength(1);
    expect(packed[0].text).toBe(fragments.map(f => f.text).join(""));
  });
});
