import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";

const f = vi.hoisted(() => ({ headers: new Headers(), cookie: vi.fn(), mobile: vi.fn(), principal: vi.fn(), logout: false }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => f.headers }));
vi.mock("@/auth", () => ({
  auth: (handler?: unknown) => typeof handler === "function" ? handler : f.cookie(),
  guardedHttpLogout: () => f.logout,
  authSessionCookieName: () => "session",
}));
vi.mock("@/lib/auth/web-sessions", () => ({ webSessionRegistryEnabled: () => false }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: f.principal }));
vi.mock("@/lib/auth/mobile", async original => ({ ...await original<typeof import("@/lib/auth/mobile")>(), mobilePrincipal: f.mobile }));

import { config, proxy } from "@/proxy";
import { MOBILE_API_PATH_HEADER } from "@/lib/public-routes";
import { requireAdmin, requireMobileSession, requirePrincipal } from "@/lib/session";

const principal = { user: { id: "owner", sessionVersion: 1 }, isAdmin: true };
const mobile = { principal, session: { id: "device" } };
const event = {} as NextFetchEvent;
const request = (path: string, method = "GET", headers: Record<string, string> = {}) => new NextRequest(`https://portal.test${path}`, {
  method, headers: { authorization: "Bearer cui_m_verified", [MOBILE_API_PATH_HEADER]: "/api/chat", ...headers },
});

// Apply NextResponse's actual upstream request-header overrides, not response headers sent to the browser.
async function forward(req: NextRequest) {
  const response = await proxy(req, event);
  f.headers = new Headers();
  for (const name of response?.headers.get("x-middleware-override-headers")?.split(",") ?? []) {
    const value = response?.headers.get(`x-middleware-request-${name}`);
    if (value !== null && value !== undefined) f.headers.set(name, value);
  }
  return response;
}

beforeEach(() => {
  vi.clearAllMocks(); f.headers = new Headers(); f.logout = false;
  f.cookie.mockResolvedValue({ user: principal.user });
  f.principal.mockResolvedValue(principal); f.mobile.mockResolvedValue(mobile);
});

describe("native token request boundary", () => {
  it.each(["/", "/c/x.png", "/admin/groups.svg", "/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/api/chat", "/api/mobile/v1/shell"])("sanitizes every path, including %s", path => {
    expect(unstable_doesProxyMatch({ config, nextConfig: {}, url: path })).toBe(true);
  });

  it.each(["/api/chat", "/api/chat/abc/approvals", "/api/files/abc", "/api/workspace/files", "/api/search", "/api/mobile/v1/shell", "/api/mobile/v1/voice/session"])("preserves native access to %s and nested server helpers", async path => {
    expect((await forward(request(path)))?.headers.get("x-middleware-next")).toBe("1");
    expect(f.headers.get(MOBILE_API_PATH_HEADER)).toBe(path);
    expect(await requirePrincipal()).toBe(principal);
    expect(await requireMobileSession()).toBe(mobile);
    expect(f.cookie).not.toHaveBeenCalled();
  });

  it.each(["/c/x.png", "/admin/groups.svg", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"])("strips forged mobile context on asset-like %s", async path => {
    await forward(request(path));
    expect(f.headers.has(MOBILE_API_PATH_HEADER)).toBe(false);
    await expect(requireAdmin()).rejects.toMatchObject({ status: 401 });
    await expect(requireMobileSession()).rejects.toMatchObject({ status: 401 });
    expect(f.mobile).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });

  it.each(["/c/x.png", "/admin/groups.svg", "/settings", "/api/chat"])("rejects native Server Action POSTs to %s", async path => {
    expect((await proxy(request(path, "POST", { "next-action": "synthetic-action" }), event))?.status).toBe(401);
  });

  it("fails closed with no server-owned path or an action header, even with a valid token and cookie", async () => {
    for (const path of [undefined, "/admin", "/api/chat"]) {
      f.headers = new Headers({ authorization: "Bearer cui_m_verified", cookie: "session=valid" });
      if (path) f.headers.set(MOBILE_API_PATH_HEADER, path);
      if (path === "/api/chat") f.headers.set("next-action", "synthetic-action");
      await expect(requirePrincipal()).rejects.toMatchObject({ status: 401 });
    }
    expect(f.mobile).not.toHaveBeenCalled(); expect(f.cookie).not.toHaveBeenCalled();
  });

  it.each(["multipart/form-data; boundary=synthetic", "multipart/form-data, multipart/form-data; boundary=synthetic", "multipart/form-data-invalid", "application/x-www-form-urlencoded"])("rejects progressive form actions (%s) without an action header", async type => {
    for (const path of ["/c/x.png", "/api/chat", "/api/mobile/v1/not-a-route"]) {
      expect((await proxy(request(path, "POST", { "content-type": type }), event))?.status).toBe(401);
      f.headers = new Headers({ authorization: "Bearer cui_m_verified", [MOBILE_API_PATH_HEADER]: path, "content-type": type });
      await expect(requirePrincipal()).rejects.toMatchObject({ status: 401 });
    }
  });

  it("preserves multipart uploads on the concrete API route", async () => {
    await forward(request("/api/files", "POST", { "content-type": "multipart/form-data; boundary=synthetic" }));
    expect(await requirePrincipal()).toBe(principal);
  });

  it("also strips mobile context on the guarded logout pass-through", async () => {
    f.logout = true;
    await forward(request("/api/auth/signout", "POST"));
    expect(f.headers.has(MOBILE_API_PATH_HEADER)).toBe(false);
    await expect(requirePrincipal()).rejects.toMatchObject({ status: 401 });
  });

  it("keeps normal browser session authentication", async () => {
    expect(await requirePrincipal()).toBe(principal);
    expect(f.mobile).not.toHaveBeenCalled();
  });
});
