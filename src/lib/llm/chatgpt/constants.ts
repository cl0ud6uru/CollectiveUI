/**
 * "Sign in with ChatGPT" endpoints and identity. The portal signs people in with the device-code flow of OpenAI's
 * public Codex client (the same flow Codex CLI, Hermes and OpenCode use) and then calls the Codex backend with the
 * person's own token. It identifies itself honestly (its own originator and User-Agent), never as Codex CLI.
 */

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const AUTH_BASE_URL = "https://auth.openai.com";
const BACKEND_BASE_URL = "https://chatgpt.com/backend-api";

/** Registered redirect for device-code logins; the token endpoint checks it even when a mock serves the flow. */
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

/** Device codes expire after 15 minutes upstream. */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;

export const ORIGINATOR = "ai_portal";
export const USER_AGENT = "AIPortal/1.0 (+Sign in with ChatGPT)";

/** Sent to the models endpoint, which may filter models by client version. */
export const CLIENT_VERSION = process.env.CHATGPT_CLIENT_VERSION?.trim() || "0.156.1";

/** Refresh when the access token has less than this left. */
export const REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * Endpoint overrides exist only so tests and the dev mock can stand in for OpenAI. They are ignored in production:
 * pointing them elsewhere would send people's ChatGPT tokens to another server.
 */
function override(name: "CHATGPT_AUTH_BASE_URL" | "CHATGPT_BACKEND_URL"): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return process.env[name]?.trim().replace(/\/+$/, "") || undefined;
}

export const chatgptAuthBaseUrl = () => override("CHATGPT_AUTH_BASE_URL") ?? AUTH_BASE_URL;
export const chatgptBackendUrl = () => override("CHATGPT_BACKEND_URL") ?? BACKEND_BASE_URL;
/** What people open to enter their code. */
export const deviceVerificationUrl = () => `${chatgptAuthBaseUrl()}/codex/device`;
