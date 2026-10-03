import { describeProviderError } from "../errors";
import { chatgptBackendUrl, CLIENT_VERSION } from "./constants";
import type { ChatGPTSettings } from "@/lib/settings";
import { ChatGPTNotConnectedError, isUserFacingError } from "./errors";
import { accountRejection } from "./policy";
import { chatgptFetch } from "./fetch";
import { getChatGPTAuth } from "./store";

export type ChatGPTModelInfo = { slug: string; displayName: string };

/**
 * Models this person's ChatGPT plan offers in Codex (the admin's own connection is used to fill the app form).
 * Only models the backend marks as listable are returned.
 */
export async function listChatGPTModels(userId: string, baseFetch?: typeof fetch): Promise<ChatGPTModelInfo[]> {
  const f = chatgptFetch({
    conversationId: null,
    getAuth: ({ rejectedToken }) => getChatGPTAuth(userId, { rejectedToken, fetch: baseFetch }),
    baseFetch,
  });
  const res = await f(`${chatgptBackendUrl()}/codex/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The ChatGPT models list returned ${res.status}.`);
  const body = (await res.json().catch(() => ({}))) as { models?: unknown };
  const models = Array.isArray(body.models) ? (body.models as Record<string, unknown>[]) : [];
  return models
    .filter((m) => typeof m.slug === "string" && (m.visibility == null || m.visibility === "list"))
    .map((m) => ({ slug: m.slug as string, displayName: typeof m.display_name === "string" ? m.display_name : (m.slug as string) }));
}

/**
 * Admin "Test" for a ChatGPT app: lists the models the admin's own connected plan offers. Follows the same rules as
 * chatting: nothing happens while the feature is off, and the admin's account must be one the settings allow.
 */
export async function testChatGPTConnection(
  userId: string,
  settings: ChatGPTSettings,
  baseFetch?: typeof fetch,
): Promise<{ ok: true; models: string[]; note?: string } | { ok: false; error: string }> {
  if (!settings.enabled) return { ok: false, error: "Turn on Sign in with ChatGPT under Admin → Settings first." };
  try {
    const rejection = accountRejection(await getChatGPTAuth(userId, { fetch: baseFetch }), settings);
    if (rejection) return { ok: false, error: rejection };
    const models = await listChatGPTModels(userId, baseFetch);
    return { ok: true, models: models.map((m) => m.slug), note: "Models offered by your own ChatGPT plan" };
  } catch (err) {
    if (err instanceof ChatGPTNotConnectedError) {
      return { ok: false, error: "Connect your own ChatGPT account (Settings → Connected accounts) to list the models plans offer." };
    }
    if (isUserFacingError(err)) return { ok: false, error: err.message };
    return { ok: false, error: describeProviderError(err) };
  }
}
