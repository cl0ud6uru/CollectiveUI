import { tool, type UIMessageChunk } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const h = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  generateTitle: vi.fn(async () => "A title"),
  buildToolset: vi.fn(),
  attachments: vi.fn(async (history: unknown) => history),
  upsertMessage: vi.fn(async () => {}),
  updateMessageParts: vi.fn(async () => {}),
  setCurrentLeaf: vi.fn(async () => {}),
  scheduleMemoryExtraction: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  route: vi.fn(async () => undefined as string[] | undefined),
  decisionsEnabled: false,
}));

vi.mock("@/db", () => {
  const chain = { set: () => chain, where: async () => {}, values: () => chain, onConflictDoUpdate: () => Promise.resolve() };
  return { db: { update: () => chain, insert: () => chain } };
});
vi.mock("@/lib/settings", () => ({ getSetting: async (key: string) => key === "decisions"
  ? { queenRouting: h.decisionsEnabled } : { maxStepsCap: 10, enabled: h.decisionsEnabled, defaultBotId: "b1" } }));
vi.mock("@/lib/agent/queen-routing", () => ({ queenRouting: h.route }));
vi.mock("@/lib/agent/memory", () => ({ memoryEnabled: async () => false, selectMemories: async () => [] }));
vi.mock("@/lib/hermes-team/learning", () => ({ teamUsesNativeLearning: async () => false }));
vi.mock("@/lib/agent/toolset", () => ({ buildToolset: h.buildToolset }));
vi.mock("@/lib/agent/prepare", () => ({ resolveAttachmentsForModel: h.attachments }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  resolveModel: h.resolveModel,
  generateTitle: h.generateTitle,
  utilityApp: async (app: unknown) => app,
}));
vi.mock("@/lib/chat/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/store")>()),
  upsertMessage: h.upsertMessage,
  updateMessageParts: h.updateMessageParts,
  setCurrentLeaf: h.setCurrentLeaf,
}));
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs")>()),
  scheduleMemoryExtraction: h.scheduleMemoryExtraction,
}));

import { runTurn, type TurnOptions } from "@/lib/agent/run";
import { ProviderUnavailableError } from "@/lib/llm";
import type { RunHandle } from "@/lib/runs/types";

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (unified: "stop" | "tool-calls" | "error" = "stop"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified, raw: unified }, usage: USAGE });
const reply = (text: string): LanguageModelV4StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish(),
];
const streamOf = (parts: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: null }) });

let model: MockLanguageModelV4;
const useModel = (doStream: NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doStream"]) => {
  model = new MockLanguageModelV4({ doStream });
  h.resolveModel.mockImplementation(async () => ({
    model,
    capabilities: { instructionStyle: "legacy", embeddings: false, responses: false },
    billing: { source: "org", appId: "app1", providerKind: "openai-compatible", modelId: "m", credentialId: null },
    replayKey: null,
  }));
};

const userMsg = { id: "u-msg", role: "user", parts: [{ type: "text", text: "hi" }] };
const base = (over: Partial<TurnOptions> = {}): TurnOptions => ({
  principal: { user: { id: "u1", name: "Alice", prefs: {} } } as never,
  conversation: { id: "c1", userId: "u1", title: "Chat" } as never,
  app: { id: "app1", model: "m", provider: "openai-compatible", supportsVision: false } as never,
  bot: null,
  history: [userMsg] as never,
  continuation: false,
  ...over,
});

