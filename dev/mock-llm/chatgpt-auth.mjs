// Mock of OpenAI's sign-in endpoints used by "Sign in with ChatGPT" (the Codex device-code flow), so the portal's
// connect flow, token refresh and the Codex backend can be exercised locally and in tests:
// - POST /api/accounts/deviceauth/usercode   → {device_auth_id, user_code, interval}
// - POST /api/accounts/deviceauth/token      → 403 (pending) on the first poll, then {authorization_code, code_verifier}
// - POST /oauth/token                        → authorization_code and refresh_token grants (refresh tokens rotate;
//                                              reusing one returns 400 refresh_token_reused, like the real service)
// - POST /oauth/revoke                       → 200
// - GET  /codex/device                       → a placeholder page
// - POST /__mock/chatgpt                    → test control: {refreshMode: "normal"|"no-id-token"|"refresh-only"|
//                                              "unavailable", fedramp, residency, plan}
// Env: MOCK_CHATGPT_PLAN (default "plus"), MOCK_CHATGPT_ACCOUNT (default "acct-mock"), MOCK_CHATGPT_TOKEN_TTL (s).
import { randomUUID } from "node:crypto";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.mock`;

const devices = new Map(); // device_auth_id → { userCode, polls, subject }
const codes = new Map(); // authorization_code → { verifier, subject }
const accessTokens = new Map(); // token → expiry (ms)
const refreshTokens = new Map(); // token → { subject, used }
let counter = 0;
/** Test controls (POST /__mock/chatgpt). FedRAMP and residency are id-token claims, as with the real service. */
const control = { refreshMode: "normal", fedramp: false, residency: null, plan: null };

function issue(subject) {
  const ttl = Number(process.env.MOCK_CHATGPT_TOKEN_TTL ?? 3600);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const auth = {
    chatgpt_account_id: process.env.MOCK_CHATGPT_ACCOUNT ?? "acct-mock",
    chatgpt_plan_type: control.plan ?? process.env.MOCK_CHATGPT_PLAN ?? "plus",
    chatgpt_user_id: subject,
  };
  const idAuth = { ...auth, chatgpt_account_is_fedramp: control.fedramp, ...(control.residency ? { chatgpt_data_residency: control.residency } : {}) };
  const access = jwt({ exp, jti: randomUUID(), "https://api.openai.com/auth": auth });
  const refresh = `rt_mock_${randomUUID()}`;
  accessTokens.set(access, exp * 1000);
  refreshTokens.set(refresh, { subject, used: false });
  return {
    id_token: jwt({ exp, email: `${subject}@example.com`, "https://api.openai.com/auth": idAuth }),
    access_token: access,
    refresh_token: refresh,
    expires_in: ttl,
  };
}

/** Whether a Codex backend request carries a token this mock issued (and that hasn't expired). */
export function validChatGPTToken(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  const exp = m ? accessTokens.get(m[1]) : undefined;
  return !!exp && exp > Date.now();
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Handles the sign-in routes; returns false for anything else. `raw` is the unparsed request body. */
export function handleChatGPTAuth(req, res, url, raw) {
  if (req.method === "GET" && url.pathname === "/codex/device") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Mock ChatGPT device sign-in</h1><p>The mock approves every code automatically.</p>");
    return true;
  }
  if (req.method !== "POST") return false;
  const body = () => {
    if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  switch (url.pathname) {
    case "/api/accounts/deviceauth/usercode": {
      const id = `dev_${randomUUID()}`;
      const userCode = `MOCK-${String(1000 + (counter++ % 9000))}`;
      devices.set(id, { userCode, polls: 0, subject: `user-mock-${randomUUID().slice(0, 8)}` });
      json(res, 200, { device_auth_id: id, user_code: userCode, interval: "1" });
      return true;
    }
    case "/api/accounts/deviceauth/token": {
      const b = body();
      const d = devices.get(b.device_auth_id);
      if (!d || d.userCode !== b.user_code) return json(res, 404, { error: "not_found" }), true;
      if (d.polls++ === 0) return json(res, 403, { error: "deviceauth_authorization_pending" }), true;
      devices.delete(b.device_auth_id);
      const code = `code_${randomUUID()}`;
      const verifier = `verifier_${randomUUID()}`;
      codes.set(code, { verifier, subject: d.subject });
      json(res, 200, { authorization_code: code, code_challenge: "mock", code_verifier: verifier });
      return true;
    }
    case "/oauth/token": {
      const b = body();
      if (b.grant_type === "authorization_code") {
        const c = codes.get(b.code);
        codes.delete(b.code);
        if (!c || c.verifier !== b.code_verifier || b.redirect_uri !== "https://auth.openai.com/deviceauth/callback") {
          return json(res, 400, { error: "invalid_grant" }), true;
        }
        json(res, 200, issue(c.subject));
        return true;
      }
      if (b.grant_type === "refresh_token") {
        if (control.refreshMode === "unavailable") return json(res, 503, { error: { code: "server_is_overloaded" } }), true;
        const r = refreshTokens.get(b.refresh_token);
        if (!r) return json(res, 401, { error: { code: "refresh_token_invalidated" } }), true;
        if (r.used) return json(res, 400, { error: { code: "refresh_token_reused" } }), true;
        r.used = true;
        const tokens = issue(r.subject);
        if (control.refreshMode === "no-id-token") delete tokens.id_token;
        if (control.refreshMode === "refresh-only") {
          accessTokens.delete(tokens.access_token);
          return json(res, 200, { refresh_token: tokens.refresh_token }), true;
        }
        json(res, 200, tokens);
        return true;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return true;
    }
    case "/__mock/chatgpt": {
      Object.assign(control, body());
      json(res, 200, control);
      return true;
    }
    case "/oauth/revoke": {
      const b = body();
      const r = refreshTokens.get(b.token);
      if (r) r.used = true;
      accessTokens.delete(b.token);
      json(res, 200, {});
      return true;
    }
    default:
      return false;
  }
}
