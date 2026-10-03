/**
 * OpenAI sign-in calls for "Sign in with ChatGPT": device code, poll, code exchange, refresh and revoke. Each call
 * makes exactly one request (no loops, no retries): polling is driven by the browser one request at a time, and a
 * code exchange must never be retried because the authorization code may already be spent.
 *
 * Errors never include tokens or raw response bodies.
 */
import { redactSecrets } from "@/lib/redact";
import { CHATGPT_CLIENT_ID, chatgptAuthBaseUrl, DEVICE_REDIRECT_URI, USER_AGENT } from "./constants";

type Fetch = typeof fetch;

const TIMEOUT_MS = 20_000;

export class ChatGPTAuthFlowError extends Error {
  constructor(
    message: string,
    public code: "disabled" | "rate_limited" | "unavailable" | "failed",
  ) {
    super(message);
    this.name = "ChatGPTAuthFlowError";
  }
}

export type TokenSet = { accessToken: string; refreshToken?: string; idToken?: string; expiresIn?: number };

async function post(f: Fetch, path: string, body: Record<string, string>, form = false): Promise<Response> {
  return f(`${chatgptAuthBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = await res.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The upstream error code, if any: {error: "x"}, {error: {code|type: "x"}} or {code: "x"}. Safe to log. */
export function errorCodeOf(body: Record<string, unknown>): string | undefined {
  const e = body.error;
  const raw = typeof e === "string" ? e : e && typeof e === "object" ? ((e as Record<string, unknown>).code ?? (e as Record<string, unknown>).type) : body.code;
  return typeof raw === "string" ? redactSecrets(raw).slice(0, 80) : undefined;
}

function tokenSetFrom(body: Record<string, unknown>): TokenSet | null {
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined,
    idToken: typeof body.id_token === "string" && body.id_token ? body.id_token : undefined,
    expiresIn: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : undefined,
  };
}

export type DeviceCode = { deviceAuthId: string; userCode: string; intervalSec: number };

/** Step 1: ask for a user code. A 404 means device-code sign-in is switched off for the workspace or client. */
export async function requestDeviceCode(f: Fetch = fetch): Promise<DeviceCode> {
  let res: Response;
  try {
    res = await post(f, "/api/accounts/deviceauth/usercode", { client_id: CHATGPT_CLIENT_ID });
  } catch {
    throw new ChatGPTAuthFlowError("Can't reach the ChatGPT sign-in service. Try again in a minute.", "unavailable");
  }
  if (res.status === 404) {
    throw new ChatGPTAuthFlowError("Device-code sign-in isn't enabled. Ask your ChatGPT workspace admin to allow it for Codex.", "disabled");
  }
  if (res.status === 429) throw new ChatGPTAuthFlowError("Too many sign-in attempts. Wait a minute and try again.", "rate_limited");
  if (!res.ok) throw new ChatGPTAuthFlowError(`The ChatGPT sign-in service returned an error (${res.status}).`, "unavailable");
  const body = await json(res);
  const deviceAuthId = typeof body.device_auth_id === "string" ? body.device_auth_id : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : typeof body.usercode === "string" ? body.usercode : "";
  if (!deviceAuthId || !userCode) throw new ChatGPTAuthFlowError("The ChatGPT sign-in service sent an unexpected reply.", "failed");
  // interval arrives as a string of seconds.
  const intervalSec = Math.min(30, Math.max(3, Math.round(Number(String(body.interval ?? "").trim())) || 5));
  return { deviceAuthId, userCode, intervalSec };
}

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string }
  | { status: "failed"; message: string };

/** Step 2: one poll. 403/404 mean the person hasn't finished yet. */
export async function pollDeviceCode(deviceAuthId: string, userCode: string, f: Fetch = fetch): Promise<PollResult> {
  let res: Response;
  try {
    res = await post(f, "/api/accounts/deviceauth/token", { device_auth_id: deviceAuthId, user_code: userCode });
  } catch {
    return { status: "pending" }; // network hiccup: try again on the next poll
  }
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  const body = await json(res);
  const code = errorCodeOf(body);
  if (code === "slow_down" || res.status === 429) return { status: "slow_down" };
  if (code === "deviceauth_authorization_pending") return { status: "pending" };
  if (!res.ok) return { status: "failed", message: `Sign-in was not completed (${res.status}${code ? ` ${code}` : ""}).` };
  const authorizationCode = typeof body.authorization_code === "string" ? body.authorization_code : "";
  const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  if (!authorizationCode || !codeVerifier) return { status: "failed", message: "The ChatGPT sign-in service sent an unexpected reply." };
  return { status: "authorized", authorizationCode, codeVerifier };
}

/** Step 3: trade the authorization code for tokens. Never retried: the code may already have been consumed. */
export async function exchangeAuthorizationCode(authorizationCode: string, codeVerifier: string, f: Fetch = fetch): Promise<TokenSet> {
  let res: Response;
  try {
    res = await post(
      f,
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: DEVICE_REDIRECT_URI,
        client_id: CHATGPT_CLIENT_ID,
        code_verifier: codeVerifier,
      },
      true,
    );
  } catch {
    throw new ChatGPTAuthFlowError("Can't reach the ChatGPT sign-in service. Start the sign-in again.", "unavailable");
  }
  const body = await json(res);
  const tokens = res.ok ? tokenSetFrom(body) : null;
  if (!tokens) {
    const code = errorCodeOf(body);
    throw new ChatGPTAuthFlowError(`Sign-in failed (${res.status}${code ? ` ${code}` : ""}). Start the sign-in again.`, "failed");
  }
  return tokens;
}

const PERMANENT_REFRESH_CODES = new Set(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant"]);

/** Codex's classification: 401, invalid_grant and the refresh_token_* codes need a new sign-in; the rest is transient. */
export function classifyRefreshFailure(status: number, code: string | undefined): { permanent: boolean; reason: string } {
  if (status === 401 || (code && PERMANENT_REFRESH_CODES.has(code))) {
    return { permanent: true, reason: code ?? `http_${status}` };
  }
  return { permanent: false, reason: code ?? `http_${status}` };
}

export type RefreshResult =
  | { ok: true; tokens: TokenSet }
  /** `rotatedRefreshToken`: a 200 without a usable access token that still rotated the refresh token; keep it. */
  | { ok: false; permanent: boolean; reason: string; rotatedRefreshToken?: string };

/** One refresh. Refresh tokens rotate and are single-use: callers must hold the credential's row lock. */
export async function refreshTokens(refreshToken: string, f: Fetch = fetch): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await post(f, "/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CHATGPT_CLIENT_ID }, true);
  } catch {
    return { ok: false, permanent: false, reason: "network" };
  }
  const body = await json(res);
  if (res.ok) {
    const tokens = tokenSetFrom(body);
    if (tokens) return { ok: true, tokens };
    // The old refresh token may already be spent upstream; losing a rotated one would revoke the whole sign-in.
    const rotated = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
    return { ok: false, permanent: false, reason: "malformed_response", ...(rotated ? { rotatedRefreshToken: rotated } : {}) };
  }
  return { ok: false, ...classifyRefreshFailure(res.status, errorCodeOf(body)) };
}

/** Best-effort revoke (the refresh token revokes the whole sign-in). Never throws. */
export async function revokeTokens(tokens: { refreshToken?: string; accessToken?: string }, f: Fetch = fetch): Promise<boolean> {
  const body: Record<string, string> | null = tokens.refreshToken
    ? { token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: CHATGPT_CLIENT_ID }
    : tokens.accessToken
      ? { token: tokens.accessToken, token_type_hint: "access_token" }
      : null;
  if (!body) return false;
  try {
    const res = await post(f, "/oauth/revoke", body);
    return res.ok;
  } catch {
    return false;
  }
}
