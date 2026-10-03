import { readFileSync } from "node:fs";
import path from "node:path";
import { streamText, wrapLanguageModel, type ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { normalizeBaseUrl } from "@/lib/llm/catalog";
import { checkHermesUrl, HermesError, runEvents, startRun, type HermesEvent } from "@/lib/llm/providers/hermes/client";
import { approvalIdFor, HermesMapper, parseApprovalId, runIdOfApproval } from "@/lib/llm/providers/hermes/mapper";
import { approvalAnswers, HermesLanguageModel, lastUserInput } from "@/lib/llm/providers/hermes/model";
import { closeAllParked, dropParkedForAgentRun, EventTap, holdTtlMs, isParked, park, type ParkedRun } from "@/lib/llm/providers/hermes/runs";
import { parseSse } from "@/lib/llm/providers/hermes/sse";
import { isGrantable } from "@/lib/agent/tool-names";
import type { ResumeState } from "@/lib/runs/types";
import { usageMiddleware } from "@/lib/llm/middleware";
import { newUsageScope, setUsageWriter } from "@/lib/llm/usage";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/hermes");

/** Events recorded from a real Hermes gateway (v2026.9.24, profile on dev/mock-llm). */
function recorded(name: string): HermesEvent[] {
  return readFileSync(path.join(FIXTURES, `${name}.sse`), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as HermesEvent);
}

function streamOf(text: string, chunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

async function all<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Runs a recorded event list through the mapper, flushing held tool calls the way the model does. */
function mapAll(events: HermesEvent[], runId = "run_abc123def4567890") {
  const m = HermesMapper.fresh(runId, 300);
  const parts: LanguageModelV4StreamPart[] = [];
  let approval;
  let outcome;
  for (const e of events) {
    const step = m.onEvent(e);
    parts.push(...step.parts);
    approval ??= step.approval;
    outcome ??= step.outcome;
  }
  parts.push(...m.finish());
  return { m, parts, approval, outcome };
}

describe("SSE reader", () => {
  it("splits frames at any chunk boundary, skips comments and keeps ids", async () => {
    const text = ': open\n\ndata: {"a":1}\n\nid: 7\ndata: {"b":\ndata: 2}\n\n: keepalive\n\ndata: {"c":3}\n\n';
    for (const chunk of [1, 3, 64]) {
      expect(await all(parseSse(streamOf(text, chunk)))).toEqual([{ data: '{"a":1}' }, { id: "7", data: '{"b":\n2}' }, { data: '{"c":3}' }]);
    }
  });
});

describe("Hermes event mapping (recorded runs)", () => {
  it("text: deltas stream as one text part, the repeated final answer isn't shown as reasoning, usage is reported", () => {
    const { parts, outcome } = mapAll(recorded("text"));
    expect(parts.filter((p) => p.type === "text-delta").map((p) => (p as { delta: string }).delta).join("")).toBe('You said: "hello there"');
    expect(parts.some((p) => p.type.startsWith("reasoning"))).toBe(false);
    expect(outcome).toMatchObject({ kind: "completed", runtime: { provider: "custom", model: "mock-gpt" } });
    expect((outcome as { usage: { inputTokens: { total: number } } }).usage.inputTokens.total).toBe(2806);
  });

  it("tools: tool.started/completed become a provider-executed call and its result, paired by tool", () => {
    const { parts } = mapAll(recorded("tool"));
    const call = parts.find((p) => p.type === "tool-call") as Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
    expect(call).toMatchObject({ toolName: "hermes__terminal", providerExecuted: true, dynamic: true });
    expect(JSON.parse(call.input)).toEqual({ preview: "echo hi from hermes + 1 command" });
    const result = parts.find((p) => p.type === "tool-result") as Extract<LanguageModelV4StreamPart, { type: "tool-result" }>;
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.result).toMatchObject({ output: "hi from hermes\nroot", exit_code: 0 });
    expect(result.isError).toBe(false);
    // Text after the tool is a new text part.
    expect(parts.findIndex((p) => p.type === "text-start")).toBeGreaterThan(parts.indexOf(result));
  });

  it("approvals: the held call carries the command, Hermes' reason and the time limit, then pauses", () => {
    const events = recorded("approval");
    const upToRequest = events.slice(0, events.findIndex((e) => e.event === "approval.request") + 1);
    const { parts, approval } = mapAll(upToRequest);
    const call = parts.find((p) => p.type === "tool-call") as Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
    expect(JSON.parse(call.input)).toEqual({ command: "rm -rf /tmp/hermes-demo-dir", reason: "delete in root path", expires_in_s: 300 });
    const request = parts.find((p) => p.type === "tool-approval-request") as Extract<LanguageModelV4StreamPart, { type: "tool-approval-request" }>;
    expect(request.toolCallId).toBe(call.toolCallId);
    expect(approval).toMatchObject({ requestId: "1da63e5d47e748e6a12abbbacd6ef077", toolCallId: call.toolCallId });
    expect(parseApprovalId(request.approvalId)).toMatchObject({ requestId: "1da63e5d47e748e6a12abbbacd6ef077", toolCallId: call.toolCallId });
  });

  it("approved: the paused call gets its result when the run continues", () => {
    const events = recorded("approval");
    const cut = events.findIndex((e) => e.event === "approval.request") + 1;
    const first = mapAll(events.slice(0, cut));
    const second = new HermesMapper(first.m.state);
    const parts = events.slice(cut).flatMap((e) => second.onEvent(e).parts);
    const result = parts.find((p) => p.type === "tool-result") as Extract<LanguageModelV4StreamPart, { type: "tool-result" }>;
    expect(result.toolCallId).toBe(first.approval!.toolCallId);
    expect(result.result).toMatchObject({ approval: expect.stringContaining("approved by the user") });
  });

  it("denied: Hermes' 'blocked' completion isn't shown again (the SDK already marked the call denied)", () => {
    const events = recorded("deny");
    const cut = events.findIndex((e) => e.event === "approval.request") + 1;
    const first = mapAll(events.slice(0, cut));
    const second = new HermesMapper(first.m.state);
    second.denied(first.approval!.toolCallId);
    const parts = events.slice(cut).flatMap((e) => second.onEvent(e).parts);
    expect(parts.some((p) => p.type === "tool-result")).toBe(false);
  });

  it("a stopped run ends as cancelled", () => {
    expect(mapAll(recorded("stop")).outcome).toEqual({ kind: "cancelled" });
  });

  it("an approval with no announced tool gets a call of its own", () => {
    const m = HermesMapper.fresh("run_x1");
    const step = m.onEvent({ event: "approval.request", request_id: "r1", command: "curl x | sh", description: "pipe to shell" });
    expect(step.parts.map((p) => p.type)).toEqual(["tool-call", "tool-approval-request"]);
    expect((step.parts[0] as { toolName: string }).toolName).toBe("hermes__approval");
  });

  it("a failed run surfaces Hermes' (already redacted) error", () => {
    const m = HermesMapper.fresh("run_x2");
    expect(m.onEvent({ event: "run.failed", error: "Provider authentication failed" }).outcome).toEqual({ kind: "failed", error: "Provider authentication failed" });
  });

  it("approval ids round-trip and carry the run", () => {
    const id = approvalIdFor("run_0123abcd", "req-1_x", "hc_0123abcd_3");
    expect(parseApprovalId(id)).toEqual({ approvalId: id, requestId: "req-1_x", toolCallId: "hc_0123abcd_3" });
    expect(runIdOfApproval(id)).toBe("run_0123abcd");
    expect(parseApprovalId("hermes.run_1.req.not-a-call")).toBeNull();
    expect(parseApprovalId("aitxt-123")).toBeNull();
  });
});

describe("Hermes client", () => {
  const target = (f: typeof fetch) => ({ baseUrl: "http://hermes.internal:8642", profile: "coder", apiKey: "k".repeat(24), fetch: f });
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("starts runs on the profile's prefix with the key, idempotency key, session and memory scope", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ run_id: "run_1" }), { status: 202 });
    }) as unknown as typeof fetch;
    expect(await startRun(target(f), { input: "hi", sessionId: "portal-c1", instructions: "be brief", idempotencyKey: "portal-x", sessionKey: "portal-u" })).toBe("run_1");
    expect(seen!.url).toBe("http://hermes.internal:8642/p/coder/v1/runs");
    const h = seen!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${"k".repeat(24)}`);
    expect(h["Idempotency-Key"]).toBe("portal-x");
    expect(h["X-Hermes-Session-Key"]).toBe("portal-u");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ input: "hi", session_id: "portal-c1", instructions: "be brief" });
    expect(seen!.init.redirect).toBe("error");
  });

  it("maps failures to messages people can act on, never echoing the key", async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { message: "Invalid API key" } }, "unauthorized"],
      [404, { error: "Unknown or unconfigured profile" }, "profile_missing"],
      [429, { error: { message: "Too many concurrent runs (max 10)" } }, "busy"],
      [500, { error: { message: "boom" } }, "server"],
    ];
    for (const [status, body, code] of cases) {
      const err = await startRun(target(reply(status, body) as unknown as typeof fetch), { input: "x", sessionId: null, idempotencyKey: "i" }).catch((e) => e);
      expect(err).toBeInstanceOf(HermesError);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain("k".repeat(24));
    }
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await startRun(target(down), { input: "x", sessionId: null, idempotencyKey: "i" }).catch((e) => e)).code).toBe("unreachable");
  });

  it("reads a run's events from SSE", async () => {
    const sse = readFileSync(path.join(FIXTURES, "tool.sse"), "utf8");
    const f = (async () => new Response(streamOf(sse, 50), { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
    const events = await all(runEvents(target(f), "run_e188e61075a345f1855a9ad6124d98ef"));
    expect(events.map((e) => e.event)).toEqual(recorded("tool").map((e) => e.event));
  });

  it("only sends the key over https or inside the private network", async () => {
    const dns = (ip: string) => async () => [{ address: ip }];
    expect(await checkHermesUrl("https://hermes.example.com", dns("93.184.216.34"))).toBeNull();
    expect(await checkHermesUrl("http://hermes.lan:8642", dns("192.168.1.20"))).toBeNull();
    expect(await checkHermesUrl("http://100.101.102.103:8642")).toBeNull(); // tailnet (CGNAT)
    expect(await checkHermesUrl("http://hermes:8642", dns("172.18.0.5"))).toBeNull(); // compose
    expect(await checkHermesUrl("http://hermes.example.com", dns("93.184.216.34"))).toMatch(/https/);
    expect(await checkHermesUrl("http://169.254.169.254")).toMatch(/metadata/);
  });

  it("keeps the server root whatever URL is pasted", () => {
    for (const raw of ["http://h:8642", "http://h:8642/", "http://h:8642/v1", "http://h:8642/p/coder", "http://h:8642/p/coder/v1"]) {
      expect(normalizeBaseUrl("hermes", raw)).toEqual({ ok: true, value: "http://h:8642" });
    }
    expect(normalizeBaseUrl("hermes", "http://user:pw@h:8642").ok).toBe(false);
    expect(normalizeBaseUrl("hermes", "").ok).toBe(false);
  });

  it("Hermes tool calls are never 'always allowed'", () => {
    expect(isGrantable("hermes__terminal")).toBe(false);
    expect(isGrantable("web_search")).toBe(true);
  });
});

/**
 * A fake Hermes server for the model: each run replays a scripted event list, pausing after approval.request until
 * the approval is answered. Like Hermes ≤ v2026.9.24, a run's events can only be read once; with `replay`, like newer
 * Hermes, they can be read again, continuing after the Last-Event-ID the reader sends (frames carry ids 1, 2, …).
 */
function fakeHermes(script: Record<string, HermesEvent[]>, opts: { replay?: boolean } = {}) {
  const calls: string[] = [];
  const lastEventIds: (string | undefined)[] = [];
  const runs = new Map<string, { events: HermesEvent[]; answered: Promise<string>; answer: (c: string) => void; read: boolean; stopped: boolean }>();
  let n = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === "POST" && u.pathname.endsWith("/v1/runs")) {
      const input = JSON.parse(String(init.body)).input as string;
      const events = script[input];
      if (!events) return json(400, { error: { message: "unknown script" } });
      const runId = `run_fake${++n}`;
      let answer!: (c: string) => void;
      const answered = new Promise<string>((r) => (answer = r));
      runs.set(runId, { events, answered, answer, read: false, stopped: false });
      return json(202, { run_id: runId });
    }
    const m = /\/v1\/runs\/([^/]+)(?:\/(events|approval|stop))?$/.exec(u.pathname);
    const run = m && runs.get(m[1]);
    if (!m || !run) return json(404, { error: { message: "Run not found" } });
    if (m[2] === "approval") {
      run.answer(JSON.parse(String(init.body)).choice);
      return json(200, { resolved: 1 });
    }
    if (m[2] === "stop") {
      run.stopped = true;
      run.answer("stop");
      return json(200, { status: "stopping" });
    }
    if (m[2] === "events") {
      if (run.read && !opts.replay) return json(404, { error: { message: "Run not found" } });
      run.read = true;
      const after = (init.headers as Record<string, string> | undefined)?.["Last-Event-ID"];
      lastEventIds.push(after);
      const enc = new TextEncoder();
      const frame = (e: HermesEvent, id?: number) => enc.encode(`${opts.replay && id ? `id: ${id}\n` : ""}data: ${JSON.stringify(e)}\n\n`);
      return new Response(
        new ReadableStream({
          async start(c) {
            for (let i = after ? Number(after) : 0; i < run.events.length; i++) {
              const e = run.events[i];
              c.enqueue(frame(e, i + 1));
              if (e.event === "approval.request") {
                const choice = await run.answered;
                if (choice === "stop") {
                  c.enqueue(frame({ event: "run.cancelled" }));
                  break;
                }
                if (choice === "deny") {
                  c.enqueue(frame({ event: "tool.completed", tool: "terminal", error: true, preview: '{"status":"blocked"}' }));
                  c.enqueue(frame({ event: "run.completed", output: "ok, not deleting", usage: {} }));
                  break;
                }
              }
            }
            c.close();
          },
        }),
        { status: 200 },
      );
    }
    return json(200, { run_id: m[1], status: run.stopped ? "cancelled" : "completed", output: "from status" });
  }) as unknown as typeof fetch;
  return { f, calls, lastEventIds };
}

describe("HermesLanguageModel (fake Hermes replaying recorded runs)", () => {
  const APPROVAL = recorded("approval");
  const script = { "hello there": recorded("text"), "rm it": APPROVAL };
  const ctx = (f: typeof fetch, over = {}) => ({
    target: { baseUrl: "http://fake:8642", profile: "coder", apiKey: "k".repeat(20), fetch: f },
    sessionId: "portal-c1-b1",
    sessionKey: "portal-u",
    interactive: true,
    approvalTimeoutSec: 300,
    ...over,
  });
  const run = async (f: typeof fetch, messages: ModelMessage[], over = {}, abortSignal?: AbortSignal) => {
    const r = streamText({ model: new HermesLanguageModel("coder", ctx(f, over)), messages, abortSignal });
    const seen: { type: string; [k: string]: unknown }[] = [];
    for await (const p of r.stream) seen.push(p as never);
    return { seen, messages: (await r.response).messages, text: await r.text };
  };

  it("sends only the newest user message and streams the reply", async () => {
    const { f, calls } = fakeHermes(script);
    const out = await run(f, [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "hello there" },
    ]);
    expect(out.text).toBe('You said: "hello there"');
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
  });

  it("waits for durable upstream identity, stopping the new run if recording fails", async () => {
    const { f, calls } = fakeHermes(script);
    const noteProviderRun = vi.fn(async () => { throw new Error("lease lost"); });
    await run(f, [{ role: "user", content: "hello there" }], {
      run: { id: "portal-run", segment: 0, legacy: false, resumeState: null, saveResumeState() {}, noteProviderRun },
    });
    expect(noteProviderRun).toHaveBeenCalledWith({ hermes: { runId: "run_fake1" } });
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/stop");
    expect(calls).not.toContain("GET /p/coder/v1/runs/run_fake1/events");
  });

  it("records the reported runtime separately from the configured alias, including missing reports", async () => {
    const rows: { model: string }[] = [];
    setUsageWriter(async (row) => { rows.push(row); });
    try {
      for (const reported of ["actual-model", undefined]) {
        const events = [{ event: "run.completed", output: "hi", usage: { input_tokens: 10, output_tokens: 2 }, runtime: { model: reported } }];
        const { f } = fakeHermes({ hello: events });
        const scope = newUsageScope();
        const model = wrapLanguageModel({ model: new HermesLanguageModel("profile-alias", ctx(f)), middleware: usageMiddleware({ model: "profile-alias", providerKind: "hermes", billingSource: "hermes", appId: "a", purpose: "chat", scope }, { skipUnknown: true }) });
        await streamText({ model, prompt: "hello" }).text;
        await Promise.all(scope.pending);
      }
      expect(rows.map((r) => r.model)).toEqual(["actual-model", "unreported"]);
    } finally { setUsageWriter(null); }
  });

  it("pauses on an approval and resumes the same run with the answer", async () => {
    const { f, calls } = fakeHermes(script);
    const ask: ModelMessage[] = [{ role: "user", content: "rm it" }];
    const paused = await run(f, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    expect(request).toBeTruthy();
    const answer: ModelMessage = { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true, providerExecuted: true } as never] };
    const resumed = await run(f, [...ask, ...paused.messages, answer]);
    expect(calls.filter((c) => c === "POST /p/coder/v1/runs").length).toBe(1);
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/approval");
    expect(resumed.seen.find((p) => p.type === "tool-result")).toMatchObject({ providerExecuted: true });
    expect(resumed.text).toContain("approved by the user");
  });

  it("a denied approval posts deny and shows no second result for the call", async () => {
    const { f } = fakeHermes(script);
    const ask: ModelMessage[] = [{ role: "user", content: "rm it" }];
    const paused = await run(f, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    const answer: ModelMessage = { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: false, providerExecuted: true } as never] };
    const resumed = await run(f, [...ask, ...paused.messages, answer]);
    expect(resumed.seen.some((p) => p.type === "tool-output-denied")).toBe(true);
    expect(resumed.seen.some((p) => p.type === "tool-result" || p.type === "tool-error")).toBe(false);
    expect(resumed.text).toBe("ok, not deleting");
  });

  it("turns nobody can answer deny approvals themselves and carry on", async () => {
    const { f, calls } = fakeHermes(script);
    const out = await run(f, [{ role: "user", content: "rm it" }], { interactive: false });
    expect(out.seen.some((p) => p.type === "tool-approval-request")).toBe(false);
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/approval");
    expect(out.text).toBe("ok, not deleting");
  });

  it("a new message stops a run still waiting on an unanswered approval", async () => {
    const { f, calls } = fakeHermes(script);
    await run(f, [{ role: "user", content: "rm it" }]);
    await run(f, [{ role: "user", content: "hello there" }]);
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/stop");
  });

  it("without the parked stream (e.g. after a restart) the answer is still posted and the result comes from the run's status", async () => {
    const { f, calls } = fakeHermes(script);
    const ask: ModelMessage[] = [{ role: "user", content: "rm it" }];
    const paused = await run(f, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    // Drop the parked run, as a restarted web process would.
    const { unpark } = await import("@/lib/llm/providers/hermes/runs");
    unpark(runIdOfApproval(request.approvalId)!)!.tap.close();
    const answer: ModelMessage = { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true, providerExecuted: true } as never] };
    const resumed = await run(f, [...ask, ...paused.messages, answer]);
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/approval");
    expect(calls).toContain("GET /p/coder/v1/runs/run_fake1");
    expect(resumed.text).toBe("from status");
  });

  it("if Hermes can't take the answer, the error shows, the held stream is closed and the run stopped (the turn fails)", async () => {
    const { f, calls } = fakeHermes(script);
    let down = false;
    const flaky = (async (url: string, init?: RequestInit) => {
      if (down && String(url).endsWith("/approval")) throw new TypeError("fetch failed");
      return f(url as never, init);
    }) as unknown as typeof fetch;
    const ask: ModelMessage[] = [{ role: "user", content: "rm it" }];
    const paused = await run(flaky, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    const answer: ModelMessage = { role: "tool", content: [{ type: "tool-approval-response", approvalId: request.approvalId, approved: true, providerExecuted: true } as never] };
    down = true;
    const failed = await run(flaky, [...ask, ...paused.messages, answer]);
    expect(failed.seen.find((p) => p.type === "error")).toMatchObject({ error: expect.objectContaining({ code: "unreachable" }) });
    const { isParked } = await import("@/lib/llm/providers/hermes/runs");
    const runId = runIdOfApproval(request.approvalId)!;
    expect(isParked(runId)).toBe(false);
    // The portal run fails here, so the Hermes run mustn't keep waiting for an answer nobody can give any more.
    await vi.waitFor(() => expect(calls).toContain(`POST /p/coder/v1/runs/${runId}/stop`));
  });

  /** A run whose delegate is still open when a command needs approval (so pairing needs more than the answer). */
  const DELEGATING: HermesEvent[] = [
    { event: "message.delta", delta: "Let me check. " },
    { event: "subagent.start", goal: "look around" },
    { event: "tool.started", tool: "terminal", preview: "rm -rf /tmp/x" },
    { event: "approval.request", request_id: "req1", command: "rm -rf /tmp/x", description: "delete in root path" },
    { event: "tool.completed", tool: "terminal", preview: '{"output":"","exit_code":0}' },
    { event: "subagent.complete", status: "done", summary: "looked around" },
    { event: "message.delta", delta: "All done." },
    { event: "run.completed", output: "Let me check. All done.", usage: {} },
  ];
  const handle = (id: string, resumeState: ResumeState | null = null, segment = 0, legacy = false) => ({
    id,
    segment,
    legacy,
    resumeState,
    saveResumeState: vi.fn(),
    noteProviderRun: vi.fn(),
  });
  const approve = (approvalId: string): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-approval-response", approvalId, approved: true, providerExecuted: true } as never],
  });
  const parkedEntry = (runId: string) => (globalThis as unknown as { __hermesParked: Map<string, ParkedRun> }).__hermesParked.get(runId);

  it("at a pause, the stream is held for the portal run and its resume state is saved; the next segment picks the stream up", async () => {
    closeAllParked();
    const { f, calls, lastEventIds } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
    const first = handle("ar-1");
    const paused = await run(f, ask, { run: first });
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string; toolCall: { toolCallId: string } };
    expect(first.saveResumeState).toHaveBeenCalledTimes(1);
    const saved = first.saveResumeState.mock.calls[0][0] as ResumeState;
    expect(saved).toEqual({
      hermes: {
        runId: "run_fake1",
        lastEventId: "4",
        state: {
          runId: "run_fake1",
          open: [
            { id: "hc_fake1_1", tool: "delegate_task" },
            { id: "hc_fake1_2", tool: "terminal" },
          ],
          denied: [],
          counter: 2,
          approvalTimeoutSec: 300,
        },
        segment: 0,
      },
    });
    expect(request.toolCall.toolCallId).toBe("hc_fake1_2");
    expect(parkedEntry("run_fake1")).toMatchObject({ agentRunId: "ar-1", sessionId: "portal-c1-b1" });

    const resumed = await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-1", saved) });
    expect(isParked("run_fake1")).toBe(false);
    // The held stream continued: no second read of the events, no status polling.
    expect(lastEventIds).toEqual([undefined]);
    expect(calls).not.toContain("GET /p/coder/v1/runs/run_fake1");
    const results = resumed.seen.filter((p) => p.type === "tool-result").map((p) => p.toolCallId);
    expect(results).toEqual(["hc_fake1_2", "hc_fake1_1"]);
    expect(resumed.text).toBe("All done.");
  });

  it("without the held stream (another worker, a restart), the saved resume state re-attaches after the last event read and keeps exact pairing", async () => {
    closeAllParked();
    const { f, calls, lastEventIds } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
    const first = handle("ar-2");
    const paused = await run(f, ask, { run: first });
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    const saved = first.saveResumeState.mock.calls[0][0] as ResumeState;
    expect(closeAllParked()).toBe(1); // as a worker shutting down would

    const resumed = await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-2", saved) });
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/approval");
    expect(lastEventIds).toEqual([undefined, "4"]);
    // Nothing from before the pause is shown again, and the delegate that was open at the pause gets its result.
    expect(resumed.seen.some((p) => p.type === "tool-call")).toBe(false);
    expect(resumed.seen.filter((p) => p.type === "tool-result").map((p) => p.toolCallId)).toEqual(["hc_fake1_2", "hc_fake1_1"]);
    expect(resumed.text).toBe("All done.");
  });

  it("without held stream or resume state, pairing is rebuilt from the prompt (newest answer only, read from the start)", async () => {
    closeAllParked();
    const { f, lastEventIds } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
    const paused = await run(f, ask);
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    closeAllParked();
    const resumed = await run(f, [...ask, ...paused.messages, approve(request.approvalId)]);
    expect(lastEventIds).toEqual([undefined, undefined]);
    // The replayed start shows up again: exactly what the resume state avoids.
    expect(resumed.text).toContain("Let me check.");
  });

  it("records the Hermes run as soon as it starts, so an abnormal end can stop it", async () => {
    closeAllParked();
    const { f } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const h = handle("ar-note");
    await run(f, [{ role: "user", content: "check it" }], { run: h });
    expect(h.noteProviderRun).toHaveBeenCalledWith({ hermes: { runId: "run_fake1" } });
    closeAllParked();
  });

  it("only continues its own Hermes run: another portal run's held stream and a run named only in the prompt are refused", async () => {
    closeAllParked();
    const { f, calls } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
    // A's turn pauses; its stream is held for A's portal run.
    const paused = await run(f, ask, { run: handle("ar-A") });
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    // B (e.g. a copy of A's shared chat) answers A's approval from a run of its own, which saved nothing.
    const stolen = await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-B", null, 1) });
    expect(stolen.seen.find((p) => p.type === "error")).toMatchObject({ error: expect.objectContaining({ code: "not_found" }) });
    expect(calls.some((c) => c.endsWith("/approval"))).toBe(false);
    expect(parkedEntry("run_fake1")).toMatchObject({ agentRunId: "ar-A" });
    closeAllParked();
  });

  it("a stream held at an older pause gives way to the newer saved state (the run paused again on another worker)", async () => {
    closeAllParked();
    const { f, lastEventIds } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
    const first = handle("ar-old", null, 0);
    const paused = await run(f, ask, { run: first });
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    const saved = first.saveResumeState.mock.calls[0][0] as ResumeState;
    expect(saved.hermes?.segment).toBe(0);
    // Pretend another worker continued it and paused at segment 2 (same event cursor, for the fake).
    const later: ResumeState = { hermes: { ...saved.hermes!, segment: 2 } };
    const resumed = await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-old", later, 3) });
    expect(isParked("run_fake1")).toBe(false); // the stale stream was dropped, not used
    expect(lastEventIds).toEqual([undefined, "4"]); // re-attached from the saved state instead
    expect(resumed.text).toBe("All done.");
  });

  it("stopped before the continuation sends anything: no answer is posted and its Hermes run is stopped", async () => {
    closeAllParked();
    const { f, calls } = fakeHermes({ "check it": DELEGATING }, { replay: true });
    const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
    const first = handle("ar-stop");
    const paused = await run(f, ask, { run: first });
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
    const saved = first.saveResumeState.mock.calls[0][0] as ResumeState;
    // The aborted call ends the stream with an abort, which the helper surfaces as a rejection.
    await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-stop", saved, 1) }, AbortSignal.abort()).catch(() => {});
    expect(calls.some((c) => c.endsWith("/approval"))).toBe(false);
    await vi.waitFor(() => expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/stop"));
    expect(isParked("run_fake1")).toBe(false);
  });

  it("when the outcome comes from the run's status (events lost), the approved call is shown as run, not as stopped", async () => {
    closeAllParked();
    // No replay: the second read of the events is refused, as on Hermes <= v2026.9.24, so the status is polled.
    const { f, calls } = fakeHermes(script);
    const ask: ModelMessage[] = [{ role: "user", content: "rm it" }];
    const first = handle("ar-lost");
    const paused = await run(f, ask, { run: first });
    const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string; toolCall: { toolCallId: string } };
    const saved = first.saveResumeState.mock.calls[0][0] as ResumeState;
    closeAllParked();
    const resumed = await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-lost", saved, 1) });
    expect(calls).toContain("GET /p/coder/v1/runs/run_fake1");
    const result = resumed.seen.find((p) => p.type === "tool-result" && p.toolCallId === request.toolCall.toolCallId) as unknown as { output: unknown };
    expect(result).toBeDefined();
    expect(JSON.stringify(resumed.seen.filter((p) => p.type === "tool-result"))).toContain('"status":"ran"');
    expect(resumed.text).toBe("from status");
  });

  it("when the registry is full the stream isn't held, but the resume state is still saved and used", async () => {
    closeAllParked();
    vi.stubEnv("RUN_MAX_HELD", "1");
    try {
      const blocker = new EventTap(async function* () {});
      park({ runId: "run_blocker", sessionId: null, target: ctx(fetch).target, tap: blocker, state: HermesMapper.fresh("run_blocker").state }, 60_000);
      const { f, lastEventIds } = fakeHermes({ "check it": DELEGATING }, { replay: true });
      const ask: ModelMessage[] = [{ role: "user", content: "check it" }];
      const first = handle("ar-3");
      const paused = await run(f, ask, { run: first });
      expect(isParked("run_fake1")).toBe(false);
      const saved = first.saveResumeState.mock.calls[0][0] as ResumeState;
      expect(saved.hermes?.lastEventId).toBe("4");
      const request = paused.seen.find((p) => p.type === "tool-approval-request") as unknown as { approvalId: string };
      const resumed = await run(f, [...ask, ...paused.messages, approve(request.approvalId)], { run: handle("ar-3", saved) });
      expect(lastEventIds).toEqual([undefined, "4"]);
      expect(resumed.text).toBe("All done.");
    } finally {
      closeAllParked();
    }
  });

  it("a delegate or group turn (not interactive) never pauses or saves resume state, even with a run handle", async () => {
    const { f, calls } = fakeHermes(script);
    const h = handle("ar-4");
    const out = await run(f, [{ role: "user", content: "rm it" }], { interactive: false, run: h });
    expect(out.seen.some((p) => p.type === "tool-approval-request")).toBe(false);
    expect(calls).toContain("POST /p/coder/v1/runs/run_fake1/approval");
    expect(h.saveResumeState).not.toHaveBeenCalled();
  });

  it("helpers: newest user text (attachments noted), answers only from the trailing tool message", () => {
    expect(
      lastUserInput([
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "user", content: [{ type: "text", text: "new" }, { type: "file", data: "x", mediaType: "image/png" } as never] },
      ]),
    ).toMatch(/^new\n\n\[1 attachment not passed on/);
    const id = approvalIdFor("run_1a", "r1", "hc_1a_1");
    expect(approvalAnswers([{ role: "tool", content: [{ type: "tool-approval-response", approvalId: id, approved: true }] }])).toHaveLength(1);
    expect(approvalAnswers([{ role: "tool", content: [{ type: "tool-approval-response", approvalId: id, approved: true }] }, { role: "user", content: [{ type: "text", text: "hi" }] }])).toHaveLength(0);
  });
});

describe("parked Hermes runs (the worker's registry)", () => {
  const stops: string[] = [];
  const target = {
    baseUrl: "http://fake:8642",
    profile: "coder",
    apiKey: "k".repeat(20),
    fetch: (async (url: string, init: RequestInit = {}) => {
      stops.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
      return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  const entry = (runId: string, agentRunId?: string) => {
    const tap = new EventTap(async function* () {});
    const close = vi.spyOn(tap, "close");
    return { run: { runId, sessionId: null, target, tap, state: HermesMapper.fresh(runId).state, agentRunId }, close };
  };

  beforeEach(() => {
    closeAllParked();
    stops.length = 0;
  });
  afterEach(() => {
    closeAllParked();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("holds a stream a minute past Hermes' approval limit, at most RUN_HOLD_MAX_MS", () => {
    expect(holdTtlMs(300)).toBe(360_000);
    vi.stubEnv("RUN_HOLD_MAX_MS", "120000");
    expect(holdTtlMs(300)).toBe(120_000);
    expect(holdTtlMs(10)).toBe(70_000);

    vi.useFakeTimers();
    const a = entry("run_ttl");
    expect(park(a.run, holdTtlMs(10))).toBe(true);
    vi.advanceTimersByTime(69_999);
    expect(isParked("run_ttl")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isParked("run_ttl")).toBe(false);
    expect(a.close).toHaveBeenCalled();
  });

  it("holds at most RUN_MAX_HELD streams: over the cap the stream is closed instead", () => {
    vi.stubEnv("RUN_MAX_HELD", "2");
    const [a, b, c] = [entry("run_a"), entry("run_b"), entry("run_c")];
    expect(park(a.run, 60_000)).toBe(true);
    expect(park(b.run, 60_000)).toBe(true);
    expect(park(c.run, 60_000)).toBe(false);
    expect(isParked("run_c")).toBe(false);
    expect(c.close).toHaveBeenCalled();
    // Parking the same run again (a failed answer re-parks) replaces its entry, so it fits.
    expect(park(a.run, 60_000)).toBe(true);
    expect(a.close).not.toHaveBeenCalled();
  });

  it("dropParkedForAgentRun closes the held stream and asks Hermes to stop the run", async () => {
    const a = entry("run_drop", "ar-9");
    park(a.run, 60_000);
    expect(dropParkedForAgentRun("ar-other")).toBe(false);
    expect(dropParkedForAgentRun("ar-9")).toBe(true);
    expect(isParked("run_drop")).toBe(false);
    expect(a.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(stops).toEqual(["POST /p/coder/v1/runs/run_drop/stop"]));
    expect(dropParkedForAgentRun("ar-9")).toBe(false);
  });

  it("closeAllParked (shutdown) closes every held stream without stopping the Hermes runs", async () => {
    const [a, b] = [entry("run_s1", "ar-1"), entry("run_s2", "ar-2")];
    park(a.run, 60_000);
    park(b.run, 60_000);
    expect(closeAllParked()).toBe(2);
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(isParked("run_s1") || isParked("run_s2")).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toEqual([]);
    expect(closeAllParked()).toBe(0);
  });
});
