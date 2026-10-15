import { APICallError, RetryError } from "ai";
import { newId } from "@/lib/ids";
import { ChatGPTError } from "./chatgpt/errors";
import { ProviderConfigError, ProviderUnavailableError } from "./errors";
import { DelegationAuthorityChangedError } from "@/lib/delegation/authority";
import { HermesError } from "./providers/hermes/client";

/** Native stream errors never expose provider bodies, arbitrary messages, tool errors or internal addresses. */
export function nativeErrorText(err: unknown, trustedMessage?: string): string {
  const error = RetryError.isInstance(err) ? err.lastError : err;
  if (trustedMessage) return trustedMessage;
  if (error instanceof ChatGPTError || error instanceof ProviderConfigError || error instanceof ProviderUnavailableError || error instanceof DelegationAuthorityChangedError) return error.message;
  // Preserve the existing Hermes guidance without forwarding optional upstream detail.
  if (error instanceof HermesError) return new HermesError(error.code, error.status).message;
  const reference = newId();
  // Do not log raw errors, including message/stack/cause: pattern redaction cannot recognize arbitrary private data.
  const status = APICallError.isInstance(error) && Number.isInteger(error.statusCode) && error.statusCode! >= 100 && error.statusCode! <= 599
    ? error.statusCode : undefined;
  console.error("[native] request failed", { reference, kind: APICallError.isInstance(error) ? "provider" : "unexpected", ...(status ? { status } : {}) });
  return `Something went wrong. Try again. Reference: ${reference}.`;
}
