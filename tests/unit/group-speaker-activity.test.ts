import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { finishPart, text } from "./helpers/run-streams";
const f = vi.hoisted(() => ({ active: new Set<string>(), observed: [] as string[][], model: null as unknown,
  build: vi.fn(), close: vi.fn(), controller: null as AbortController | null }));
vi.mock("@/db", () => ({ db: { transaction: async () => undefined } }));
vi.mock("@/lib/runs/host", () => ({ runHost: () => ({ instanceId: "synthetic-host" }) }));
vi.mock("@/lib/chat/group-bot-work", () => ({ beginGroupBotWork: async ({ botId }: { botId: string }) => {
  f.active.add(botId); return async () => { f.active.delete(botId); };
} }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ maxStepsCap: 6 }) }));
vi.mock("@/lib/agent/memory", () => ({ memoryEnabled: async () => false, selectMemories: async () => [] }));
vi.mock("@/lib/agent/toolset", () => ({ buildToolset: (...args: unknown[]) => f.build(...args) }));
vi.mock("@/lib/agent/prepare", () => ({ resolveAttachmentsForModel: async (history: unknown) => history }));
vi.mock("@/lib/agent/instructions", () => ({ buildInstructionSections: () => [], toModelInstructions: () => "Synthetic group instructions" }));
vi.mock("@/lib/llm", () => ({ newUsageScope: () => ({ pending: [] }), resolveModel: async () => ({ model: f.model, capabilities: { instructionStyle: "legacy" } }), userFacingMessage: () => null }));
vi.mock("@/lib/crypto", () => ({ toolApprovalSecret: () => "synthetic-secret", sha256Hex: () => "synthetic-hash" }));
vi.mock("@/lib/chat/store", () => ({ partsToText: (parts: { type: string; text?: string }[]) => parts.filter(p => p.type === "text").map(p => p.text).join(""), insertMessage: vi.fn(), setCurrentLeaf: vi.fn() }));
vi.mock("@/lib/delegation/receipts", () => ({ receiveGroupResults: vi.fn() }));
import { runGroupTurn } from "@/lib/agent/group";
const base = () => ({
  principal: { user: { id: "alice", name: "Alice", prefs: {} } },
  conversation: { id: "synthetic-group", userId: "alice", isGroup: true },
  members: ["Researcher", "Writer", "Idle"].map(name => ({ bot: { id: name.toLowerCase(), name, maxSteps: 3 }, app: { id: "app", model: "mock" } })),
  history: [{ id: "question", role: "user", parts: [{ type: "text", text: "Please begin" }] }],
});
async function turn(signal?: AbortSignal) {
  const stream = await runGroupTurn({ ...base(), abortSignal: signal } as Parameters<typeof runGroupTurn>[0]);
  const reader = stream.getReader(); const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) return chunks; chunks.push(value); }
}
beforeEach(() => {
  f.active.clear(); f.observed = []; f.controller = null; f.close.mockReset(); f.close.mockResolvedValue(undefined);
  f.build.mockReset(); f.build.mockResolvedValue({ warnings: [], skills: [], tools: {}, close: f.close });
  vi.stubEnv("AUTH_SECRET", "synthetic-offline-test-secret");
});
function model(calls: LanguageModelV4StreamPart[][]) {
  let index = 0;
  f.model = new MockLanguageModelV4({ doStream: async () => {
    f.observed.push([...f.active]);
    return { stream: convertArrayToReadableStream(calls[index++] ?? [finishPart("stop")]) };
  } });
}
describe("real group orchestration with synthetic models", () => {
  it("activates only the current speaker across a handoff and clears work on completion", async () => {
    model([[...text("one", "@Writer please help"), finishPart("stop")], [...text("two", "Finished"), finishPart("stop")]]);
    const chunks = await turn();
    expect(f.observed).toEqual([["researcher"], ["writer"]]); expect([...f.active]).toEqual([]);
    expect(chunks.flatMap(chunk => chunk.type === "data-speaker" && "data" in chunk ? [chunk.data] : [])).toMatchObject([{ botId: "researcher" }, { botId: "writer" }]);
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("clears activity when tool setup fails and does not call a model", async () => {
    model([]); f.build.mockRejectedValue(new Error("Synthetic tool setup failure"));
    const chunks = await turn(); expect(f.observed).toEqual([]); expect([...f.active]).toEqual([]);
    expect(chunks.some(chunk => chunk.type === "data-bot-error")).toBe(true);
  });
  it("clears activity on model errors and stops before the next speaker on cancellation", async () => {
    const controller = new AbortController();
    f.model = new MockLanguageModelV4({ doStream: async () => {
      f.observed.push([...f.active]); controller.abort(); throw new DOMException("Synthetic cancellation", "AbortError");
    } });
    await turn(controller.signal); expect(f.observed).toEqual([["researcher"]]); expect([...f.active]).toEqual([]);
    model([[{ type: "error", error: new Error("Synthetic model failure") }, finishPart("stop")]]);
    const chunks = await turn(); expect([...f.active]).toEqual([]); expect(chunks.some(chunk => chunk.type === "data-bot-error")).toBe(true);
  });
  it("clears activity even if closing the toolset fails", async () => {
    model([[...text("one", "Finished"), finishPart("stop")]]); f.close.mockRejectedValue(new Error("Synthetic close failure"));
    await turn(); expect([...f.active]).toEqual([]);
  });
});
