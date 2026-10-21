import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApp, UsageEvent } from "@/db/schema";

const deps = vi.hoisted(() => ({
  providerContextFor: vi.fn(),
  requirePrincipal: vi.fn(),
  resolveTurnTarget: vi.fn(),
  getOwnedConversation: vi.fn(),
  prepareVoiceConversation: vi.fn(),
  configureVoiceTarget: vi.fn(),
}));
vi.mock("@/lib/llm/resolve", () => ({ providerContextFor: deps.providerContextFor }));
vi.mock("@/lib/voice/configuration", () => ({ configureVoiceTarget: deps.configureVoiceTarget }));
vi.mock("@/lib/voice/conversation", () => ({ prepareVoiceConversation: deps.prepareVoiceConversation }));
vi.mock("@/lib/settings", () => ({ getSetting: vi.fn(async () => ({ avatarUrl: null, reactions: true })) }));
vi.mock("@/lib/auth/throttle", () => ({ allowVoiceRequest: vi.fn(async () => true) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({ requirePrincipal: deps.requirePrincipal, errorResponse: (err: unknown) => {
  const status = typeof err === "object" && err && "status" in err ? Number(err.status) : 500;
  const message = err instanceof Error ? err.message : "Internal error";
  return Response.json({ error: message }, { status });
} }));
vi.mock("@/lib/agent/target", () => ({ resolveTurnTarget: deps.resolveTurnTarget }));
vi.mock("@/lib/authz", () => ({ HttpError: class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }, getOwnedConversation: deps.getOwnedConversation }));

import { GET, POST } from "@/app/api/voice/session/route";
import { voiceEligibility } from "@/lib/voice/session";
import { setUsageWriter } from "@/lib/llm/usage";

const ledger: UsageEvent[] = [];

const app = {
  id: "app-1", name: "OpenAI", provider: "openai", credentialMode: "org", model: "gpt-4.1",
  systemPrompt: "Be helpful", providerConfig: {}, baseUrl: null,
} as AiApp;
const principal = { user: { id: "user-1" } } as never;
const providerContext = {
  appId: app.id, appName: app.name, kind: "openai", baseUrl: null,
  config: { organization: "org-1", project: "proj-1" },
  secret: { type: "api-key", apiKey: "secret-api-key" },
  usageAttribution: { providerConnectionId: "openai-transport", providerOrganization: "org-1", providerProject: "proj-1", billingRoute: "api:openai" },
};
const target = { app, bot: null };

beforeEach(() => {
  vi.clearAllMocks();
  ledger.length = 0;
  setUsageWriter(async row => { ledger.push(row); });
  vi.stubEnv("AUTH_URL", "https://portal.example");
  deps.requirePrincipal.mockResolvedValue(principal);
  deps.configureVoiceTarget.mockImplementation(async (_p, target) => target);
  deps.prepareVoiceConversation.mockResolvedValue({ context: "saved history", history: [{ id: "prior-u", role: "user", text: "Find notes" }, { id: "prior-a", role: "assistant", text: "Old answer" }] });
  deps.resolveTurnTarget.mockResolvedValue(target);
  deps.providerContextFor.mockResolvedValue(providerContext);
});

afterEach(() => {
  setUsageWriter(null);
  vi.unstubAllEnvs();
});

describe("voice session API", () => {
  it("creates listening-only reaction tests without loading or saving chat history", async () => {
    deps.getOwnedConversation.mockResolvedValueOnce({ source: "chat", isGroup: false, appId: app.id, botId: null });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "test_voice" }, transport: { type: "webrtc", sdp: "answer" } }));
    const response = await POST(new Request("https://portal.example/api/voice/session", { method: "POST", headers: { origin: "https://portal.example" }, body: JSON.stringify({ conversationId: "chat00000001", chatId: "chat00000001", sdp: "offer", reactionTest: true }) }));
    expect(response.status).toBe(200);
    expect(deps.prepareVoiceConversation).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ context: "", history: [] });
    const upstream = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(upstream.session.input).toEqual([]);
    expect(upstream.session.instructions).toContain("listening-only avatar reaction test");
    expect(upstream.session.instructions).toContain("No tools or external actions");
    expect(upstream.session.instructions).not.toContain("saved chat");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ purpose: "voice", completionStatus: "started", userId: "user-1", conversationId: "chat00000001", inputTokens: null, outputTokens: null });
    fetchSpy.mockRestore();
  });

  it("creates distinct listening-first sessions with empty input for new conversations", async () => {
    deps.prepareVoiceConversation.mockResolvedValue({ context: "", history: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ session: { id: "vs_first" }, transport: { type: "webrtc", sdp: "answer-1" } }))
      .mockResolvedValueOnce(Response.json({ session: { id: "vs_second" }, transport: { type: "webrtc", sdp: "answer-2" } }));
    for (const chatId of ["newchat00001", "newchat00002"]) {
      const response = await POST(new Request("http://localhost/api/voice/session", { method: "POST",
        body: JSON.stringify({ chatId, appId: app.id, sdp: "offer" }) }));
      expect(response.status).toBe(200);
      expect((await response.json()).history).toEqual([]);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(ledger).toHaveLength(2);
    expect(ledger.map(row => row.conversationId)).toEqual(["newchat00001", "newchat00002"]);
    for (const [, init] of fetchSpy.mock.calls) {
      const session = JSON.parse(String(init?.body)).session;
      expect(session.input).toEqual([]);
      expect(session.instructions).toContain("Wait for the caller's new speech");
    }
    fetchSpy.mockRestore();
  });
  it("uses an independently authorized OpenAI transport for a Hermes bot", async () => {
    const hermes = { app: { ...app, id: "hermes-backend", provider: "hermes" }, bot: { id: "bot0000001", name: "Hermes", instructions: "Use my tools" } };
    deps.resolveTurnTarget.mockResolvedValueOnce(hermes);
    deps.configureVoiceTarget.mockResolvedValueOnce({ ...hermes, voiceApp: app });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", { method: "POST", body: JSON.stringify({ chatId: "chat00000001", botId: "bot0000001", sdp: "offer" }) }));
    expect(response.status).toBe(200);
    expect(deps.configureVoiceTarget).toHaveBeenCalledWith(principal, hermes);
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.instructions).toContain("Hermes");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ appId: app.id, botId: "bot0000001", providerKind: "openai", model: "gpt-live-1", billingSource: "org", providerConnectionId: "openai-transport", providerOrganization: "org-1", providerProject: "proj-1", billingRoute: "api:openai" });
    fetchSpy.mockRestore();
  });
  it("requires an authenticated principal", async () => {
    deps.requirePrincipal.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const response = await GET(new Request("http://localhost/api/voice/session?appId=app-1"));
    expect(response.status).toBe(401);
  });

  it("reports unsupported provider targets", async () => {
    deps.resolveTurnTarget.mockResolvedValueOnce({ app: { ...app, provider: "openai-compatible" }, bot: null });
    const response = await GET(new Request("http://localhost/api/voice/session?appId=app-1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ supported: false });
    expect(deps.providerContextFor).not.toHaveBeenCalled();
    expect(ledger).toHaveLength(0);
  });

  it("denies session creation before reading targets when authentication fails", async () => {
    deps.requirePrincipal.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }),
    }));
    expect(response.status).toBe(401);
    expect(deps.resolveTurnTarget).not.toHaveBeenCalled();
    expect(deps.providerContextFor).not.toHaveBeenCalled();
  });

  it("checks conversation ownership and refuses mismatched targets", async () => {
    deps.getOwnedConversation.mockRejectedValueOnce(Object.assign(new Error("Conversation not found"), { status: 404 }));
    const missing = await GET(new Request("http://localhost/api/voice/session?conversationId=private"));
    expect(missing.status).toBe(404);
    expect(deps.getOwnedConversation).toHaveBeenCalledWith(principal, "private");
    deps.getOwnedConversation.mockResolvedValueOnce({ source: "chat", isGroup: false, appId: app.id, botId: null });
    const mismatch = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", body: JSON.stringify({ chatId: "chat00000001", conversationId: "owned", appId: "other", sdp: "offer" }),
    }));
    expect(mismatch.status).toBe(400);
    expect(deps.resolveTurnTarget).not.toHaveBeenCalled();
  });

  it("refuses personal-plan credentials and Live-only backend models", async () => {
    expect(await voiceEligibility({ app: { ...app, credentialMode: "user" } as AiApp, bot: null })).toMatchObject({ supported: false });
    expect(await voiceEligibility({ app: { ...app, model: "gpt-live-1" }, bot: null })).toMatchObject({ supported: false });
    expect(deps.providerContextFor).not.toHaveBeenCalled();
  });

  it("refuses group and delegated conversations before resolving a target", async () => {
    deps.getOwnedConversation.mockResolvedValueOnce({ source: "chat", isGroup: true, appId: null, botId: null });
    const group = await GET(new Request("http://localhost/api/voice/session?conversationId=conv-1"));
    expect(group.status).toBe(400);
    deps.getOwnedConversation.mockResolvedValueOnce({ source: "delegation", isGroup: false, appId: app.id, botId: null });
    const delegated = await GET(new Request("http://localhost/api/voice/session?conversationId=conv-2"));
    expect(delegated.status).toBe(403);
    expect(deps.resolveTurnTarget).not.toHaveBeenCalled();
  });

  it("uses the configured public origin behind a reverse proxy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "https://portal.example", "content-type": "application/json" },
      body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }),
    }));
    expect(response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("denies foreign origins even when forwarded headers claim the configured host", async () => {
    const crossOrigin = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: {
        origin: "https://elsewhere.example", "x-forwarded-host": "portal.example", "x-forwarded-proto": "https",
        "content-type": "application/json",
      },
      body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }),
    }));
    expect(crossOrigin.status).toBe(403);

    const internalOrigin = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }),
    }));
    expect(internalOrigin.status).toBe(403);

    for (const origin of ["null", "not a URL"]) {
      const malformed = await POST(new Request("http://localhost/api/voice/session", {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }),
      }));
      expect(malformed.status).toBe(403);
    }
  });

  it("preserves local same-origin requests when AUTH_URL is unconfigured", async () => {
    vi.stubEnv("AUTH_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }),
    }));
    expect(response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("bounds incoming JSON", async () => {
    vi.stubEnv("AUTH_URL", "");
    const oversized = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "x".repeat(65_000) }),
    }));
    expect(oversized.status).toBe(413);
  });

  it("creates an official Live session with stored credentials and client delegation to the bot", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "https://portal.example", "content-type": "application/json" },
      body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer-sdp" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" }, context: "saved history", reactions: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-api-key");
    expect(new Headers(init?.headers).get("OpenAI-Organization")).toBe("org-1");
    expect(new Headers(init?.headers).get("OpenAI-Project")).toBe("proj-1");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.session).toMatchObject({ model: "gpt-live-1", delegation: { type: "client" }, input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Find notes" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Old answer" }] },
    ] });
    expect(body.session.instructions).toContain("Start each new voice connection by listening");
    expect(body.session.instructions).toContain("## Backchannel policy");
    expect(body.session.instructions).toContain("## Delegation policy");
    expect(body.session.instructions).not.toContain(app.systemPrompt);
    expect(JSON.stringify(body)).not.toContain("secret-api-key");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ purpose: "voice", completionStatus: "started", providerKind: "openai", model: "gpt-live-1", appId: app.id, userId: "user-1", conversationId: "chat00000001", inputTokens: null, outputTokens: null, cacheReadTokens: null, reasoningTokens: null });
    expect(JSON.stringify(ledger)).not.toContain("secret-api-key");
    fetchSpy.mockRestore();
  });

  it("rejects vendor endpoints and maps upstream failures without exposing their body", async () => {
    deps.providerContextFor.mockResolvedValueOnce({ ...providerContext, baseUrl: "https://proxy.example/v1" });
    expect(await voiceEligibility(target)).toMatchObject({ supported: false });
    const failure = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("sensitive provider detail", { status: 429 }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "https://portal.example", "content-type": "application/json" }, body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer-sdp" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive provider detail");
    expect(ledger).toHaveLength(0);
    failure.mockRestore();
  });

  it("counts an acknowledged session even if its transport answer is invalid, without inventing tokens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "started-with-bad-answer" }, transport: { type: "webrtc", sdp: "" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", { method: "POST", body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }) }));
    expect(response.status).toBe(502);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ purpose: "voice", completionStatus: "started", inputTokens: null, outputTokens: null });
    fetchSpy.mockRestore();
  });

  it("does not claim a session start without an upstream acknowledgement", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const response = await POST(new Request("http://localhost/api/voice/session", { method: "POST", body: JSON.stringify({ chatId: "chat00000001", appId: app.id, sdp: "offer" }) }));
    expect(response.status).toBe(502);
    expect(ledger).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});
