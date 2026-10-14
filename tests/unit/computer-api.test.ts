import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/authz";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), loadPrincipal: vi.fn(), activeWebSession: vi.fn(), registryEnabled: vi.fn(),
  getOwnedConversation: vi.fn(), resolveTurnTarget: vi.fn(), codexPolicy: vi.fn(), callerRuntime: vi.fn(),
  personalAccount: vi.fn(), runtimeBinding: vi.fn(), requirePrincipal: vi.fn(), computerInput: vi.fn(), computerControl: vi.fn(),
  computerStatus: vi.fn(), computerFrame: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: mocks.loadPrincipal }));
vi.mock("@/lib/auth/web-sessions", () => ({ activeWebSession: mocks.activeWebSession, webSessionRegistryEnabled: mocks.registryEnabled }));
vi.mock("@/lib/authz", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/authz")>();
  return { ...original, getOwnedConversation: mocks.getOwnedConversation };
});
vi.mock("@/lib/agent/target", () => ({ resolveTurnTarget: mocks.resolveTurnTarget }));
vi.mock("@/lib/codex/store", () => ({ codexPolicy: mocks.codexPolicy }));
vi.mock("@/lib/codex/runtime", () => ({ callerRuntime: mocks.callerRuntime, assertRuntimeOwner: vi.fn(), runtimeBinding: mocks.runtimeBinding }));
vi.mock("@/personal-codex/accounts", () => ({ personalAccount: mocks.personalAccount }));
vi.mock("@/lib/session", () => ({ requirePrincipal: mocks.requirePrincipal, errorResponse: (err: unknown) => Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: err instanceof HttpError ? err.status : 500 }) }));
vi.mock("@/lib/computer/client", () => ({ computerInput: mocks.computerInput, computerControl: mocks.computerControl, computerStatus: mocks.computerStatus, computerFrame: mocks.computerFrame }));

const principal = { user: { id: "owner-a", sessionVersion: 4, upn: "owner@example.test", email: "owner@example.test" } } as never;
const session = { user: { id: "owner-a", sessionId: "session-a", sessionVersion: 4 } };
const conversation = { id: "chat-a", source: "chat", isGroup: false, botId: "bot-a", appId: null };
const runtime = { ownerId: "owner-a", managed: true, socketPath: "/run/personal.sock", credentialBinding: "binding-a" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.COMPUTER_VIEW_ENABLED = "1";
  process.env.AUTH_WEB_SESSION_REGISTRY_ENABLED = "1";
  process.env.AUTH_URL = "https://collective.example.test";
  mocks.registryEnabled.mockReturnValue(true);
  mocks.auth.mockResolvedValue(session);
  mocks.loadPrincipal.mockResolvedValue(principal);
  mocks.activeWebSession.mockResolvedValue(true);
  mocks.getOwnedConversation.mockResolvedValue(conversation);
  mocks.resolveTurnTarget.mockResolvedValue({ bot: { id: "bot-a", executionMode: "caller", hermesTeam: false }, app: { id: "codex-app", providerConfig: { codexHarness: true } } });
  mocks.codexPolicy.mockResolvedValue({ funding: "chatgpt_subscription" });
  mocks.callerRuntime.mockResolvedValue(runtime);
  mocks.personalAccount.mockResolvedValue({ credentialBinding: "binding-a" });
  mocks.runtimeBinding.mockReturnValue("runtime-binding");
  mocks.requirePrincipal.mockResolvedValue(principal);
});

