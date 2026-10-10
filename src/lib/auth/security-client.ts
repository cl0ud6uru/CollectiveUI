"use client";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@collective/webauthn-browser";
export type SecurityResult = {
  recoveryRotated?: boolean; mustChangePassword?: boolean; ticket?: string; flow?: string; proof?: string; codes?: string[]; signOut?: boolean; secret?: string; uri?: string;
  options?: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
};
export function securityErrorMessage(error: unknown, fallback: string) {
  return error && typeof error === "object" && "code" in error && error.code === "directory_unavailable"
    ? "Can't reach the company directory right now. Try again in a few minutes, or contact IT if this continues."
    : fallback;
}
export async function securityPost(path: string, body: Record<string, unknown>): Promise<SecurityResult> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(securityErrorMessage(result, result.error ?? "Unable to verify. Start again.")), { code: typeof result.code === "string" ? result.code : undefined });
  return result;
}
