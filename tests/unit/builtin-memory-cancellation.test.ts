import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCtx } from "@/lib/agent/types";
const h = vi.hoisted(() => ({ embed: vi.fn(), insert: vi.fn(), remove: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {
  insert: () => ({ values: (value: unknown) => { h.insert(value); return { returning: async () => [{ id: "fixture-memory" }] }; } }),
  delete: () => { h.remove(); return { where: () => ({ returning: async () => [{ id: "fixture-memory" }] }) }; },
} }));
vi.mock("@/lib/llm", () => ({ embedTexts: h.embed }));
vi.mock("@/lib/agent/learning/store", () => ({ learnedPreferences: async () => [] }));
vi.mock("@/lib/hermes-team/learning", () => ({ withNonTeamLearning: vi.fn() }));
import { addMemory } from "@/lib/agent/memory";
import { memoryTools } from "@/lib/agent/tools/memory";

const ctx = { principal: { user: { id: "fixture-owner" } }, bot: { id: "fixture-bot" }, conversationId: "fixture-chat" } as AgentCtx;
const invoke = (name: string, input: unknown, abortSignal: AbortSignal) => memoryTools(ctx).find(t => t.name === name)!.tool.execute!(input, { toolCallId: "fixture-call", messages: [], context: undefined, abortSignal });
describe("native memory cancellation", () => {
  beforeEach(() => { h.embed.mockReset(); h.insert.mockReset(); h.remove.mockReset(); h.embed.mockResolvedValue(null); });
  it("does not embed or insert an already stopped remember call", async () => {
    const reason = new Error("fixture stopped");
    await expect(invoke("remember", { fact: "Synthetic preference" }, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(h.embed).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
  });
  it("does not delete on an already stopped forget call", async () => {
    const reason = new Error("fixture stopped");
    await expect(invoke("forget", { id: "fixture-memory" }, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it("does not fall back to an unembedded insert after embedding cancellation", async () => {
    const controller = new AbortController(), reason = new Error("fixture embedding stopped");
    h.embed.mockImplementation(async () => { controller.abort(reason); throw reason; });
    await expect(invoke("remember", { fact: "Synthetic preference" }, controller.signal)).rejects.toBe(reason);
    expect(h.embed.mock.calls[0][2].abortSignal).toBe(controller.signal);
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("rechecks Stop after a pending embedding completes", async () => {
    const controller = new AbortController(), reason = new Error("fixture stopped during embedding");
    let release!: (value: null) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.embed.mockImplementation(() => new Promise<null>(resolve => { release = resolve; entered(); }));
    const result = invoke("remember", { fact: "Synthetic preference" }, controller.signal);
    await started; controller.abort(reason); release(null);
    await expect(result).rejects.toBe(reason); expect(h.insert).not.toHaveBeenCalled();
  });
  it("rechecks Stop after the last asynchronous consent check", async () => {
    const controller = new AbortController(), reason = new Error("fixture stopped during consent");
    await expect(addMemory("fixture-owner", null, "Synthetic preference", undefined, undefined, controller.signal, undefined,
      async () => { controller.abort(reason); return true; })).rejects.toBe(reason);
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("keeps an acknowledged insert successful when Stop arrives afterward", async () => {
    const controller = new AbortController();
    h.insert.mockImplementation(() => controller.abort());
    await expect(invoke("remember", { fact: "Synthetic preference" }, controller.signal)).resolves.toEqual({ saved: true, recordType: "ordinary_memory", id: "fixture-memory" });
    expect(h.insert).toHaveBeenCalledTimes(1);
  });
});
