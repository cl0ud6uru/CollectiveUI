import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiApp } from "@/db/schema";

const deps = vi.hoisted(() => ({
  providerContextFor: vi.fn(),
  requirePrincipal: vi.fn(),
  resolveTurnTarget: vi.fn(),
  getOwnedConversation: vi.fn(),
}));
vi.mock("@/lib/llm/resolve", () => ({ providerContextFor: deps.providerContextFor }));
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

const app = {
  id: "app-1", name: "OpenAI", provider: "openai", credentialMode: "org", model: "gpt-4.1",
  systemPrompt: "Be helpful", providerConfig: {}, baseUrl: null,
} as AiApp;
const principal = { user: { id: "user-1" } } as never;
const providerContext = {
  appId: app.id, appName: app.name, kind: "openai", baseUrl: null,
  config: { organization: "org-1", project: "proj-1" },
  secret: { type: "api-key", apiKey: "secret-api-key" },
};
const target = { app, bot: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_URL", "https://portal.example");
  deps.requirePrincipal.mockResolvedValue(principal);
  deps.resolveTurnTarget.mockResolvedValue(target);
  deps.providerContextFor.mockResolvedValue(providerContext);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("voice session API", () => {
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
  });

  it("denies session creation before reading targets when authentication fails", async () => {
    deps.requirePrincipal.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", body: JSON.stringify({ appId: app.id, sdp: "offer" }),
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
      method: "POST", body: JSON.stringify({ conversationId: "owned", appId: "other", sdp: "offer" }),
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
      body: JSON.stringify({ appId: app.id, sdp: "offer" }),
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
      body: JSON.stringify({ appId: app.id, sdp: "offer" }),
    }));
    expect(crossOrigin.status).toBe(403);

    const internalOrigin = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ appId: app.id, sdp: "offer" }),
    }));
    expect(internalOrigin.status).toBe(403);

    for (const origin of ["null", "not a URL"]) {
      const malformed = await POST(new Request("http://localhost/api/voice/session", {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ appId: app.id, sdp: "offer" }),
      }));
      expect(malformed.status).toBe(403);
    }
  });

  it("preserves local same-origin requests when AUTH_URL is unconfigured", async () => {
    vi.stubEnv("AUTH_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ appId: app.id, sdp: "offer" }),
    }));
    expect(response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("bounds incoming JSON", async () => {
    vi.stubEnv("AUTH_URL", "");
    const oversized = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ appId: app.id, sdp: "x".repeat(65_000) }),
    }));
    expect(oversized.status).toBe(413);
  });

  it("creates an official Live session with stored credentials and tool-free delegation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "https://portal.example", "content-type": "application/json" },
      body: JSON.stringify({ appId: app.id, sdp: "offer-sdp" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: { id: "vs_1" }, transport: { type: "webrtc", sdp: "answer-sdp" } });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-api-key");
    expect(new Headers(init?.headers).get("OpenAI-Organization")).toBe("org-1");
    expect(new Headers(init?.headers).get("OpenAI-Project")).toBe("proj-1");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.session).toMatchObject({ model: "gpt-live-1", delegation: { type: "responses", responses: { model: app.model, tools: [], tool_choice: "none" } } });
    expect(JSON.stringify(body)).not.toContain("secret-api-key");
    fetchSpy.mockRestore();
  });

  it("rejects vendor endpoints and maps upstream failures without exposing their body", async () => {
    deps.providerContextFor.mockResolvedValueOnce({ ...providerContext, baseUrl: "https://proxy.example/v1" });
    expect(await voiceEligibility(target)).toMatchObject({ supported: false });
    const failure = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("sensitive provider detail", { status: 429 }));
    const response = await POST(new Request("http://localhost/api/voice/session", {
      method: "POST", headers: { origin: "https://portal.example", "content-type": "application/json" }, body: JSON.stringify({ appId: app.id, sdp: "offer-sdp" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive provider detail");
    failure.mockRestore();
  });
});
