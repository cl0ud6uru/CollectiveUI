import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchBotWork } from "@/lib/chat/watch-bot-work";
let stop: (() => void) | undefined;
let hidden = false;
beforeEach(() => {
  vi.useFakeTimers(); hidden = false;
  vi.stubGlobal("window", new EventTarget());
  const document = new EventTarget();
  Object.defineProperty(document, "hidden", { get: () => hidden });
  vi.stubGlobal("document", document);
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
const reply = (snapshot: object, status = 200) => new Response(JSON.stringify(snapshot), { status });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("bot work snapshot refresh", () => {
  it("replaces completed/error/cancelled snapshots and refreshes after focus, reconnect and visibility", async () => {
    const receive = vi.fn(); const fetch = vi.fn().mockResolvedValue(reply({ researcher: "working", writer: null }));
    vi.stubGlobal("fetch", fetch); stop = watchBotWork(receive); await flush();
    expect(receive).toHaveBeenLastCalledWith({ researcher: "working", writer: null });
    fetch.mockResolvedValue(reply({ researcher: null, writer: "working" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(receive).toHaveBeenLastCalledWith({ researcher: null, writer: "working" });
    fetch.mockRejectedValue(new Error("Synthetic offline")); await vi.advanceTimersByTimeAsync(2000);
    fetch.mockResolvedValue(reply({ researcher: null, writer: null }));
    window.dispatchEvent(new Event("online")); await flush();
    expect(receive).toHaveBeenLastCalledWith({ researcher: null, writer: null });
    hidden = true; const calls = fetch.mock.calls.length; await vi.advanceTimersByTimeAsync(4000); expect(fetch).toHaveBeenCalledTimes(calls);
    hidden = false; document.dispatchEvent(new Event("visibilitychange")); await flush();
    window.dispatchEvent(new Event("focus")); await flush(); expect(fetch).toHaveBeenCalledTimes(calls + 2);
    fetch.mockResolvedValue(reply({}, 403)); window.dispatchEvent(new Event("bot-work-changed")); await flush(); expect(receive).toHaveBeenLastCalledWith({});
  });
  it("coalesces work events during a pending request and aborts/discards a late response on teardown", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })).mockResolvedValue(reply({ researcher: null }));
    vi.stubGlobal("fetch", fetch); const receive = vi.fn(); stop = watchBotWork(receive);
    window.dispatchEvent(new Event("bot-work-changed")); window.dispatchEvent(new Event("focus"));
    expect(fetch).toHaveBeenCalledTimes(1); resolve(reply({ researcher: "working" })); await flush();
    expect(fetch).toHaveBeenCalledTimes(2); expect(receive).toHaveBeenLastCalledWith({ researcher: null });
    fetch.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })); window.dispatchEvent(new Event("focus"));
    const signal = fetch.mock.calls.at(-1)![1].signal as AbortSignal;
    stop(); stop = undefined; expect(signal.aborted).toBe(true); const calls = receive.mock.calls.length;
    resolve(reply({ researcher: "working" })); await flush(); expect(receive).toHaveBeenCalledTimes(calls);
  });
});
