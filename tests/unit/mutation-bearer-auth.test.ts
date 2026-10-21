import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ headers: new Headers(), cookie: vi.fn(), mobile: vi.fn(), principal: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => f.headers }));
vi.mock("@/auth", () => ({ auth: f.cookie }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: f.principal }));
vi.mock("@/lib/auth/mobile", async (original) => ({ ...await original<typeof import("@/lib/auth/mobile")>(), mobilePrincipal: f.mobile }));
import { requirePrincipal } from "@/lib/session";

const principal = { user: { id: "owner", sessionVersion: 1 } };
beforeEach(() => {
  vi.clearAllMocks(); f.headers = new Headers();
  f.cookie.mockResolvedValue({ user: { id: "owner", sessionVersion: 1 } });
  f.principal.mockResolvedValue(principal); f.mobile.mockResolvedValue(null);
});
it.each(["Bearer", "Bearer invalid", "Bearer cui_m_revoked"])("does not authenticate %s through a valid browser cookie", async authorization => {
  f.headers.set("authorization", authorization);
  f.headers.set("cookie", "synthetic-browser-session=present");
  await expect(requirePrincipal()).rejects.toMatchObject({ status: 401 });
  expect(f.cookie).not.toHaveBeenCalled(); expect(f.principal).not.toHaveBeenCalled();
});
it("accepts a verified bearer principal without consulting cookies", async () => {
  f.headers.set("authorization", "Bearer cui_m_verified"); f.mobile.mockResolvedValue({ principal });
  expect(await requirePrincipal()).toBe(principal); expect(f.cookie).not.toHaveBeenCalled();
});