async function drain(stream: ReadableStream<UIMessageChunk>) {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

async function turn(over: Partial<TurnOptions> = {}) {
  const r = await runTurn(base(over));
  const chunks = await drain(r.stream);
  return { ...r, chunks, done: await r.done };
}

const runHandle = (): RunHandle => ({ id: "run-1", segment: 0, legacy: false, resumeState: null, saveResumeState: vi.fn() });
const systemText = () =>
  model.doStreamCalls[0].prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");

describe("runTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.decisionsEnabled = false;
    h.route.mockResolvedValue(undefined);
    h.buildToolset.mockImplementation(async () => ({ tools: {}, skills: [], delegates: [], approval: () => undefined, warnings: [], close: h.close }));
    h.attachments.mockImplementation(async (history: unknown) => history);
    useModel(streamOf(reply("Hello!")));
  });

  it("routes only the first SDK planning step; normal tool approval still denies execution", async () => {
    h.decisionsEnabled = true;
    h.route.mockResolvedValue(["ask_a", "continue_a", "use_skill"]);
    const execute = vi.fn(async () => "should not execute");
    const tools = Object.fromEntries(["ask_a", "ask_b", "continue_a", "use_skill"].map(name => [name, tool({ inputSchema: z.object({ task: z.string() }), execute })]));
    h.buildToolset.mockResolvedValue({ tools, skills: [], delegates: [], approval: () => ({ type: "denied", reason: "Human denied" }), warnings: [], close: h.close });
    useModel([
      streamOf([{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "ask-call", toolName: "ask_a", input: '{"task":"main agent arguments"}' }, finish("tool-calls")]),
      streamOf(reply("The action needs approval.")),
    ]);
    const r = await turn({ bot: { id: "b1", maxSteps: 3 } as never });
    expect(model.doStreamCalls[0].tools?.map(t => t.name)).toEqual(["ask_a", "continue_a", "use_skill"]);
    expect(model.doStreamCalls[1].tools?.map(t => t.name)).toEqual(Object.keys(tools));
    expect(execute).not.toHaveBeenCalled();
    expect(r.chunks.some(c => c.type === "tool-output-denied")).toBe(true);
    expect(h.route).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the picker when the toggle is off", async () => {
    await turn({ bot: { id: "b1", maxSteps: 3 } as never });
    expect(h.route).not.toHaveBeenCalled();
  });

  it("closes the toolset (MCP clients) when turn setup throws", async () => {
    h.attachments.mockRejectedValueOnce(new Error("attachment missing"));
    await expect(runTurn(base())).rejects.toThrow("attachment missing");
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("a plain reply is saved as the pre-allocated message, and the billing source is returned", async () => {
    const r = await turn({ responseMessageId: "msg-pre" });
    expect(r.chunks[0]).toMatchObject({ type: "start", messageId: "msg-pre" });
    expect(r.done).toMatchObject({ responseMessage: { id: "msg-pre" }, pendingApproval: false, error: undefined });
    expect(r.billing).toEqual({ source: "org" });
    expect(h.upsertMessage).toHaveBeenCalledWith("c1", expect.objectContaining({ id: "msg-pre" }), "u-msg", expect.objectContaining({ billingSource: "org" }), expect.anything());
    expect(h.setCurrentLeaf).toHaveBeenCalledWith("c1", "msg-pre", { onlyFrom: undefined }, expect.anything());
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("a model error chunk fails the turn: done.error is the text the chunk showed (never the provider's body)", async () => {
    useModel(
      streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "partial" },
        { type: "error", error: new Error("upstream 500: key sk-live-0123456789abcdef rejected") },
        finish("error"),
      ]),
    );
    const persist = vi.fn(async () => {});
    const r = await turn({ persist });
    expect(r.chunks.filter((c) => c.type === "error")).toEqual([{ type: "error", errorText: "An error occurred." }]);
    expect(r.done.error).toBe("An error occurred.");
    expect(persist).toHaveBeenCalledWith(expect.anything(), { error: "An error occurred." });
  });

  it("an actionable model error is kept as is", async () => {
    useModel(async () => {
      throw new ProviderUnavailableError("Sign in with ChatGPT is turned off. Pick another model.");
    });
    const r = await turn();
    expect(r.done.error).toBe("Sign in with ChatGPT is turned off. Pick another model.");
    expect(r.chunks.find((c) => c.type === "error")).toEqual({ type: "error", errorText: "Sign in with ChatGPT is turned off. Pick another model." });
  });

  it("a failing tool doesn't fail the turn (its error is tool output the model answers)", async () => {
    h.buildToolset.mockImplementation(async () => ({
      tools: {
        boom: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error("nope");
          },
        }),
      },
      skills: [],
      delegates: [],
      approval: () => undefined,
      warnings: [],
      close: h.close,
    }));
    useModel([
      streamOf([{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "call-1", toolName: "boom", input: "{}" }, finish("tool-calls")]),
      streamOf(reply("It failed, sorry.")),
    ]);
    const r = await turn({ bot: { id: "b1", maxSteps: 3 } as never });
    expect(r.chunks.some((c) => c.type === "tool-output-error")).toBe(true);
    expect(r.chunks.some((c) => c.type === "error")).toBe(false);
    expect(r.done.error).toBeUndefined();
  });

  it("the run id and the message id reach the usage scope of every call (model, title, delegates' toolset)", async () => {
    const run = runHandle();
    const r = await turn({ run, responseMessageId: "msg-pre", conversation: { id: "c1", userId: "u1", title: "New chat" } as never });
    const scope = h.resolveModel.mock.calls[0][1].usage;
    expect(scope).toMatchObject({ messageId: "msg-pre", runId: "run-1" });
    expect(h.buildToolset.mock.calls[0][0].usage).toBe(scope);
    expect((h.generateTitle.mock.calls[0] as unknown[])[2]).toMatchObject({ usage: scope });
    expect(r.chunks).toContainEqual({ type: "data-title", data: { title: "A title" }, transient: true });
  });

  it("a continuation extends the stored assistant message whatever id is passed", async () => {
    const stored = { id: "a-msg", role: "assistant", parts: [{ type: "text", text: "Earlier" }] };
    const r = await turn({ history: [userMsg, stored] as never, continuation: true, responseMessageId: "ignored", run: runHandle() });
    expect(r.done.responseMessage.id).toBe("a-msg");
    expect(h.resolveModel.mock.calls[0][1].usage).toMatchObject({ messageId: "a-msg", runId: "run-1" });
    expect(h.updateMessageParts).toHaveBeenCalledWith("c1", expect.objectContaining({ id: "a-msg" }), expect.anything(), expect.anything());
    expect(h.upsertMessage).not.toHaveBeenCalled();
  });

  it("a persist override replaces persistAssistantTurn (no save, no tool log, no memory extraction here)", async () => {
    const persist = vi.fn(async () => {});
    const r = await turn({ persist, responseMessageId: "msg-pre" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "c1",
        userId: "u1",
        botId: null,
        responseMessage: expect.objectContaining({ id: "msg-pre" }),
        isContinuation: false,
        parentId: "u-msg",
        background: false,
        extra: expect.objectContaining({ billingSource: "org", model: "m", appId: "app1" }),
      }),
      { error: undefined },
    );
    expect(h.upsertMessage).not.toHaveBeenCalled();
    expect(h.setCurrentLeaf).not.toHaveBeenCalled();
    expect(h.scheduleMemoryExtraction).not.toHaveBeenCalled();
    expect(r.done.error).toBeUndefined();
  });

  it("a persist override that throws still closes the toolset and resolves done", async () => {
    const persist = vi.fn(async () => {
      throw new Error("lease lost");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await turn({ persist });
    expect(r.done.responseMessage.parts.length).toBeGreaterThan(0);
    expect(h.close).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("background (a routine's first segment) adds the note, reaches resolveModel and skips memory extraction", async () => {
    await turn({ background: true });
    expect(systemText()).toContain("## Background run");
    expect(h.resolveModel.mock.calls[0][1]).toMatchObject({ purpose: "chat", background: true });
    expect(h.buildToolset.mock.calls[0][0]).toMatchObject({ background: true });
    expect(h.upsertMessage).toHaveBeenCalled();
    expect(h.scheduleMemoryExtraction).not.toHaveBeenCalled();
  });

  it("not background (every chat turn, routine continuations): no note, memory extraction scheduled", async () => {
    await turn();
    expect(systemText()).not.toContain("## Background run");
    expect(h.resolveModel.mock.calls[0][1]).toMatchObject({ background: false });
    expect(h.scheduleMemoryExtraction).toHaveBeenCalledWith("c1");
  });

  it("interactive and the run handle are passed to resolveModel", async () => {
    const run = runHandle();
    await turn({ interactive: true, run });
    expect(h.resolveModel.mock.calls[0][1]).toMatchObject({ interactive: true, run });
    vi.clearAllMocks();
    await turn();
    expect(h.resolveModel.mock.calls[0][1]).toMatchObject({ interactive: undefined, run: undefined });
  });
});
