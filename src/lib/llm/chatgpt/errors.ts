import { APICallError, RetryError } from "ai";
import { HttpError } from "@/lib/authz";
import { McpToolError } from "@/lib/mcp/errors";

/**
 * Failures a person can act on (connect, reconnect, wait for their limit). They are thrown from model resolution and
 * from inside the model fetch, so the SDK neither retries them nor wraps them, and the chat shows the message as is.
 */
export class ChatGPTError extends HttpError {
  readonly userFacing = true;
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "ChatGPTError";
  }
}

export const isUserFacingError = (err: unknown): err is HttpError & { userFacing: true } =>
  err instanceof HttpError && (err as { userFacing?: boolean }).userFacing === true;

export class ChatGPTNotConnectedError extends ChatGPTError {
  constructor() {
    super(409, "Connect your ChatGPT account in Settings → Connected accounts to use this model.");
    this.name = "ChatGPTNotConnectedError";
  }
}

export class ChatGPTReauthRequiredError extends ChatGPTError {
  constructor(message = "Your ChatGPT sign-in has expired. Reconnect it in Settings → Connected accounts.") {
    super(409, message);
    this.name = "ChatGPTReauthRequiredError";
  }
}

export class ChatGPTUsageLimitError extends ChatGPTError {
  constructor(public resetsAt: Date | null) {
    super(
      429,
      `You've reached your ChatGPT plan's usage limit${resetsAt ? `; it resets ${resetsAt.toISOString().replace("T", " ").slice(0, 16)} UTC` : ""}. Switch to a company model to keep going.`,
    );
    this.name = "ChatGPTUsageLimitError";
  }
}

export class ChatGPTPlanError extends ChatGPTError {
  constructor() {
    super(403, "Your ChatGPT plan doesn't include Codex, which this model needs. Switch to a company model.");
    this.name = "ChatGPTPlanError";
  }
}

/** Sign-in service trouble (429/5xx/network while refreshing). The connection stays as it is. */
export class ChatGPTUnavailableError extends ChatGPTError {
  constructor() {
    super(503, "ChatGPT sign-in is temporarily unavailable. Try again in a minute.");
    this.name = "ChatGPTUnavailableError";
  }
}

/**
 * The message to show for an error people can act on or a sanitized MCP invocation failure,
 * or undefined for anything else (which stays generic). Looks
 * through the SDK's RetryError: a typed error that happens on a retry attempt arrives wrapped.
 */
export function userFacingMessage(err: unknown): string | undefined {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  return isUserFacingError(e) || e instanceof McpToolError ? e.message : undefined;
}

/** Error codes/types anywhere in a provider error (stream frames, API bodies, causes), plus a reset time if given. */
function errorFacts(err: unknown): { codes: string[]; resetsAt?: number } {
  const codes: string[] = [];
  let resetsAt: number | undefined;
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 5) return;
    const o = v as Record<string, unknown>;
    for (const k of ["code", "type"]) if (typeof o[k] === "string") codes.push(o[k] as string);
    if (typeof o.resets_at === "number") resetsAt = o.resets_at;
    // `value`: a frame that failed the SDK's schema check arrives as a TypeValidationError holding it.
    for (const k of ["error", "response", "data", "cause", "lastError", "value"]) visit(o[k], depth + 1);
  };
  visit(err, 0);
  if (APICallError.isInstance(err) && err.responseBody) {
    try {
      visit(JSON.parse(err.responseBody), 1);
    } catch {
      // not JSON
    }
  }
  return { codes, resetsAt };
}

/**
 * Plan errors the backend reports inside the stream (response.failed / error frames) rather than as HTTP 429. The
 * SDK turns those into retryable APICallErrors; mapping them keeps them unretried and readable.
 */
export function chatgptPlanErrorFrom(err: unknown): ChatGPTError | undefined {
  if (isUserFacingError(err)) return undefined;
  const { codes, resetsAt } = errorFacts(err);
  if (codes.includes("usage_not_included")) return new ChatGPTPlanError();
  if (codes.includes("usage_limit_reached")) return new ChatGPTUsageLimitError(resetsAt ? new Date(resetsAt * 1000) : null);
  return undefined;
}
