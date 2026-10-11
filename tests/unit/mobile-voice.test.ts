import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/authz";
const mocks = vi.hoisted(() => ({ principal: vi.fn(), target: vi.fn(), settings: vi.fn(), read: vi.fn(), stat: vi.fn(),
  sessionGET: vi.fn(), sessionPOST: vi.fn(), turnGET: vi.fn(), turnPOST: vi.fn(), reaction: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: mocks.principal, errorResponse: (error: { status?: number; message: string }) => Response.json({ error: error.message }, { status: error.status ?? 500 }) }));
vi.mock("@/lib/voice/target", () => ({ targetFor: mocks.target }));
vi.mock("@/lib/settings", () => ({ getSetting: mocks.settings }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read, stat: mocks.stat }));
vi.mock("@/app/api/voice/session/route", () => ({ GET: mocks.sessionGET, POST: mocks.sessionPOST }));
vi.mock("@/app/api/voice/turn/route", () => ({ GET: mocks.turnGET, POST: mocks.turnPOST }));
vi.mock("@/app/api/voice/reaction/route", () => ({ POST: mocks.reaction }));
import { GET, POST } from "@/app/api/mobile/v1/voice/[operation]/route";
const ctx = (operation: string) => ({ params: Promise.resolve({ operation }) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.principal.mockResolvedValue({ user: { id: "member" } });
  for (const handler of [mocks.sessionGET, mocks.sessionPOST, mocks.turnGET, mocks.turnPOST, mocks.reaction]) handler.mockResolvedValue(Response.json({ ok: true }));
  mocks.settings.mockResolvedValue({ avatarUrl: "/avatars/bot.glb" }); mocks.stat.mockResolvedValue({ size: 4 }); mocks.read.mockResolvedValue(Buffer.from("glTF"));
});
describe("mobile voice gateway", () => {
  it("keeps native sessions and mutations on the shared authorized handlers", async () => {
    const request = new Request("https://portal/api/mobile/v1/voice/session", { method: "POST" });
    expect((await POST(request, ctx("session"))).status).toBe(200);
    expect(mocks.sessionPOST).toHaveBeenCalledWith(request);
    expect(mocks.principal).toHaveBeenCalledOnce();
    await GET(new Request("https://portal/api/mobile/v1/voice/turn"), ctx("turn"));
    expect(mocks.turnGET).toHaveBeenCalledOnce();
  });
  it("denies authentication failures before dispatching or reading assets", async () => {
    mocks.principal.mockRejectedValue(new HttpError(401, "Unauthorized"));
    expect((await POST(new Request("https://portal/api/mobile/v1/voice/session"), ctx("session"))).status).toBe(401);
    expect(mocks.sessionPOST).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("checks the conversation before returning a bounded configured GLB", async () => {
    const request = new Request("https://portal/api/mobile/v1/voice/avatar?conversationId=chat01");
    const response = await GET(request, ctx("avatar"));
    expect(response.headers.get("content-type")).toBe("model/gltf-binary");
    expect(await response.text()).toBe("glTF");
    expect(mocks.target).toHaveBeenCalledWith({ user: { id: "member" } }, { conversationId: "chat01" });
    mocks.target.mockRejectedValue(new HttpError(403, "Denied")); mocks.read.mockClear();
    expect((await GET(request, ctx("avatar"))).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects unsupported operations, traversal paths, and oversized avatars", async () => {
    const request = new Request("https://portal/api/mobile/v1/voice/avatar?conversationId=chat01");
    expect((await POST(request, ctx("approvals"))).status).toBe(404);
    mocks.settings.mockResolvedValue({ avatarUrl: "/avatars/../../private.glb" });
    expect((await GET(request, ctx("avatar"))).status).toBe(404); expect(mocks.read).not.toHaveBeenCalled();
    mocks.settings.mockResolvedValue({ avatarUrl: "/avatars/bot.glb" }); mocks.stat.mockResolvedValue({ size: 30 * 1024 * 1024 });
    expect((await GET(request, ctx("avatar"))).status).toBe(413); expect(mocks.read).not.toHaveBeenCalled();
  });
});
