import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ headers: new Headers(), cookie: vi.fn(), mobile: vi.fn(), principal: vi.fn(), commit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => f.headers }));
vi.mock("@/auth", () => ({ auth: f.cookie }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: f.principal }));
vi.mock("@/lib/auth/mobile", async (original) => ({ ...await original<typeof import("@/lib/auth/mobile")>(), mobilePrincipal: f.mobile }));
vi.mock("@/lib/voice/turn", () => ({ commitVoiceBatch: f.commit }));
vi.mock("@/lib/voice/target", () => ({ targetFor: vi.fn() }));
vi.mock("@/lib/chat/store", () => ({ partsToText: vi.fn() }));
vi.mock("@/lib/runs/state", () => ({ runOfMessage: vi.fn() }));
vi.mock("@/app/api/voice/session/route", () => ({}));
vi.mock("@/app/api/voice/reaction/route", () => ({}));
import { requirePrincipal } from "@/lib/session";
import { MOBILE_API_PATH_HEADER, mobileApiRequestHeaders } from "@/lib/public-routes";
import { POST as voiceTurn } from "@/app/api/voice/turn/route";
import { POST as mobileVoice } from "@/app/api/mobile/v1/voice/[operation]/route";

const principal = { user: { id: "owner", sessionVersion: 1 } };
beforeEach(() => {
  vi.clearAllMocks(); f.headers = new Headers();
  f.cookie.mockResolvedValue({ user: { id: "owner", sessionVersion: 1 } });
  f.principal.mockResolvedValue(principal); f.mobile.mockResolvedValue(null);
  f.commit.mockResolvedValue({ accepted: true }); vi.stubEnv("AUTH_URL", "https://portal.example.test");
});
afterEach(() => vi.unstubAllEnvs());
it.each(["Bearer", "Bearer invalid", "Bearer cui_m_revoked"])("does not authenticate %s through a valid browser cookie", async authorization => {
  f.headers.set("authorization", authorization);
  f.headers.set("cookie", "synthetic-browser-session=present");
  await expect(requirePrincipal()).rejects.toMatchObject({ status: 401 });
  expect(f.cookie).not.toHaveBeenCalled(); expect(f.principal).not.toHaveBeenCalled();
});
it("accepts a verified bearer principal without consulting cookies", async () => {
  f.headers.set(MOBILE_API_PATH_HEADER, "/api/chat");
  f.headers.set("authorization", "Bearer cui_m_verified"); f.mobile.mockResolvedValue({ principal });
  expect(await requirePrincipal()).toBe(principal); expect(f.cookie).not.toHaveBeenCalled();
});

const batch = { conversationId: "conversation123", batchId: "batch12345678", sessionId: "voice-session", delegate: true,
  fragments: [{ id: "fragment", role: "user", text: "Synthetic prompt", startMs: 0, endMs: 1 }] };
function voiceRequest(path: string, extra: Record<string, string> = {}) {
  const request = new Request(`https://portal.example.test${path}`, { method: "POST",
    headers: { "content-type": "application/json", cookie: "synthetic-browser-session=present", ...extra }, body: JSON.stringify(batch) });
  // Use the real proxy header normalizer, including its path and server-action restrictions.
  f.headers = mobileApiRequestHeaders(request.headers, path);
  return request;
}
it("rejects a cookie-authenticated voice mutation with no Origin before reading or dispatching", async () => {
  const request = voiceRequest("/api/voice/turn");
  expect((await voiceTurn(request)).status).toBe(403);
  expect(request.bodyUsed).toBe(false); expect(f.commit).not.toHaveBeenCalled();
});
it("accepts an exact-origin browser voice mutation through real session authentication", async () => {
  const request = voiceRequest("/api/voice/turn", { origin: "https://portal.example.test" });
  expect((await voiceTurn(request)).status).toBe(200);
  expect(f.commit).toHaveBeenCalledWith(principal, batch);
});
it.each(["Bearer", "Bearer invalid", "Bearer cui_m_revoked"])("never falls back to cookies for a native voice mutation with %s", async authorization => {
  const request = voiceRequest("/api/mobile/v1/voice/turn", { authorization });
  expect((await mobileVoice(request, { params: Promise.resolve({ operation: "turn" }) })).status).toBe(401);
  expect(request.bodyUsed).toBe(false); expect(f.commit).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
});
it("preserves verified native voice without Origin through the mobile route and real session authentication", async () => {
  f.mobile.mockResolvedValue({ principal });
  const request = voiceRequest("/api/mobile/v1/voice/turn", { authorization: "Bearer cui_m_verified" });
  expect((await mobileVoice(request, { params: Promise.resolve({ operation: "turn" }) })).status).toBe(200);
  expect(f.commit).toHaveBeenCalledWith(principal, batch); expect(f.cookie).not.toHaveBeenCalled();
});
it("does not admit native tokens on the browser voice endpoint or with a server-action header", async () => {
  f.mobile.mockResolvedValue({ principal });
  for (const [path, extra] of [["/api/voice/turn", {}], ["/api/mobile/v1/voice/turn", { "next-action": "claimed-action" }]] as const) {
    const request = voiceRequest(path, { authorization: "Bearer cui_m_verified", ...extra });
    expect((await voiceTurn(request)).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
  }
  expect(f.mobile).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
});
