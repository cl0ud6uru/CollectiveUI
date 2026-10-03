"use client";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@collective/webauthn-browser";
export type SecurityResult = {
  recoveryRotated?: boolean; mustChangePassword?: boolean; ticket?: string; flow?: string; proof?: string; codes?: string[]; signOut?: boolean; secret?: string; uri?: string;
  options?: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
};
export async function securityPost(path: string, body: Record<string, unknown>): Promise<SecurityResult> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Unable to verify. Start again.");
  return result;
}
