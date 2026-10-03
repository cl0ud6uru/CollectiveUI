import { APICallError, RetryError } from "ai";
import { HttpError } from "@/lib/authz";
import { redactSecrets } from "@/lib/redact";

/** An app's provider settings or credentials are missing or invalid. Details go to the server log only. */
export class ProviderConfigError extends HttpError {
  /** The message is generic and safe to show; `detail` stays in the server log. */
  readonly userFacing = true;
  constructor(
    appName: string,
    public detail: string,
  ) {
    super(503, `${appName} is not configured correctly. Ask an admin to check it.`);
    this.name = "ProviderConfigError";
  }
}

/** The app can't be used for this purpose (e.g. a reserved provider kind, or user credentials for background work). */
export class ProviderUnavailableError extends HttpError {
  /** Written for the person (e.g. "Personal ChatGPT plans aren't allowed here…"). */
  readonly userFacing = true;
  constructor(message: string) {
    super(409, message);
    this.name = "ProviderUnavailableError";
  }
}

/** Friendly text for common HTTP failures from model endpoints. */
export function describeHttpStatus(status: number): string | undefined {
  if (status === 401 || status === 403) return `Authentication failed (${status}). Check the credentials.`;
  if (status === 404) return "Not found (404). Check the endpoint and the model or deployment name.";
  if (status === 429) return "Rate limited or out of quota (429).";
  return undefined;
}

/**
 * Turns a provider failure into a short, safe message for admins (Test connection). Never includes request
 * bodies, headers or raw response bodies; always redacted and truncated.
 */
export function describeProviderError(err: unknown): string {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  let msg: string;
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    if (status == null) msg = /Cannot connect/i.test(e.message) ? "Can't reach the endpoint. Check the URL and network access." : e.message;
    else msg = describeHttpStatus(status) ?? `${status}: ${e.message}`;
  } else if (e instanceof TypeError && /fetch failed|redirect/i.test(e.message)) {
    msg = "Can't reach the endpoint (or it redirected). Check the URL and network access.";
  } else if (e instanceof ProviderConfigError) {
    msg = e.detail;
  } else {
    msg = e instanceof Error ? e.message : String(e);
  }
  return redactSecrets(msg).slice(0, 300);
}
