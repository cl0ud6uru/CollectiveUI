import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  principal: vi.fn(), authSession: vi.fn(), freshPrincipal: vi.fn(), conversation: vi.fn(), target: vi.fn(), activeRun: vi.fn(), getRun: vi.fn(),
  resolveSource: vi.fn(), frames: [] as Array<{ sequence: number; capturedAt: string; contentType: "image/jpeg"; bytes: Uint8Array; width: number; height: number }>,
  providerStatus: vi.fn(), subscriptionSignal: undefined as AbortSignal | undefined, aborted: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: f.authSession }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) } }));
vi.mock("@/lib/session", () => ({
  requirePrincipal: f.principal,
  errorResponse: (err: { status?: number; message?: string }) => Response.json({ error: err.message ?? "Internal error" }, { status: err.status ?? 500 }),
}));
vi.mock("@/lib/auth/groups", async original => ({ ...await original<object>(), loadPrincipal: f.freshPrincipal }));
vi.mock("@/lib/authz", async original => ({ ...await original<object>(), getOwnedConversation: f.conversation }));
vi.mock("@/lib/agent/target", () => ({ resolveTurnTarget: f.target }));
vi.mock("@/lib/runs/state", () => ({ activeRunOf: f.activeRun, getRun: f.getRun }));

import { GET as statusRoute } from "@/app/api/agent-browser/status/route";
import { GET as streamRoute } from "@/app/api/agent-browser/stream/route";
import { registerBrowserSessionSourceResolver } from "@/lib/agent-browser/session-source";
import { AGENT_BROWSER_STALE_FRAME_MS, MAX_AGENT_BROWSER_FRAME_BYTES, type AgentBrowserFrame, type BrowserSessionSource } from "@/lib/agent-browser/contracts";
import { agentBrowserStatus, boundedAgentBrowserFrames, clearAgentBrowserFreshness, reserveAgentBrowserSubscriber, validateAgentBrowserFrame } from "@/lib/agent-browser/viewer";

const principal = { user: { id: "owner-a", sessionVersion: 1 }, groupIds: [], isAdmin: false };
const conversation = { id: "conversation-a", userId: "owner-a", botId: "bot-a", source: "chat", isGroup: false };
const run = { id: "run-a", userId: "owner-a", conversationId: "conversation-a", botId: "bot-a", status: "running" };
let unregister: (() => void) | undefined;
let source: BrowserSessionSource;
const req = (path: "status" | "stream", query = "conversationId=conversation-a") => new Request(`https://portal.test/api/agent-browser/${path}?${query}`);

function frame(sequence = 1): AgentBrowserFrame {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
  return { sequence, capturedAt: new Date().toISOString(), contentType: "image/jpeg", bytes, width: 1, height: 1 };
}

beforeEach(() => {
  unregister?.(); vi.clearAllMocks(); f.frames = []; f.aborted = false; f.subscriptionSignal = undefined;
  f.principal.mockResolvedValue(principal);
  f.authSession.mockResolvedValue({ user: { id: "owner-a", sessionVersion: 1, mustChangePassword: false } });
  f.freshPrincipal.mockResolvedValue(principal);
  f.conversation.mockResolvedValue(conversation);
  f.target.mockResolvedValue({ bot: { id: "bot-a" }, app: { id: "app-a" } });
  f.activeRun.mockResolvedValue(run);
  f.getRun.mockResolvedValue(run);
  f.providerStatus.mockResolvedValue("active");
  source = {
    ownerUserId: "owner-a", botId: "bot-a", runId: "run-a", workspaceInstanceId: null, sessionId: "opaque-secret-session",
    status: f.providerStatus,
    subscribeFrames: async function* (signal: AbortSignal) {
      f.subscriptionSignal = signal;
      try {
        if (f.frames.length) for (const value of f.frames) yield value;
        else if (signal.aborted) f.aborted = true;
        else await new Promise<void>(resolve => signal.addEventListener("abort", () => { f.aborted = true; resolve(); }, { once: true }));
      } finally { if (signal.aborted) f.aborted = true; }
    },
  };
  clearAgentBrowserFreshness({ ownerUserId: source.ownerUserId, botId: source.botId, runId: source.runId, workspaceInstanceId: null }, source.sessionId);
  f.resolveSource.mockImplementation(async (scope: { ownerUserId: string; botId: string; runId: string; workspaceInstanceId: string | null }) =>
    scope.ownerUserId === source.ownerUserId && scope.botId === source.botId && scope.runId === source.runId && scope.workspaceInstanceId === source.workspaceInstanceId ? source : null);
  unregister = registerBrowserSessionSourceResolver(f.resolveSource);
});

