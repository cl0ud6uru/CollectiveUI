import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApp } from "@/db/schema";
const f = vi.hoisted(() => ({ generate: vi.fn(), resolve: vi.fn() }));
vi.mock("ai", () => ({ generateText: f.generate }));
vi.mock("@/lib/llm/resolve", () => ({ resolveModel: f.resolve }));
import { generateTitle, TITLE_TIMEOUT_MS } from "@/lib/llm/title";

const app = { id: "app" } as AiApp;
const context = { userId: "alice", conversationId: "chat" };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  f.resolve.mockResolvedValue({ model: "synthetic" });
  f.generate.mockResolvedValue({ text: '"Short title."' });
});
afterEach(() => { vi.useRealTimers(); });

describe("bounded optional title generation", () => {
  it("retains title cleanup and clears its deadline after success", async () => {
    expect(await generateTitle(app, "hello", context)).toBe("Short title");
    expect(vi.getTimerCount()).toBe(0);
    expect(f.generate.mock.calls[0][0]).toMatchObject({ maxRetries: 0, abortSignal: expect.any(AbortSignal) });
  });

  it("times out a provider that ignores its abort signal", async () => {
    f.generate.mockReturnValue(new Promise(() => {}));
    const result = generateTitle(app, "hello", context);
    const rejected = expect(result).rejects.toThrow("Title generation timed out");
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS);
    await rejected;
    expect(f.generate.mock.calls[0][0].abortSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds model resolution and never starts a late model call after timing out", async () => {
    let resolve!: (value: unknown) => void;
    f.resolve.mockReturnValue(new Promise(r => { resolve = r; }));
    const result = generateTitle(app, "hello", context);
    const rejected = expect(result).rejects.toThrow("Title generation timed out");
    await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS);
    await rejected;
    resolve({ model: "late" }); await Promise.resolve();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("honors Stop immediately and releases the deadline", async () => {
    const controller = new AbortController();
    f.generate.mockReturnValue(new Promise(() => {}));
    const result = generateTitle(app, "hello", { ...context, abortSignal: controller.signal });
    const rejected = expect(result).rejects.toThrow("Stopped");
    await Promise.resolve(); controller.abort(new Error("Stopped"));
    await rejected; expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve a model for an already stopped turn", async () => {
    await expect(generateTitle(app, "hello", { ...context, abortSignal: AbortSignal.abort(new Error("Stopped")) })).rejects.toThrow("Stopped");
    expect(f.resolve).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates provider failures for the existing fallback and clears its timer", async () => {
    f.generate.mockRejectedValue(new Error("Unavailable"));
    await expect(generateTitle(app, "hello", context)).rejects.toThrow("Unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
});
