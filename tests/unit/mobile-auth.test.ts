import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
import { bearerToken, callbackUrl, deviceLabel, parseAuthorizeRequest, pkceChallenge } from "@/lib/auth/mobile";
import { hasBearer, isMobileApiPath, isPublicPath } from "@/lib/public-routes";

const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const params = (o: Record<string, string>) => (name: string) => o[name];

describe("native app sign-in parameters", () => {
  it("computes the RFC 7636 S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(challenge);
  });

  it("accepts only S256 challenges and well-formed state", () => {
    const ok = { code_challenge: challenge, state: "abcdefgh1234", device_name: "Jo’s iPhone" };
    expect(parseAuthorizeRequest(params(ok))).toEqual({ codeChallenge: challenge, state: "abcdefgh1234", deviceName: "Jo’s iPhone" });
    expect(parseAuthorizeRequest(params({ ...ok, code_challenge_method: "S256" }))).not.toBeNull();
    expect(parseAuthorizeRequest(params({ ...ok, code_challenge_method: "plain" }))).toBeNull();
    expect(parseAuthorizeRequest(params({ ...ok, code_challenge: "short" }))).toBeNull();
    expect(parseAuthorizeRequest(params({ ...ok, state: "x" }))).toBeNull();
    expect(parseAuthorizeRequest(params({ ...ok, state: "abcdefgh<script>" }))).toBeNull();
  });

  it("keeps device names to one bounded, printable line", () => {
    expect(deviceLabel("  iPad\n\u0000Pro  ")).toBe("iPad Pro");
    expect(deviceLabel("x".repeat(300))).toHaveLength(100);
    expect(deviceLabel(undefined)).toBe("iOS device");
    expect(deviceLabel("​")).toBe("iOS device");
  });

  it("returns only to the app's fixed callback", () => {
    expect(callbackUrl({ code: "a b", state: "s" })).toBe("collectiveui://auth/callback?code=a+b&state=s");
  });
});

describe("native app requests", () => {
  it("recognizes Bearer tokens only, never other Authorization schemes", () => {
    const h = (v?: string) => new Headers(v === undefined ? {} : { authorization: v });
    expect(bearerToken(h())).toBeUndefined();
    expect(bearerToken(h("Basic dXNlcjpwYXNz"))).toBeUndefined();
    expect(bearerToken(h("Bearer cui_m_abc"))).toBe("cui_m_abc");
    expect(bearerToken(h("bearer   cui_m_abc "))).toBe("cui_m_abc");
    expect(bearerToken(h("Bearer ptl_other"))).toBeNull();
    expect(bearerToken(h("Bearer"))).toBeNull();
    expect(bearerToken(h(`Bearer cui_m_${"x".repeat(200)}`))).toBeNull();
    expect(hasBearer("Bearer x")).toBe(true);
    expect(hasBearer("Bearer")).toBe(true);
    expect(hasBearer("Basic x")).toBe(false);
    expect(hasBearer(null)).toBe(false);
  });

  it("limits tokens to the chat, file, search and mobile APIs", () => {
    for (const path of ["/api/mobile/v1/shell", "/api/mobile/v1/bots/abc/chat", "/api/chat", "/api/chat/abc123", "/api/chat/abc123/stream",
      "/api/chat/abc123/stop", "/api/files", "/api/files/abc", "/api/search"])
      expect(isMobileApiPath(path), path).toBe(true);
    for (const path of ["/", "/settings", "/admin", "/api/admin/usage.csv", "/api/account/security", "/api/chat/abc/read", "/api/auth/session",
      "/api/mobile/auth/authorize", "/api/bots/x/pet", "/mobile/authorize", "/api/mobile/v1/../admin", "/api/files/a/b"])
      expect(isMobileApiPath(path), path).toBe(false);
  });

  it("keeps the consent steps behind a browser session, and only info/token public", () => {
    expect(isPublicPath("/api/mobile/info")).toBe(true);
    expect(isPublicPath("/api/mobile/auth/token")).toBe(true);
    expect(isPublicPath("/api/mobile/auth/authorize")).toBe(false);
    expect(isPublicPath("/mobile/authorize")).toBe(false);
    expect(isPublicPath("/api/mobile/v1/shell")).toBe(false);
    expect(isPublicPath("/api/mobile/info/x")).toBe(false);
  });
});