afterEach(() => { unregister?.(); unregister = undefined; });

describe("authenticated browser-view status", () => {
  it("returns only the frozen public DTO and never exposes opaque session handles", async () => {
    const response = await statusRoute(req("status"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ state: "active", viewOnly: true, lastFrameAt: null });
    expect(body).not.toContain("opaque-secret-session");
  });

  it("refuses unauthenticated, foreign and malformed selectors before resolving a source", async () => {
    f.principal.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    expect((await statusRoute(req("status"))).status).toBe(401);
    f.conversation.mockRejectedValueOnce(Object.assign(new Error("Conversation not found"), { status: 404 }));
    expect((await statusRoute(req("status"))).status).toBe(404);
    expect((await statusRoute(req("status", "conversationId=conversation-a&runId=run-a"))).status).toBe(400);
    expect(f.resolveSource).not.toHaveBeenCalled();
  });

  it("does not create a browser when the conversation has no run or source", async () => {
    f.activeRun.mockResolvedValue(null);
    const response = await statusRoute(req("status"));
    expect(await response.json()).toEqual({ state: "disconnected", viewOnly: true, lastFrameAt: null });
    expect(f.resolveSource).not.toHaveBeenCalled();
  });

  it("does not resolve a source for a finished run", async () => {
    f.activeRun.mockResolvedValue({ ...run, status: "succeeded" });
    const response = await statusRoute(req("status"));
    expect(await response.json()).toEqual({ state: "disconnected", viewOnly: true, lastFrameAt: null });
    expect(f.resolveSource).not.toHaveBeenCalled();
  });

  it("fails closed if the provider tries to resolve a source for another owner", async () => {
    f.resolveSource.mockResolvedValueOnce({ ...source, ownerUserId: "owner-b" });
    expect(await (await statusRoute(req("status"))).json()).toEqual({ state: "disconnected", viewOnly: true, lastFrameAt: null });
  });

  it("rejects a revoked signed-in session before returning browser state", async () => {
    f.freshPrincipal.mockResolvedValueOnce({ ...principal, user: { ...principal.user, sessionVersion: 2 } });
    expect((await statusRoute(req("status"))).status).toBe(401);
  });
});

