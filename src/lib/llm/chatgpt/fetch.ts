/**
 * The fetch behind a ChatGPT model, one instance per turn:
 *  - only ever talks to the Codex backend (anything else is refused);
 *  - adds the person's token and account headers per request (refreshing when needed), plus the portal's own
 *    originator/User-Agent, session ids, residency and FedRAMP headers, and the turn-state header within the turn;
 *  - rewrites the body to what the backend accepts (./body.ts);
 *  - on 401 refreshes once and retries; limit and plan errors become typed, non-retried errors.
 */
import { chatgptBackendUrl, ORIGINATOR, USER_AGENT } from "./constants";
import { rewriteCodexRequestBody } from "./body";
import { ChatGPTPlanError, ChatGPTReauthRequiredError, ChatGPTUsageLimitError } from "./errors";
import type { ChatGPTAuth } from "./store";

type Fetch = typeof fetch;

export type ChatGPTFetchOptions = {
  conversationId: string | null;
  /** Current auth; `rejectedToken` asks for a refresh after a 401. */
  getAuth: (opts: { rejectedToken?: string }) => Promise<ChatGPTAuth>;
  onRateLimits?: (credentialId: string, limits: Record<string, unknown>) => void;
  baseFetch?: Fetch;
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** x-codex-primary-* / x-codex-secondary-* headers → {primary:{usedPercent,windowMinutes,resetAt}, …}. */
export function readRateLimitHeaders(h: Headers): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const w of ["primary", "secondary"] as const) {
    const used = h.get(`x-codex-${w}-used-percent`);
    if (used == null) continue;
    const num = (v: string | null) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    out[w] = {
      usedPercent: num(used),
      windowMinutes: num(h.get(`x-codex-${w}-window-minutes`)),
      resetAt: num(h.get(`x-codex-${w}-reset-at`)),
    };
  }
  return Object.keys(out).length ? out : null;
}

async function errorBody(res: Response): Promise<{ type?: string; code?: string; resetsAt?: number; text: string }> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: { type?: unknown; code?: unknown; resets_at?: unknown } };
    const e = j?.error ?? {};
    return {
      type: typeof e.type === "string" ? e.type : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
      resetsAt: typeof e.resets_at === "number" ? e.resets_at : undefined,
      text,
    };
  } catch {
    return { text };
  }
}

export function chatgptFetch(opts: ChatGPTFetchOptions): Fetch {
  const base = opts.baseFetch ?? globalThis.fetch;
  const backend = chatgptBackendUrl();
  let turnState: string | undefined;

  const send = async (url: string, init: RequestInit | undefined, body: string | undefined, auth: ChatGPTAuth) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("openai-organization");
    headers.delete("openai-project");
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    headers.set("ChatGPT-Account-ID", auth.accountId);
    headers.set("originator", ORIGINATOR);
    headers.set("User-Agent", USER_AGENT);
    if (opts.conversationId) {
      headers.set("session-id", opts.conversationId);
      headers.set("x-client-request-id", opts.conversationId);
    }
    if (auth.residency) headers.set("x-openai-internal-codex-residency", auth.residency);
    if (auth.isFedramp) headers.set("X-OpenAI-Fedramp", "true");
    if (turnState) headers.set("x-codex-turn-state", turnState);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "text/event-stream");
    }
    const res = await base(url, { ...init, headers, body, redirect: "error" });
    const ts = res.headers.get("x-codex-turn-state");
    if (ts && !turnState) turnState = ts;
    const limits = readRateLimitHeaders(res.headers);
    if (limits) opts.onRateLimits?.(auth.credentialId, limits);
    return res;
  };

  return async (input, init) => {
    const url = urlOf(input);
    if (url !== backend && !url.startsWith(`${backend}/`)) throw new Error("Refusing to send a ChatGPT token outside the ChatGPT backend");
    let body: string | undefined;
    if (typeof init?.body === "string") {
      body = JSON.stringify(rewriteCodexRequestBody(JSON.parse(init.body) as Record<string, unknown>));
    } else if (init?.body != null) {
      throw new Error("Unexpected request body for the ChatGPT backend");
    }

    let auth = await opts.getAuth({});
    let res = await send(url, init, body, auth);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      auth = await opts.getAuth({ rejectedToken: auth.accessToken });
      res = await send(url, init, body, auth);
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        throw new ChatGPTReauthRequiredError("ChatGPT didn't accept your sign-in. Reconnect it in Settings → Connected accounts.");
      }
    }
    if (res.status === 429 || res.status === 403) {
      const e = await errorBody(res);
      const kind = e.type ?? e.code;
      if (kind === "usage_limit_reached") throw new ChatGPTUsageLimitError(e.resetsAt ? new Date(e.resetsAt * 1000) : null);
      if (kind === "usage_not_included") throw new ChatGPTPlanError();
      // Anything else goes back to the SDK unchanged (it reads the body itself). The text is already decoded.
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(e.text, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  };
}
