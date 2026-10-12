import { randomUUID, createHash } from "node:crypto";
import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import type { NextAuthConfig } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ config: undefined as NextAuthConfig | undefined, post: vi.fn(), proxy: vi.fn(), signOut: vi.fn(), headers: vi.fn(), revoke: vi.fn(), admit: vi.fn(), state: vi.fn() }));
const secret = "synthetic-logout-wiring-secret".repeat(2);
vi.mock("@/db", () => ({ db: null }));
vi.mock("next/headers", () => ({ headers: f.headers }));
vi.mock("@/lib/auth/config", () => ({ entraEnabled: () => false, ldapEnabled: () => false, localEnabled: () => false }));
vi.mock("@/lib/auth/session-state", async original => ({ ...await original<object>(), sessionState: f.state }));
vi.mock("@/lib/auth/web-sessions", async original => ({ ...await original<object>(), revokeWebSession: f.revoke, admitWebSession: f.admit }));
vi.mock("next-auth", () => ({ CredentialsSignin: class extends Error { code = "credentials"; }, default: (config: NextAuthConfig) => {
  config.secret = "synthetic-logout-wiring-secret".repeat(2); config.basePath = "/api/auth"; f.config = config;
  return { auth: () => f.proxy, signIn: vi.fn(), signOut: f.signOut, handlers: { GET: vi.fn(), POST: f.post } };
} }));
import { handlers, signOut } from "@/auth";
import { proxy } from "@/proxy";
import type { NextFetchEvent } from "next/server";

let cookie: string; let identity: { uid: string; authSessionId: string; sessionVersion: number; sessionDeadline: number };
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv("AUTH_WEB_SESSION_REGISTRY_ENABLED", "1"); vi.stubEnv("AUTH_URL", "https://portal.example");
  identity = { uid: "owner-a", authSessionId: randomUUID(), sessionVersion: 1, sessionDeadline: Math.floor(Date.now() / 1000) + 3600 };
  const jwt = await encode({ token: identity, secret, salt: "__Secure-authjs.session-token" });
  const csrf = "csrf-proof"; const hash = createHash("sha256").update(`${csrf}${secret}`).digest("hex");
  cookie = `__Secure-authjs.session-token=${jwt}; __Host-authjs.csrf-token=${encodeURIComponent(`${csrf}|${hash}`)}`;
  f.headers.mockResolvedValue(new Headers({ cookie })); f.revoke.mockResolvedValue(undefined); f.admit.mockResolvedValue(true);
  f.state.mockResolvedValue({ mustChangePassword: false });
  f.post.mockResolvedValue(new Response("{}", { headers: { "Set-Cookie": "__Secure-authjs.session-token=; Max-Age=0" } }));
  f.signOut.mockResolvedValue(undefined);
  const headers = new Headers();
  headers.append("set-cookie", "__Secure-authjs.session-token.0=; Max-Age=0; Path=/");
  headers.append("set-cookie", "__Host-authjs.csrf-token=csrf; Path=/");
  f.proxy.mockResolvedValue(new Response(null, { status: 401, headers }));
});
afterEach(() => vi.unstubAllEnvs());
const request = (path = "signout") => new NextRequest(`https://portal.example/api/auth/${path}`, { method: "POST", headers: { origin: "https://portal.example", cookie, "content-type": "application/x-www-form-urlencoded" }, body: "csrfToken=csrf-proof" });

describe("actual exported Auth.js logout wiring", () => {
  it.each(["signout", "signout/", "/signout"])("commits before the HTTP delegate clears cookies for %s", async path => {
    const response = await handlers.POST(request(path)); expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(f.revoke.mock.invocationCallOrder[0]).toBeLessThan(f.post.mock.invocationCallOrder[0]);
  });
  it("does not delegate either logout path after a database failure", async () => {
    f.revoke.mockRejectedValue(new Error("synthetic DB unavailable"));
    const response = await handlers.POST(request()); expect(response.status).toBe(503); expect(response.headers.has("Set-Cookie")).toBe(false);
    await expect(signOut({ redirectTo: "/login" })).rejects.toThrow(); expect(f.post).not.toHaveBeenCalled(); expect(f.signOut).not.toHaveBeenCalled();
  });
  it("the complete proxy + route outage path preserves retry cookies and skips session reads", async () => {
    f.revoke.mockRejectedValue(new Error("synthetic DB unavailable"));
    const req = request();
    expect((await proxy(req, {} as NextFetchEvent))!.headers.has("Set-Cookie")).toBe(false);
    expect(f.proxy).not.toHaveBeenCalled();
    const response = await handlers.POST(req);
    expect(response.status).toBe(503); expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });
  it("proxy callback failure cannot clear server-action cookies, while native/API routing still delegates", async () => {
    for (const path of ["/chat", "/api/mobile/session", "/api/bots"]) {
      const req = new NextRequest(`https://portal.example${path}`, { method: "POST", headers: { "next-action": "fixture-action" } });
      const response = (await proxy(req, {} as NextFetchEvent))!;
      expect(response.status).toBe(401); expect(response.headers.getSetCookie()).toEqual(["__Host-authjs.csrf-token=csrf; Path=/"]);
    }
    expect(f.proxy).toHaveBeenCalledTimes(3);
    vi.stubEnv("AUTH_WEB_SESSION_REGISTRY_ENABLED", "0");
    expect((await proxy(new NextRequest("https://portal.example/api/auth/signout"), {} as NextFetchEvent))!.headers.getSetCookie()).toHaveLength(2);
  });
  it("preserves successful renewal cleanup when a JWT shrinks to fewer chunks", async () => {
    const headers = new Headers();
    for (const cookie of ["__Secure-authjs.session-token.2=; Max-Age=0", "__Secure-authjs.session-token.0=renewed-a", "__Secure-authjs.session-token.1=renewed-b"]) headers.append("set-cookie", cookie);
    f.proxy.mockResolvedValue(new Response(null, { headers }));
    const response = (await proxy(new NextRequest("https://portal.example/chat"), {} as NextFetchEvent))!;
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });
  it("server action commits revocation before its cookie-writing signOut delegate", async () => {
    await signOut({ redirectTo: "/login" }); expect(f.revoke.mock.invocationCallOrder[0]).toBeLessThan(f.signOut.mock.invocationCallOrder[0]);
  });
  it("JWT refresh refuses a registry-revoked session and account revocation precedes registry admission", async () => {
    const jwt = f.config!.callbacks!.jwt as unknown as (o: { token: typeof identity }) => Promise<unknown>;
    f.admit.mockResolvedValue(false); expect(await jwt({ token: identity })).toBeNull();
    f.admit.mockClear(); f.state.mockResolvedValue(null); expect(await jwt({ token: identity })).toBeNull(); expect(f.admit).not.toHaveBeenCalled();
  });
});