describe("view-only frame stream", () => {
  it("streams bounded JPEG frames from the authorized source without scope or credentials", async () => {
    f.frames = [frame()];
    const response = await streamRoute(req("stream"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("private, no-store");
    const body = await response.text();
    expect(body).toContain("event: frame");
    expect(body).toContain('"contentType":"image/jpeg"');
    expect(body).toContain(`"data":"${Buffer.from(frame().bytes).toString("base64")}"`);
    expect(body).not.toContain("opaque-secret-session");
    expect(body).not.toContain("owner-a");
  });

  it("closes the viewer subscription on cancel without stopping the agent run", async () => {
    const response = await streamRoute(req("stream"));
    await response.body!.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.subscriptionSignal?.aborted).toBe(true);
    expect(f.aborted).toBe(true);
  });

  it("rejects a disconnected provider without opening a frame stream", async () => {
    f.providerStatus.mockResolvedValue("disconnected");
    const response = await streamRoute(req("stream"));
    expect(response.status).toBe(409);
    expect(f.subscriptionSignal).toBeUndefined();
  });

  it("rechecks the owner's current session version before frame delivery", async () => {
    f.frames = [frame()];
    f.freshPrincipal.mockResolvedValue({ ...principal, user: { ...principal.user, sessionVersion: 7 } });
    expect((await streamRoute(req("stream"))).status).toBe(401);
    expect(f.subscriptionSignal).toBeUndefined();
  });

  it("re-reads Auth.js session policy on a long-lived stream authorization check", async () => {
    f.frames = [frame()];
    f.authSession.mockResolvedValueOnce({ user: { id: "owner-a", sessionVersion: 1, mustChangePassword: false } })
      .mockResolvedValueOnce({ user: { id: "owner-a", sessionVersion: 1, mustChangePassword: true } });
    const response = await streamRoute(req("stream"));
    expect(response.status).toBe(200);
    await expect(response.body!.getReader().read()).rejects.toThrow();
    expect(f.subscriptionSignal).toBeUndefined();
  });

  it("discards queued frames when an open stream loses authorization", async () => {
    source = { ...source, subscribeFrames: async function* (signal: AbortSignal) {
      f.subscriptionSignal = signal;
      yield frame();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } };
    f.resolveSource.mockImplementation(async () => source);
    const response = await streamRoute(req("stream"));
    await new Promise(resolve => setTimeout(resolve, 30));
    f.authSession.mockRejectedValue(new Error("session expired"));
    await new Promise(resolve => setTimeout(resolve, 3_100));
    expect(f.subscriptionSignal?.aborted).toBe(true);
    await expect(response.body!.getReader().read()).rejects.toThrow();
  });
});

describe("frame and subscriber bounds", () => {
  it("accepts only recent, correctly typed bounded JPEG frames", () => {
    expect(validateAgentBrowserFrame(frame())).toBe(true);
    expect(validateAgentBrowserFrame({ ...frame(), contentType: "image/png" as never })).toBe(false);
    expect(validateAgentBrowserFrame({ ...frame(), width: 2 })).toBe(false);
    const oversized = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x39, 0x07, 0x81, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    expect(validateAgentBrowserFrame({ ...frame(), width: 1, height: 1, bytes: oversized })).toBe(false);
    expect(validateAgentBrowserFrame({ ...frame(), bytes: new Uint8Array(MAX_AGENT_BROWSER_FRAME_BYTES + 1) })).toBe(false);
    expect(validateAgentBrowserFrame({ ...frame(), capturedAt: new Date(Date.now() - AGENT_BROWSER_STALE_FRAME_MS - 1).toISOString() })).toBe(false);
  });

  it("caps concurrent viewer subscriptions per owner and releases their slots", () => {
    const first = reserveAgentBrowserSubscriber("owner-cap");
    const second = reserveAgentBrowserSubscriber("owner-cap");
    expect(() => reserveAgentBrowserSubscriber("owner-cap")).toThrow(/Too many browser views/);
    first(); first(); second();
    expect(() => reserveAgentBrowserSubscriber("owner-cap")).not.toThrow();
  });

  it("does not forward duplicate or over-rate frames", async () => {
    const values = [frame(1), frame(1), frame(2), frame(3)];
    const candidate: BrowserSessionSource = { ...source, subscribeFrames: async function* () { yield* values; } };
    const yielded: number[] = [];
    for await (const value of boundedAgentBrowserFrames(candidate, new AbortController().signal)) yielded.push(value.sequence);
    expect(yielded).toEqual([1]);
    expect(await agentBrowserStatus(candidate, new AbortController().signal)).toMatchObject({ state: "active", viewOnly: true, lastFrameAt: expect.any(String) });
  });

  it("marks a connected provider disconnected when its most recent capture is stale", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-12T00:00:00.000Z"); vi.setSystemTime(start);
      const candidate: BrowserSessionSource = { ...source, subscribeFrames: async function* () { yield { ...frame(), capturedAt: start.toISOString() }; } };
      for await (const value of boundedAgentBrowserFrames(candidate, new AbortController().signal)) expect(value.sequence).toBe(1);
      vi.setSystemTime(new Date(start.getTime() + AGENT_BROWSER_STALE_FRAME_MS + 1));
      expect(await agentBrowserStatus(candidate, new AbortController().signal)).toEqual({ state: "disconnected", viewOnly: true, lastFrameAt: start.toISOString() });
    } finally { vi.useRealTimers(); }
  });
});
