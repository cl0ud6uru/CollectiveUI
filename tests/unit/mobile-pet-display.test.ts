import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: { user: { id: "viewer" } },
  principalForRequest: vi.fn(), mobileSession: vi.fn(), shell: vi.fn(), pets: vi.fn(), sprite: vi.fn(),
}));
vi.mock("@/lib/session", () => ({
  requirePrincipal: mocks.principalForRequest,
  requireMobileSession: mocks.mobileSession,
  errorResponse: (error: { status?: number }) => Response.json({ error: "Unavailable" }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/chat/shell", () => ({ loadShell: mocks.shell }));
vi.mock("@/lib/pets/store", () => ({ readAccessiblePets: mocks.pets, readAvatarSprite: mocks.sprite }));
import { GET as shell } from "@/app/api/mobile/v1/shell/route";
import { GET as avatar } from "@/app/api/mobile/v1/bots/[id]/pet/avatar/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.principalForRequest.mockResolvedValue(mocks.principal);
  mocks.mobileSession.mockResolvedValue({ principal: mocks.principal });
});

describe("mobile pet display contract", () => {
  it("uses only server-authorized bots and omits pet management/private import metadata", async () => {
    const authorized = [{ id: "bot /1" }];
    mocks.shell.mockResolvedValue({ user: { id: "viewer" }, bots: authorized, botRows: authorized });
    mocks.pets.mockResolvedValue({ "bot /1": {
      enabled: true, appearance: "catalog", motion: "still", revision: "rev+1", spriteUrl: "/api/bots/old/pet/avatar?v=rev",
      custom: { displayName: "Pet", spriteVersionNumber: 2 }, privateImport: { revision: "private" }, canPublish: true,
    } });
    const response = await shell();
    expect(mocks.pets).toHaveBeenCalledWith(mocks.principal, authorized);
    expect((await response.json()).pets).toEqual({ "bot /1": {
      enabled: true, appearance: "catalog", motion: "still", spriteVersionNumber: 2,
      spriteUrl: "/api/mobile/v1/bots/bot%20%2F1/pet/avatar?v=rev%2B1",
    } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("passes the mobile principal and revision to the existing access-checked image reader", async () => {
    mocks.sprite.mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    const response = await avatar(new Request("https://example.test/api/mobile/v1/bots/b1/pet/avatar?v=r1"), { params: Promise.resolve({ id: "b1" }) });
    expect(mocks.sprite).toHaveBeenCalledWith(mocks.principal, "b1", "r1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
  });

  it("does not read artwork without a mobile session", async () => {
    mocks.mobileSession.mockRejectedValue({ status: 401 });
    const response = await avatar(new Request("https://example.test/avatar"), { params: Promise.resolve({ id: "b1" }) });
    expect(response.status).toBe(401);
    expect(mocks.sprite).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("preserves access and stale-revision denials without caching them", async () => {
    mocks.sprite.mockRejectedValue({ status: 404 });
    const response = await avatar(new Request("https://example.test/avatar?v=stale"), { params: Promise.resolve({ id: "b1" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
