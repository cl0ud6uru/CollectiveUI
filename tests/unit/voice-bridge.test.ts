import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceBridge } from "@/lib/voice/bridge";
import { compactTranscript, orderedFragments, reactionContext, reactionEvidence, reactionIsFresh, reactionUtterances } from "@/lib/voice/policy";

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
    for (let i = 2; i < 8; i++) bridge.receive(input(`u${i}`, " more", 3000 + i * 100));
    resolve(Response.json({ revision: 1, reaction: "smile" })); await vi.advanceTimersByTimeAsync(1);
    expect(o.reaction).not.toHaveBeenCalled();
    expect(o.transcript).toHaveBeenCalledTimes(7);
  });

  it("reacts to a sad partial story before any assistant output despite many tiny deltas", async () => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(r => { resolve = r; })); vi.stubGlobal("fetch", fetch);
    bridge.receive(input("sad", "My friend died", 0)); await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 25; i++) bridge.receive(input(`tiny-${i}`, " x", 100 + i * 10));
    resolve(Response.json({ revision: 1, reaction: "concerned", confidence: 0.95 })); await vi.advanceTimersByTimeAsync(1);
    expect(o.reaction).toHaveBeenCalledWith("concerned", expect.any(Number));
    expect(o.transcript).toHaveBeenCalledTimes(26);
    expect(fetch.mock.calls).toHaveLength(1);
    expect(o.send).not.toHaveBeenCalled(); expect(o.approval).not.toHaveBeenCalled();
  });

  it("rejects an old story reaction when a different speaker interrupts", async () => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    bridge.receive(input("sad", "I lost my friend", 0)); await vi.advanceTimersByTimeAsync(1);
    bridge.receive({ type: "session.output_transcript.delta", event_id: "interrupt", delta: "Let's change the subject", start_ms: 500, end_ms: 800 });
    resolve(Response.json({ revision: 1, reaction: "concerned", confidence: 0.9 })); await vi.advanceTimersByTimeAsync(1);
    expect(o.reaction).not.toHaveBeenCalled();
  });

  it("holds a valid change through the dwell window and does not replay the same pose", async () => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ revision: body.revision, reaction: body.revision === 1 ? "curious" : "concerned", confidence: 0.9 });
    }); vi.stubGlobal("fetch", fetch);
    bridge.receive(input("u1", "There is more", 0)); await vi.advanceTimersByTimeAsync(1);
    bridge.receive(input("u2", " I lost my friend", 100)); await vi.advanceTimersByTimeAsync(449);
    expect(o.reaction.mock.calls.map(call => call[0])).toEqual(["curious"]);
    await vi.advanceTimersByTimeAsync(451);
    expect(o.reaction.mock.calls.map(call => call[0])).toEqual(["curious", "concerned"]);
    bridge.receive(input("u3", " and it has been hard", 200)); await vi.advanceTimersByTimeAsync(2000);
    expect(o.reaction).toHaveBeenCalledTimes(2);
  });

  it.each([{ reaction: "smile", confidence: 0.2 }, { reaction: "smile", confidence: null }, { reaction: "approve", confidence: 1 }, { reaction: "smile", revision: 999 }])("rejects invalid decisions %j", async override => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, confidence: 0.9, ...override })));
    bridge.receive(input("u1")); await vi.advanceTimersByTimeAsync(1000);
    expect(o.reaction).not.toHaveBeenCalled(); expect(o.approval).not.toHaveBeenCalled();
  });

  it("bounds a hung reaction request and processes newer speech without waiting", async () => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      if (signals.length === 1) return new Promise<Response>(() => {});
      return Promise.resolve(Response.json({ revision: 2, reaction: "concerned", confidence: 0.9 }));
    }); vi.stubGlobal("fetch", fetch);
    bridge.receive(input("u1", "My friend", 0)); await vi.advanceTimersByTimeAsync(1);
    bridge.receive(input("u2", " died", 100)); await vi.advanceTimersByTimeAsync(1401);
    expect(signals[0].aborted).toBe(true);
    expect(o.transcript).toHaveBeenCalledTimes(2);
    expect(o.reaction).toHaveBeenCalledWith("concerned", expect.any(Number));
  });

  it("never applies a deferred or in-flight reaction after disposal", async () => {
    const o = { ...options(), reactions: true }; bridge = new VoiceBridge(o);
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    bridge.receive(input("u1")); await vi.advanceTimersByTimeAsync(1); bridge.dispose();
    resolve(Response.json({ revision: 1, reaction: "smile", confidence: 0.9 })); await vi.advanceTimersByTimeAsync(2000);
    expect(o.reaction).not.toHaveBeenCalled();
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

  it("reconstructs full partial meaning and bounds context while preserving the latest focus", () => {
    const fragments = Array.from({ length: 80 }, (_, i) => ({ id: `f${i}`, role: "user" as const, text: i === 0 ? "I am not sad" : " about this", startMs: i * 10, endMs: i * 10 + 10 }));
    expect(reactionUtterances(fragments)).toHaveLength(1);
    expect(reactionContext(fragments, "neutral")).toContain("user: I am not sad about this");
    const newest = { id: "new", role: "assistant" as const, text: "A new topic", startMs: 4000, endMs: 4100 };
    const context = reactionContext([...fragments, newest, inputFragment("late", "older", 1)], "neutral");
    expect(context).toContain("Latest partial utterance (assistant; 4000-4100 ms):\nA new topic");
    expect(context.length).toBeLessThan(5000);
    expect(reactionIsFresh(fragments[0], reactionEvidence([...fragments, newest]), 500)).toBe(false);
    expect(reactionIsFresh(newest, newest, 1401)).toBe(false);
  });

  it("invalidates pre-interruption evidence when another speaker overlaps an earlier user span", () => {
    const sad = { id: "sad", role: "user" as const, text: "My friend died", startMs: 0, endMs: 1000 };
    const interruption = { id: "interrupt", role: "assistant" as const, text: "Can you clarify?", startMs: 500, endMs: 600 };
    const correction = { id: "correction", role: "user" as const, text: "Actually, I meant something else", startMs: 1010, endMs: 1100 };
    const latest = reactionEvidence([sad, interruption, correction]);
    expect(latest?.id).toBe("correction");
    expect(reactionIsFresh(sad, latest, 500)).toBe(false);
    expect(reactionUtterances([sad, interruption, correction])).toHaveLength(3);
  });
});

const inputFragment = (id: string, text: string, startMs: number) => ({ id, role: "user" as const, text, startMs, endMs: startMs + 1 });
