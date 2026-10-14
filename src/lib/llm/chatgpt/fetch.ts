/** Fixed-origin transport for the public OpenAI API using the person's unified SIWC OAuth token. */
import { OPENAI_API_BASE_URL, ORIGINATOR, USER_AGENT } from "./constants";
import { rewriteChatGPTRequestBody } from "./body";
import { ChatGPTPlanError, ChatGPTReauthRequiredError, ChatGPTUnavailableError, ChatGPTUsageLimitError } from "./errors";
import type { ChatGPTAuth } from "./store";

type Fetch = typeof fetch;

export type ChatGPTFetchOptions = {
  conversationId: string | null;
  getAuth: (opts: { rejectedToken?: string }) => Promise<ChatGPTAuth>;
  baseFetch?: Fetch;
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
  const apiBase = new URL(OPENAI_API_BASE_URL);

  const send = async (url: string, init: RequestInit | undefined, body: string | undefined, auth: ChatGPTAuth) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    headers.set("originator", ORIGINATOR);
    headers.set("User-Agent", USER_AGENT);
    // Remove caller-supplied private Codex/account routing headers before using the public API.
    for (const name of ["chatgpt-account-id", "session-id", "x-client-request-id", "x-codex-turn-state", "x-openai-internal-codex-residency", "x-openai-fedramp"]) headers.delete(name);
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "text/event-stream");
    }
    return base(url, { ...init, headers, body, redirect: "error", cache: "no-store" });
  };

  return async (input, init) => {
    const url = urlOf(input);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Refusing to send a ChatGPT token outside the public OpenAI API"); }
    const allowedPaths = new Set([`${apiBase.pathname}/responses`, `${apiBase.pathname}/models`]);
    if (parsed.origin !== apiBase.origin || !allowedPaths.has(parsed.pathname) || parsed.search || parsed.hash) {
      throw new Error("Refusing to send a ChatGPT token outside the public OpenAI API");
    }
    let body: string | undefined;
    if (typeof init?.body === "string") {
      body = JSON.stringify(rewriteChatGPTRequestBody(JSON.parse(init.body) as Record<string, unknown>));
    } else if (init?.body != null) {
      throw new Error("Unexpected request body for the public OpenAI API");
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
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      const e = await errorBody(res);
      const kind = e.type ?? e.code;
      if (kind === "subscription_sharing_user_not_eligible") throw new ChatGPTPlanError();
      if (kind === "subscription_sharing_usage_limit_exceeded") throw new ChatGPTUsageLimitError(e.resetsAt ? new Date(e.resetsAt * 1000) : null);
      if (kind === "subscription_sharing_usage_unavailable") throw new ChatGPTUnavailableError();
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(e.text, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  };
}
