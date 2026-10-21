import { APICallError, RetryError } from "ai";
import { newId } from "@/lib/ids";
import { ChatGPTError } from "./chatgpt/errors";
import { ProviderConfigError, ProviderUnavailableError } from "./errors";
import { DelegationAuthorityChangedError } from "@/lib/delegation/authority";
import { DelegationBudgetError } from "@/lib/delegation/errors";
import { SandboxError, sandboxErrorGuidance } from "@/lib/sandbox/client";
import { HermesError } from "./providers/hermes/client";
import { NativeRunBudgetError } from "./run-budget-policy";

/** Native stream errors never expose provider bodies, arbitrary messages, tool errors or internal addresses. */
export function nativeErrorText(err: unknown, trustedMessage?: string): string {
  const error = RetryError.isInstance(err) ? err.lastError : err;
  if (trustedMessage) return trustedMessage;
  if (error instanceof ChatGPTError || error instanceof ProviderConfigError || error instanceof ProviderUnavailableError || error instanceof DelegationAuthorityChangedError || error instanceof DelegationBudgetError || error instanceof NativeRunBudgetError) return error.message;
  // Preserve the existing Hermes guidance without forwarding optional upstream detail.
  if (error instanceof HermesError) return new HermesError(error.code, error.status).message;
  if (error instanceof SandboxError) {
    const messages: Record<string, string> = { outside_workspace: "That path is outside the workspace.", not_found: "That workspace file was not found.",
      too_large: "The workspace operation exceeds its size limit.", bad_request: "The workspace request is invalid. Check the arguments and try again." };
    const safe = sandboxErrorGuidance(error.code) ?? (Object.hasOwn(messages, error.code) ? messages[error.code] : undefined);
    if (safe) return safe;
  }
  const reference = newId();
  // Do not log raw errors, including message/stack/cause: pattern redaction cannot recognize arbitrary private data.
  const status = APICallError.isInstance(error) && Number.isInteger(error.statusCode) && error.statusCode! >= 100 && error.statusCode! <= 599
    ? error.statusCode : undefined;
  console.error("[native] request failed", { reference, kind: APICallError.isInstance(error) ? "provider" : "unexpected", ...(status ? { status } : {}) });
  return `Something went wrong. Try again. Reference: ${reference}.`;
}