describe("authenticated computer view access", () => {
  it("rejects a foreign conversation and never accepts a caller supplied owner", async () => {
    const { computerViewForConversation } = await import("@/lib/computer/access");
    mocks.getOwnedConversation.mockRejectedValue(new HttpError(404, "Conversation not found."));
    await expect(computerViewForConversation(principal, "foreign-chat")).rejects.toMatchObject({ status: 404 });
    expect(mocks.getOwnedConversation).toHaveBeenCalledWith(principal, "foreign-chat");
  });

  it("rejects logged out, revoked, and expired web sessions", async () => {
    const { computerViewForConversation } = await import("@/lib/computer/access");
    mocks.activeWebSession.mockResolvedValue(false);
    await expect(computerViewForConversation(principal, "chat-a")).rejects.toMatchObject({ status: 401 });
    mocks.activeWebSession.mockResolvedValue(true);
    mocks.auth.mockResolvedValue({ user: { ...session.user, sessionVersion: 3 } });
    await expect(computerViewForConversation(principal, "chat-a")).rejects.toMatchObject({ status: 401 });
  });

  it("requires the connected account binding and managed owner runtime", async () => {
    const { computerViewForConversation } = await import("@/lib/computer/access");
    mocks.personalAccount.mockResolvedValue({ credentialBinding: "changed-binding" });
    await expect(computerViewForConversation(principal, "chat-a")).rejects.toMatchObject({ status: 503 });
    mocks.personalAccount.mockResolvedValue({ credentialBinding: "binding-a" });
    mocks.callerRuntime.mockResolvedValue({ ...runtime, managed: false });
    await expect(computerViewForConversation(principal, "chat-a")).rejects.toMatchObject({ status: 503 });
  });

  it("revokes a view if its account binding changes after admission", async () => {
    const { computerViewForConversation } = await import("@/lib/computer/access");
    const view = await computerViewForConversation(principal, "chat-a");
    mocks.personalAccount.mockResolvedValue({ credentialBinding: "binding-b" });
    await expect(view.authorize()).rejects.toMatchObject({ status: 404 });
  });
});

describe("computer mutation routes", () => {
  it("rejects missing origin and owner-spoof/unknown body fields", async () => {
    const { POST } = await import("@/app/api/computer/input/route");
    const missingOrigin = await POST(new Request("https://collective.example.test/api/computer/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "chat-a", input: { kind: "key", key: "Enter" } }) }));
    expect(missingOrigin.status).toBe(403);
    const spoof = await POST(new Request("https://collective.example.test/api/computer/input", { method: "POST", headers: { origin: "https://collective.example.test", "content-type": "application/json" }, body: JSON.stringify({ conversationId: "chat-a", ownerId: "owner-b", input: { kind: "key", key: "Enter" } }) }));
    expect(spoof.status).toBe(400);
    expect(mocks.computerInput).not.toHaveBeenCalled();
  });

  it("returns the broker lease conflict without forwarding unleased input", async () => {
    const { POST } = await import("@/app/api/computer/input/route");
    mocks.computerInput.mockRejectedValue(new HttpError(409, "Take control before sending input."));
    const response = await POST(new Request("https://collective.example.test/api/computer/input", { method: "POST", headers: { origin: "https://collective.example.test", "content-type": "application/json" }, body: JSON.stringify({ conversationId: "chat-a", input: { kind: "type", text: "hello" } }) }));
    expect(response.status).toBe(409);
    expect(mocks.computerInput).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid and oversized control payloads before resolving the viewer", async () => {
    const { POST } = await import("@/app/api/computer/control/route");
    const invalid = await POST(new Request("https://collective.example.test/api/computer/control", { method: "POST", headers: { origin: "https://collective.example.test", "content-type": "application/json" }, body: JSON.stringify({ conversationId: "chat-a", action: "start" }) }));
    expect(invalid.status).toBe(400);
    const tooLarge = await POST(new Request("https://collective.example.test/api/computer/control", { method: "POST", headers: { origin: "https://collective.example.test", "content-type": "application/json" }, body: `{"conversationId":"chat-a","action":"takeover","extra":"${"x".repeat(1500)}"}` }));
    expect(tooLarge.status).toBe(413);
    expect(mocks.computerControl).not.toHaveBeenCalled();
  });
});

describe("computer stream revocation", () => {
  it("withholds a direct frame if the session is revoked during capture", async () => {
    vi.resetModules();
    const view = { authorize: vi.fn().mockRejectedValue(new HttpError(401, "Unauthorized")) };
    vi.doMock("@/lib/computer/access", () => ({ computerViewForConversation: vi.fn(async () => view) }));
    vi.doMock("@/lib/computer/viewer", () => ({ computerFrameForView: vi.fn(async () => ({
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), capturedAt: new Date().toISOString(), sequence: 1,
    })) }));
    const { GET } = await import("@/app/api/computer/frame/route");
    const response = await GET(new Request("https://collective.example.test/api/computer/frame?conversationId=chat-a"));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    vi.doUnmock("@/lib/computer/access");
    vi.doUnmock("@/lib/computer/viewer");
    vi.resetModules();
  });
  it("clears the stream if authorization changes while a frame is in flight", async () => {
    vi.resetModules();
    const view = { ownerUserId: "owner-a", conversationId: "chat-a", sessionId: "session-a", authorize: vi.fn()
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new HttpError(401, "Unauthorized")) };
    const frame = { sequence: 1, capturedAt: new Date().toISOString(), contentType: "image/jpeg", width: 1280, height: 800, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };
    vi.doMock("@/lib/computer/access", () => ({ computerViewForConversation: vi.fn(async () => view) }));
    vi.doMock("@/lib/computer/viewer", () => ({
      reserveComputerSubscriber: vi.fn(() => vi.fn()), MAX_COMPUTER_STREAM_MS: 30_000,
      computerStatusForView: vi.fn(async () => ({ available: true, state: "running", control: "agent", paused: false, lastFrameAt: null, width: 1280, height: 800 })),
      computerFrameForView: vi.fn(async () => frame),
    }));
    const { GET } = await import("@/app/api/computer/stream/route");
    const response = await GET(new Request("https://collective.example.test/api/computer/stream?conversationId=chat-a"));
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toContain("event: status");
    await expect(reader.read()).rejects.toThrow();
    expect(view.authorize).toHaveBeenCalledTimes(2);
    vi.doUnmock("@/lib/computer/access");
    vi.doUnmock("@/lib/computer/viewer");
    vi.resetModules();
  });
});

