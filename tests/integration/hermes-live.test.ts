import { streamText, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { closeAllParked, HermesLanguageModel, type HermesTurnContext } from "@/lib/llm/providers/hermes";
import { runIdOfApproval } from "@/lib/llm/providers/hermes/mapper";
import { isParked } from "@/lib/llm/providers/hermes/runs";
import type { ResumeState, RunHandle } from "@/lib/runs/types";

/**
 * Against a real Hermes gateway whose profile runs on dev/mock-llm (so scripted tool calls work), e.g.:
 *   HERMES_TEST_URL=http://127.0.0.1:8642 HERMES_TEST_PROFILE=coder HERMES_TEST_KEY=… npx vitest run --project integration hermes-live
 * Skipped otherwise. Uses a throwaway directory under /tmp for the approval cases. Turns run the way the run executor
 * runs them: `interactive` with a RunHandle, so a pause holds the stream in this process's registry and saves the
 * resume state a continuation elsewhere (another worker, after a restart) uses.
 */
const url = process.env.HERMES_TEST_URL;
const run = url ? describe : describe.skip;

type Seen = { type: string; [k: string]: unknown };

run("Hermes provider against a live Hermes gateway", () => {
  const target = { baseUrl: url!, profile: process.env.HERMES_TEST_PROFILE ?? "", apiKey: process.env.HERMES_TEST_KEY ?? "" };
  const ctx = (over: Partial<HermesTurnContext> = {}): HermesTurnContext => ({
    target,
    sessionId: `portal-it-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: "portal-it",
    interactive: true,
    approvalTimeoutSec: 300,
    ...over,
  });
  /** A portal run as the executor passes it: `saved` is what the provider stored at the pause. */
  const runHandle = (id: string, resumeState: ResumeState | null = null) => {
    const saved: ResumeState[] = [];
    const handle: RunHandle = { id, segment: 0, legacy: false, resumeState, saveResumeState: vi.fn((s: ResumeState) => void saved.push(s)) };
    return { handle, saved };
  };
  const answer = (approvalId: string, approved: boolean): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-approval-response", approvalId, approved, providerExecuted: true } as never],
  });

  async function turn(c: HermesTurnContext, messages: ModelMessage[]) {
    const r = streamText({ model: new HermesLanguageModel("coder", c), messages, instructions: "The portal user is Alice." });
    const seen: Seen[] = [];
    for await (const p of r.stream) seen.push(p as Seen);
    return { seen, messages: (await r.response).messages, text: await r.text, usage: await r.totalUsage };
  }

  it("streams a reply, reports usage, and keeps the conversation in one Hermes session", async () => {
    const c = ctx();
    const first = await turn(c, [{ role: "user", content: "hello there" }]);
    expect(first.text).toContain("hello there");
    expect(first.usage.inputTokens).toBeGreaterThan(0);
    const finish = first.seen.find((p) => p.type === "finish-step") as { providerMetadata?: { hermes?: { runId?: string } } } | undefined;
    expect(finish?.providerMetadata?.hermes?.runId).toMatch(/^run_/);
  }, 30_000); // the first run after the gateway starts is slow

  it("shows Hermes tool steps as provider-executed tool calls with their results", async () => {
    const { seen } = await turn(ctx(), [{ role: "user", content: '[tool:terminal {"command":"echo portal-hermes-ok"}]' }]);
    const call = seen.find((p) => p.type === "tool-call") as { toolName: string; providerExecuted?: boolean; toolCallId: string } | undefined;
    expect(call).toMatchObject({ toolName: "hermes__terminal", providerExecuted: true });
    const result = seen.find((p) => p.type === "tool-result") as { toolCallId: string; output: { output?: string } } | undefined;
    expect(result?.toolCallId).toBe(call!.toolCallId);
    expect(result?.output.output).toContain("portal-hermes-ok");
  });

  it("pauses on a flagged command (held in the registry, resume state saved), then runs it once approved", async () => {
    const { mkdirSync, existsSync } = await import("node:fs");
    const dir = `/tmp/portal-hermes-it-${process.pid}-a`;
    mkdirSync(dir, { recursive: true });
    const c = ctx();
    const first = runHandle("it-run-approve");
    const ask: ModelMessage[] = [{ role: "user", content: `[tool:terminal {"command":"rm -rf ${dir}"}]` }];
    const paused = await turn({ ...c, run: first.handle }, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as { approvalId: string; toolCall: { input: { command?: string; reason?: string } } } | undefined;
    expect(request?.approvalId).toMatch(/^hermes\.run_/);
    expect(request?.toolCall.input.command).toContain(dir);
    expect(request?.toolCall.input.reason).toBeTruthy();
    expect(existsSync(dir)).toBe(true);
    const hermesRunId = runIdOfApproval(request!.approvalId)!;
    expect(isParked(hermesRunId)).toBe(true);
    expect(first.saved).toEqual([{ hermes: expect.objectContaining({ runId: hermesRunId, state: expect.objectContaining({ runId: hermesRunId }) }) }]);

    const resumed = await turn({ ...c, run: runHandle("it-run-approve", first.saved[0]).handle }, [...ask, ...paused.messages, answer(request!.approvalId, true)]);
    expect(isParked(hermesRunId)).toBe(false);
    expect(resumed.seen.some((p) => p.type === "tool-result")).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("a denied command doesn't run", async () => {
    const { mkdirSync, existsSync, rmSync } = await import("node:fs");
    const dir = `/tmp/portal-hermes-it-${process.pid}-d`;
    mkdirSync(dir, { recursive: true });
    const c = ctx();
    const first = runHandle("it-run-deny");
    const ask: ModelMessage[] = [{ role: "user", content: `[tool:terminal {"command":"rm -rf ${dir}"}]` }];
    const paused = await turn({ ...c, run: first.handle }, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as { approvalId: string } | undefined;
    const resumed = await turn({ ...c, run: runHandle("it-run-deny", first.saved[0]).handle }, [...ask, ...paused.messages, answer(request!.approvalId, false)]);
    expect(resumed.seen.some((p) => p.type === "tool-output-denied")).toBe(true);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resume with an empty registry (a restarted worker) and the saved resume state posts the answer and finishes", async () => {
    const { mkdirSync, existsSync } = await import("node:fs");
    const dir = `/tmp/portal-hermes-it-${process.pid}-r`;
    mkdirSync(dir, { recursive: true });
    const c = ctx();
    const first = runHandle("it-run-restart");
    const ask: ModelMessage[] = [{ role: "user", content: `[tool:terminal {"command":"rm -rf ${dir}"}]` }];
    const paused = await turn({ ...c, run: first.handle }, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as { approvalId: string; toolCall: { toolCallId: string } } | undefined;
    expect(request).toBeTruthy();
    expect(first.saved).toHaveLength(1);
    closeAllParked(); // what a worker does on shutdown: the Hermes run keeps waiting for its answer

    const calls: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const lastEventId = (init?.headers as Record<string, string> | undefined)?.["Last-Event-ID"];
      calls.push(`${init?.method ?? "GET"} ${String(input).replace(url!, "")}${lastEventId ? ` after ${lastEventId}` : ""}`);
      return fetch(input, init);
    };
    const resumed = await turn(
      { ...c, target: { ...target, fetch: recording }, run: runHandle("it-run-restart", first.saved[0]).handle },
      [...ask, ...paused.messages, answer(request!.approvalId, true)],
    );
    const hermesRunId = runIdOfApproval(request!.approvalId)!;
    expect(calls.some((x) => x.startsWith("POST") && x.endsWith(`/v1/runs/${hermesRunId}/approval`))).toBe(true);
    // Re-attached after the last event read at the pause (newer Hermes), or settled from the run's status (older).
    const lastEventId = first.saved[0].hermes?.lastEventId;
    if (lastEventId) expect(calls.some((x) => x.includes(`/v1/runs/${hermesRunId}/events after ${lastEventId}`))).toBe(true);
    expect(resumed.seen.at(-1)?.type).toBe("finish");
    expect(resumed.seen.some((p) => p.type === "error")).toBe(false);
    // The pairing came from the saved state: nothing from before the pause is shown again.
    expect(resumed.seen.some((p) => p.type === "tool-call" && p.toolCallId === request!.toolCall.toolCallId)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("turns nobody can answer deny flagged commands and carry on", async () => {
    const { mkdirSync, existsSync, rmSync } = await import("node:fs");
    const dir = `/tmp/portal-hermes-it-${process.pid}-h`;
    mkdirSync(dir, { recursive: true });
    const { seen } = await turn(ctx({ interactive: false }), [{ role: "user", content: `[tool:terminal {"command":"rm -rf ${dir}"}]` }]);
    expect(seen.some((p) => p.type === "tool-approval-request")).toBe(false);
    expect(seen.some((p) => p.type === "tool-error")).toBe(true);
    expect(seen.at(-1)?.type).toBe("finish");
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stopping the turn stops the Hermes run", async () => {
    const calls: string[] = [];
    let runId = "";
    const recording: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const u = String(input);
      calls.push(`${init?.method ?? "GET"} ${u.replace(url!, "")}`);
      if (init?.method === "POST" && u.endsWith("/v1/runs")) runId = ((await res.clone().json()) as { run_id: string }).run_id;
      return res;
    };
    const ac = new AbortController();
    const r = streamText({
      model: new HermesLanguageModel("coder", ctx({ target: { ...target, fetch: recording } })),
      messages: [{ role: "user", content: "[slow] tell me a long story" }],
      abortSignal: ac.signal,
    });
    let deltas = 0;
    try {
      for await (const p of r.stream) if (p.type === "text-delta" && ++deltas === 2) ac.abort();
    } catch {
      // aborted
    }
    await new Promise((res) => setTimeout(res, 1500));
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith(`/v1/runs/${runId}/stop`))).toBe(true);
    const { getRun } = await import("@/lib/llm/providers/hermes/client");
    expect(["cancelled", "interrupted"]).toContain((await getRun(target, runId)).status);
  });
});
