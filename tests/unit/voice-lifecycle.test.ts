import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceBridge } from "@/lib/voice/bridge";
import { liveHistory, voiceHistory } from "@/lib/voice/history";

const input = (id: string, text: string, start = 0, end = start + 100) => ({ type: "session.input_transcript.delta", event_id: id, delta: text, start_ms: start, end_ms: end });
const delegate = (id = "d1", offset = 100) => ({ type: "session.delegation.created", event_id: `event-${id}`, offset_ms: offset, delegation: { id, target: "client" } });
const options = () => ({ conversationId: "conversation01", sessionId: "live01", reactions: false,
  send: vi.fn(), changed: vi.fn(), transcript: vi.fn(), reaction: vi.fn(), notice: vi.fn(), approval: vi.fn() });
let bridge: VoiceBridge;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); })); });
afterEach(() => { bridge?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("voice lifecycle and verified result ordering", () => {
  it("resets a retained concerned renderer before a new neutral decision", async () => {
    let displayed = "concerned";
    const o = { ...options(), reactions: true, reaction: vi.fn((value: string) => { displayed = value; }) };
    bridge = new VoiceBridge(o);
    expect(displayed).toBe("neutral");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ revision: 1, reaction: "neutral", confidence: 1 })));
    bridge.receive(input("u1", "Hello")); await vi.advanceTimersByTimeAsync(1);
    expect(displayed).toBe("neutral");
    expect(o.reaction).toHaveBeenCalledOnce();
  });

  it("keeps roles and whole messages within startup limits", () => {
    const messages = [{ id: "old", role: "user", text: "x".repeat(5000) }, { id: "u", role: "user", text: "A recent question" },
      { id: "a", role: "assistant", text: "x".repeat(1500) }, { id: "tool", role: "tool", text: "not a text role" }];
    expect(voiceHistory(messages).map(message => message.id)).toEqual(["u", "a"]);
    expect(liveHistory(messages)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "A recent question" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(1500) }] },
    ]);
    expect(liveHistory([])).toEqual([]);
  });

  it("does not replay seeded or repeated history and skips partial backend refreshes", async () => {
    const history = [{ id: "u", role: "user", text: "Old topic" }];
    const o = options(); bridge = new VoiceBridge({ ...o, history });
    bridge.context(history); expect(o.send).not.toHaveBeenCalled();
    const update = [{ id: "a", role: "assistant", text: "Saved complete answer" }];
    bridge.context(update); bridge.context(update);
    expect(o.send).toHaveBeenCalledOnce();
    expect(o.send.mock.calls[0][0].type).toBe("session.thinking.append");
    bridge.receive(input("u1", "Check it")); bridge.receive(delegate());
    bridge.context([{ id: "partial", role: "assistant", text: "Unfinished tool reply" }]);
    expect(o.send).toHaveBeenCalledOnce();
  });

  it("waits for delayed transcript coverage and quiescence before admitting the full request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ messageId: null, status: "saved" }));
    bridge = new VoiceBridge({ ...options(), fetcher });
    bridge.receive(input("u1", "Set ", 0, 100)); bridge.receive(delegate("d1", 900));
    await vi.advanceTimersByTimeAsync(500); expect(fetcher).not.toHaveBeenCalled();
    bridge.receive(input("u2", "the kitchen light to blue", 100, 900));
    await vi.advanceTimersByTimeAsync(700); expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).fragments[0].text).toBe("Set the kitchen light to blue");
  });

  it("fails closed for missing offsets and ongoing user delivery without losing speech", async () => {
    const o = options(); const fetcher = vi.fn<typeof fetch>(); bridge = new VoiceBridge({ ...o, fetcher });
    bridge.receive(input("u1", "Set "));
    bridge.receive({ type: "session.delegation.created", delegation: { id: "invalid", target: "client" } });
    bridge.receive(delegate("far", 9000));
    for (let i = 0; i < 7; i++) { await vi.advanceTimersByTimeAsync(450); bridge.receive(input(`partial-${i}`, " more", 100 + i * 100)); }
    expect(fetcher).not.toHaveBeenCalled(); expect(bridge.hasUnsaved).toBe(true);
    expect(o.send.mock.calls.filter(([event]) => event.type === "session.commentary.append")).toHaveLength(2);
  });

  it("admits a complete request delegated after silence using longer user-delivery quiescence", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ messageId: null, status: "saved" }));
    bridge = new VoiceBridge({ ...options(), fetcher });
    bridge.receive(input("u1", "What is the kitchen temperature?", 0, 1000));
    bridge.receive(delegate("d1", 1800));
    await vi.advanceTimersByTimeAsync(1000); expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800); expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not substitute assistant acknowledgment for missing user coverage", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ messageId: null, status: "saved" }));
    bridge = new VoiceBridge({ ...options(), fetcher });
    bridge.receive(input("u1", "Set ", 0, 100));
    bridge.receive({ type: "session.output_transcript.delta", event_id: "ack", delta: "Okay", start_ms: 100, end_ms: 900 });
    bridge.receive(delegate("d1", 900)); await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).not.toHaveBeenCalled();
    bridge.receive(input("u2", "the light to blue", 100, 900)); await vi.advanceTimersByTimeAsync(800);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).fragments.find((f: { role: string }) => f.role === "user").text).toBe("Set the light to blue");
  });

  it("keeps details spoken beyond an early delegation boundary for a later complete delegation", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ messageId: null, status: "saved" }));
    bridge = new VoiceBridge({ ...options(), fetcher });
    bridge.receive(input("u1", "Set ")); bridge.receive(delegate());
    await vi.advanceTimersByTimeAsync(500);
    bridge.receive(input("u2", "the light to blue", 200, 300));
    await vi.advanceTimersByTimeAsync(800); expect(fetcher).not.toHaveBeenCalled();
    bridge.receive(delegate("d2", 300)); await vi.advanceTimersByTimeAsync(800);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).fragments[0].text).toBe("Set the light to blue");
  });

  it("waits through child-task work and sends verified facts directly with their original ID", async () => {
    let status = "waiting_tasks";
    const o = options(); const fetcher = vi.fn<typeof fetch>(async (_url, init) => Response.json(init?.method === "POST" ? { messageId: "reply01" } : { status, text: "The light is blue." }));
    bridge = new VoiceBridge({ ...o, fetcher }); bridge.receive(input("u1", "Set the light to blue")); bridge.receive(delegate());
    await vi.advanceTimersByTimeAsync(800);
    expect(o.send.mock.calls.some(([event]) => event.type === "session.instructions.append" && event.content.includes("Do not answer dependent questions"))).toBe(true);
    expect(o.send.mock.calls.some(([event]) => event.type === "session.commentary.append")).toBe(false);
    status = "succeeded"; await vi.advanceTimersByTimeAsync(1000);
    expect(o.send).toHaveBeenCalledWith(expect.objectContaining({ type: "session.commentary.append", delegation_id: "d1", content: "Backend reply (succeeded):\nThe light is blue." }));
  });

  it("supersedes speech after correction while preserving real backend state and admitting no duplicate original action", async () => {
    let status = "running";
    const o = options(); const fetcher = vi.fn<typeof fetch>(async (url, init) => Response.json(init?.method === "POST"
      ? { messageId: JSON.parse(String(init.body)).fragments[0].text.startsWith("Actually") ? "reply02" : "reply01" }
      : { status, text: String(url).includes("reply02") ? "The earlier action already completed. No cancellation is confirmed." : "The light is on." }));
    bridge = new VoiceBridge({ ...o, fetcher }); bridge.receive(input("u1", "Turn on the light")); bridge.receive(delegate());
    await vi.advanceTimersByTimeAsync(800);
    bridge.receive(input("u2", "Actually, don't turn it on", 200, 300)); bridge.receive(delegate("d2", 300));
    await vi.advanceTimersByTimeAsync(5000); // A correction can wait behind a long-running task.
    status = "succeeded"; await vi.advanceTimersByTimeAsync(1000);
    const commentary = o.send.mock.calls.filter(([event]) => event.type === "session.commentary.append").map(([event]) => event.content);
    expect(commentary).not.toContain("Backend reply (succeeded):\nThe light is on.");
    expect(o.send.mock.calls.some(([event]) => event.type === "session.thinking.append" && event.content.includes("does not confirm cancellation"))).toBe(true);
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
    expect(posts).toHaveLength(2);
    expect(posts.map(post => post.fragments[0].text)).toEqual(["Turn on the light", "Actually, don't turn it on"]);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes("stop"))).toBe(true);
  });

  it("does not newly admit an old action on retry after a correction and unknown HTTP outcome", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("Unknown outcome")).mockResolvedValue(Response.json({ messageId: null, status: "saved" }));
    bridge = new VoiceBridge({ ...options(), fetcher }); bridge.receive(input("u1", "Turn on the light")); bridge.receive(delegate());
    await vi.advanceTimersByTimeAsync(800);
    bridge.receive(input("u2", "Actually, leave it off", 200, 300)); bridge.receive(delegate("d2", 300));
    await bridge.flush();
    const original = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const retry = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(retry.batchId).toBe(original.batchId); expect(retry.fragments).toEqual(original.fragments); expect(retry.delegate).toBe(false);
  });

  it("handles correlated append rejection without retrying an action or treating acknowledgment as tool success", () => {
    const o = options(); bridge = new VoiceBridge(o);
    bridge.context([{ id: "m", role: "assistant", text: "Old context" }]);
    const event = o.send.mock.calls[0][0];
    expect(bridge.receive({ type: "error", client_event_id: event.event_id })).toBe(true);
    expect(o.notice).toHaveBeenCalledOnce(); expect(o.approval).not.toHaveBeenCalled();
  });
});