describe("computer broker errors", () => {
  it("does not return provider error text that could contain typed input", async () => {
    vi.resetModules();
    vi.doMock("@/lib/local-hermes/client", () => ({ LOCAL_ORIGIN: "http://local-hermes.invalid", socketFetch: vi.fn(() => vi.fn(async () => new Response(JSON.stringify({ error: "typed private phrase was rejected" }), { status: 409 }))) }));
    vi.doMock("@/personal-codex/control", () => ({ personalSocket: () => "/run/personal.sock" }));
    const { computerInput } = await import("@/lib/computer/client");
    const view = { ownerUserId: "owner-a", conversationId: "chat-a", sessionId: "session-a", socketPath: "/run/personal.sock" };
    await expect(computerInput(view as never, { kind: "type", text: "typed private phrase" })).rejects.toMatchObject({
      status: 409, message: "Take control before sending input.",
    });
    vi.doUnmock("@/lib/local-hermes/client");
    vi.doUnmock("@/personal-codex/control");
    vi.resetModules();
  });
});

describe("computer frame freshness and bounds", () => {
  it("rejects stale frames and frames above 512 KiB", async () => {
    const { computerFrameForView } = await import("@/lib/computer/viewer");
    const view = { ownerUserId: "owner-a", conversationId: "chat-a", sessionId: "session-a", authorize: vi.fn() };
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    mocks.computerFrame.mockResolvedValue(new Response(jpeg, { headers: { "content-type": "image/jpeg", "x-computer-captured-at": new Date(Date.now() - 20_000).toISOString(), "x-computer-sequence": "1" } }));
    await expect(computerFrameForView(view as never)).rejects.toMatchObject({ status: 409 });
    mocks.computerFrame.mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1), { headers: { "content-type": "image/jpeg", "content-length": String(512 * 1024 + 1) } }));
    await expect(computerFrameForView(view as never)).rejects.toMatchObject({ status: 413 });
  });
});
