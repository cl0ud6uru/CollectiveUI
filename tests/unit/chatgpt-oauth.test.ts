import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChatGPTAuthFlowError,
  classifyRefreshFailure,
  exchangeAuthorizationCode,
  pollDeviceCode,
  refreshTokens,
  requestDeviceCode,
  revokeTokens,
} from "@/lib/llm/chatgpt/oauth";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const replies: Response[] = [];
const f: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), init: init ?? {} });
  const r = replies.shift();
  if (!r) throw new TypeError("fetch failed");
  return r;
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (c: Call) => String(c.init.body);

beforeEach(() => {
  calls = [];
  replies.length = 0;
  delete process.env.CHATGPT_AUTH_BASE_URL;
});
afterEach(() => {
  delete process.env.CHATGPT_AUTH_BASE_URL;
});

describe("device code sign-in", () => {
  it("asks for a user code with the Codex client id and parses the string interval", async () => {
    replies.push(json(200, { device_auth_id: "dev_1", user_code: "ABCD-1234", interval: " 7 " }));
    expect(await requestDeviceCode(f)).toEqual({ deviceAuthId: "dev_1", userCode: "ABCD-1234", intervalSec: 7 });
    expect(calls[0].url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/AIPortal/);
    expect(calls[0].init.redirect).toBe("error");
  });

  it("clamps the interval and explains a disabled device flow", async () => {
    replies.push(json(200, { device_auth_id: "d", usercode: "X", interval: "1" }));
    expect((await requestDeviceCode(f)).intervalSec).toBe(3);
    replies.push(json(404, {}));
    await expect(requestDeviceCode(f)).rejects.toMatchObject({ code: "disabled" });
    replies.push(json(429, {}));
    await expect(requestDeviceCode(f)).rejects.toBeInstanceOf(ChatGPTAuthFlowError);
  });

  it("honours the endpoint override outside production only", async () => {
    process.env.CHATGPT_AUTH_BASE_URL = "http://localhost:4010/";
    replies.push(json(200, { device_auth_id: "d", user_code: "X", interval: "5" }));
    await requestDeviceCode(f);
    expect(calls[0].url).toBe("http://localhost:4010/api/accounts/deviceauth/usercode");
  });

  it("maps poll answers", async () => {
    replies.push(json(403, { error: "deviceauth_authorization_pending" }), json(404, {}), json(400, { error: "slow_down" }));
    expect(await pollDeviceCode("d", "u", f)).toEqual({ status: "pending" });
    expect(await pollDeviceCode("d", "u", f)).toEqual({ status: "pending" });
    expect(await pollDeviceCode("d", "u", f)).toEqual({ status: "slow_down" });
    replies.push(json(200, { authorization_code: "code", code_verifier: "ver" }));
    expect(await pollDeviceCode("d", "u", f)).toEqual({ status: "authorized", authorizationCode: "code", codeVerifier: "ver" });
    expect(JSON.parse(bodyOf(calls[3]))).toEqual({ device_auth_id: "d", user_code: "u" });
    replies.push(json(500, { error: { code: "boom" } }));
    expect(await pollDeviceCode("d", "u", f)).toMatchObject({ status: "failed" });
    // Network trouble: just poll again later.
    expect(await pollDeviceCode("d", "u", f)).toEqual({ status: "pending" });
  });

  it("exchanges the code once (form-encoded, device redirect) and never retries", async () => {
    replies.push(json(200, { access_token: "at", refresh_token: "rt", id_token: "it", expires_in: 3600 }));
    expect(await exchangeAuthorizationCode("code", "ver", f)).toEqual({ accessToken: "at", refreshToken: "rt", idToken: "it", expiresIn: 3600 });
    const form = new URLSearchParams(bodyOf(calls[0]));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "ver",
    });
    calls = [];
    await expect(exchangeAuthorizationCode("code", "ver", f)).rejects.toBeInstanceOf(ChatGPTAuthFlowError); // no reply queued: network error
    expect(calls).toHaveLength(1);
  });
});

describe("refresh", () => {
  it("classifies failures like Codex", () => {
    expect(classifyRefreshFailure(401, undefined)).toEqual({ permanent: true, reason: "http_401" });
    for (const code of ["invalid_grant", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]) {
      expect(classifyRefreshFailure(400, code).permanent, code).toBe(true);
    }
    expect(classifyRefreshFailure(429, undefined).permanent).toBe(false);
    expect(classifyRefreshFailure(503, "server_is_overloaded").permanent).toBe(false);
  });

  it("returns new tokens, or a classified failure without the token in it", async () => {
    replies.push(json(200, { access_token: "at2" }));
    expect(await refreshTokens("rt-secret", f)).toEqual({ ok: true, tokens: { accessToken: "at2" } });
    expect(Object.fromEntries(new URLSearchParams(bodyOf(calls[0])))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-secret",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    replies.push(json(400, { error: { code: "refresh_token_reused", message: "rt-secret was reused" } }));
    const r = await refreshTokens("rt-secret", f);
    expect(r).toEqual({ ok: false, permanent: true, reason: "refresh_token_reused" });
    replies.push(json(502, {}));
    expect(await refreshTokens("rt-secret", f)).toEqual({ ok: false, permanent: false, reason: "http_502" });
    // A 200 that rotated the refresh token without a usable access token: the new refresh token must be kept.
    replies.push(json(200, { refresh_token: "rt-new" }));
    expect(await refreshTokens("rt-secret", f)).toEqual({ ok: false, permanent: false, reason: "malformed_response", rotatedRefreshToken: "rt-new" });
    expect(await refreshTokens("rt-secret", f)).toEqual({ ok: false, permanent: false, reason: "network" });
  });

  it("revokes the refresh token (with client id), else the access token, best effort", async () => {
    replies.push(json(200, {}));
    expect(await revokeTokens({ refreshToken: "rt", accessToken: "at" }, f)).toBe(true);
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({ token: "rt", token_type_hint: "refresh_token", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    replies.push(json(200, {}));
    await revokeTokens({ accessToken: "at" }, f);
    expect(JSON.parse(bodyOf(calls[1]))).toEqual({ token: "at", token_type_hint: "access_token" });
    expect(await revokeTokens({ accessToken: "at" }, f)).toBe(false); // network error swallowed
  });
});
